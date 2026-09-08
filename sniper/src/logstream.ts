import { Connection, PublicKey } from '@solana/web3.js';
import type { RpcEndpoint } from './config.js';

export const LOG_DATA_PREFIX = 'Program data: ';

/**
 * A program log subscription that notices when it has died.
 *
 * A public RPC can answer HTTP perfectly while its WebSocket silently delivers
 * nothing, and resubscribing on that same connection just fails again — measured on
 * mainnet, ten times in a row while the bot sat blind. Silence is the only symptom
 * there is, so silence has to be the trigger, and after two failures the endpoint
 * itself is treated as the problem.
 */
export class LogStream {
  private connection: Connection;
  private endpointIndex = 0;
  private subscriptionId: number | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastEventAt = 0;
  private resubscribes = 0;
  private failuresOnEndpoint = 0;
  private readonly connections = new Map<number, Connection>();

  constructor(
    private readonly endpoints: RpcEndpoint[],
    private readonly programId: PublicKey,
    /** How long a quiet stream is allowed to stay quiet before it counts as dead. */
    private readonly staleMs: number,
    private readonly onBatch: (lines: string[], signature: string) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.connection = this.buildConnection();
  }

  /**
   * Reused rather than rebuilt. A dropped web3.js Connection keeps retrying its socket
   * forever with no public way to close it, so making a new one per failover would leak
   * a reconnect loop each time. Cycling a fixed set bounds that to one per endpoint.
   */
  private buildConnection() {
    const cached = this.connections.get(this.endpointIndex);
    if (cached) return cached;
    const endpoint = this.endpoints[this.endpointIndex];
    const connection = new Connection(endpoint.http, {
      commitment: 'confirmed',
      wsEndpoint: endpoint.ws,
    });
    this.connections.set(this.endpointIndex, connection);
    return connection;
  }

  get endpoint(): string {
    return this.endpoints[this.endpointIndex].http;
  }

  health() {
    const silentMs = this.lastEventAt ? Date.now() - this.lastEventAt : null;
    return {
      alive: silentMs !== null && silentMs < this.staleMs,
      silentMs,
      resubscribes: this.resubscribes,
      endpoint: this.endpoint,
    };
  }

  start() {
    this.subscribe();
    this.watchdog = setInterval(() => {
      if (this.lastEventAt === 0) {
        void this.resubscribe('stream never delivered');
        return;
      }
      const silentMs = Date.now() - this.lastEventAt;
      if (silentMs > this.staleMs) {
        void this.resubscribe(`no events for ${Math.round(silentMs / 1000)}s`);
        return;
      }
      // Only a stream that is actually delivering clears the endpoint's failure count.
      this.failuresOnEndpoint = 0;
    }, this.staleMs);
  }

  private subscribe() {
    this.subscriptionId = this.connection.onLogs(
      this.programId,
      (logs) => {
        this.lastEventAt = Date.now();
        if (logs.err) return;
        this.onBatch(logs.logs, logs.signature);
      },
      'processed',
    );
  }

  private async resubscribe(reason: string) {
    this.resubscribes++;
    this.failuresOnEndpoint++;

    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId).catch(() => {});
      this.subscriptionId = null;
    }

    if (this.failuresOnEndpoint >= 2 && this.endpoints.length > 1) {
      this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
      this.failuresOnEndpoint = 0;
      this.connection = this.buildConnection();
      this.onError(
        `stream dead on the previous endpoint (${reason}) — switching to ${this.endpoint}`,
      );
    } else {
      this.onError(`event stream looks dead (${reason}) — resubscribing to ${this.endpoint}`);
    }

    this.lastEventAt = 0;
    this.subscribe();
  }

  async stop() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }
  }
}

/** Anchor writes its events as base64 on a "Program data:" line. */
export function decodeLogEvents(lines: string[]): Buffer[] {
  const events: Buffer[] = [];
  for (const line of lines) {
    if (!line.startsWith(LOG_DATA_PREFIX)) continue;
    try {
      const data = Buffer.from(line.slice(LOG_DATA_PREFIX.length), 'base64');
      if (data.length >= 8) events.push(data);
    } catch {
      // A malformed line is not worth failing the batch over.
    }
  }
  return events;
}
