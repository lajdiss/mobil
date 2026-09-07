import { Connection } from '@solana/web3.js';
import type { RpcEndpoint } from './config.js';
import {
  CREATE_EVENT_DISCRIMINATOR,
  PUMP_PROGRAM,
  TRADE_EVENT_DISCRIMINATOR,
  decodeCreateEvent,
  decodeTradeEventPrefix,
  type CreateEvent,
  type TradeUpdate,
} from './pump.js';

export interface DetectedToken extends CreateEvent {
  signature: string;
  detectedAt: number;
  /** Share of total supply the creator bought inside the launch transaction. */
  devBuyPct: number;
  devBuySol: number;
}

const LOG_DATA_PREFIX = 'Program data: ';

/**
 * pump.fun produces well over ten events a second around the clock, so this much
 * silence means the stream is dead rather than quiet.
 */
const STALE_STREAM_MS = 30_000;

/**
 * Single log subscription that carries everything the bot needs.
 *
 * pump.fun emits its events both as an inner instruction (emit_cpi) and as a
 * "Program data:" log line, so both CreateEvent and TradeEvent can be decoded straight
 * out of the log stream. That removes the getTransaction round trip the entry path used
 * to depend on — which cost hundreds of milliseconds and silently dropped every launch
 * whose transaction was not confirmed yet.
 *
 * TradeEvents arrive for every token, roughly 25 a second, and carry the reserves. They
 * price open positions faster than a per-account subscription can, from one stream.
 */
export class Detector {
  private connection: Connection;
  private endpointIndex = 0;
  private subscriptionId: number | null = null;
  private seenCreates = new Set<string>();
  private watchdog: NodeJS.Timeout | null = null;
  private lastEventAt = 0;
  private resubscribes = 0;
  private failuresOnEndpoint = 0;

  readonly counters = { creates: 0, trades: 0, undecodable: 0 };

  constructor(
    private readonly endpoints: RpcEndpoint[],
    private readonly onToken: (token: DetectedToken) => void,
    private readonly onTrade: (trade: TradeUpdate) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.connection = this.buildConnection();
  }

  private readonly connections = new Map<number, Connection>();

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

  /** Everything depends on this stream, so its health is worth reporting. */
  health() {
    const silentMs = this.lastEventAt ? Date.now() - this.lastEventAt : null;
    return {
      alive: silentMs !== null && silentMs < STALE_STREAM_MS,
      silentMs,
      resubscribes: this.resubscribes,
      endpoint: this.endpoint,
      ...this.counters,
    };
  }

  start() {
    this.subscribe();
    // A subscription that never establishes, or one that dies later, leaves the bot
    // blind with nothing in the logs to say so. Silence is the only symptom, so it
    // has to be the trigger.
    this.watchdog = setInterval(() => {
      if (this.lastEventAt === 0) {
        void this.resubscribe('stream never delivered');
        return;
      }
      const silentMs = Date.now() - this.lastEventAt;
      if (silentMs > STALE_STREAM_MS) {
        void this.resubscribe(`no events for ${Math.round(silentMs / 1000)}s`);
        return;
      }
      // Only a stream that is actually delivering clears the endpoint's failure count.
      this.failuresOnEndpoint = 0;
    }, STALE_STREAM_MS);
  }

  private subscribe() {
    this.subscriptionId = this.connection.onLogs(
      PUMP_PROGRAM,
      (logs) => {
        this.lastEventAt = Date.now();
        if (logs.err) return;
        this.handleBatch(logs.logs, logs.signature);
      },
      'processed',
    );
  }

  /**
   * A public RPC can answer HTTP perfectly while its WebSocket delivers nothing, and
   * resubscribing on that same connection just fails again — measured here, ten times
   * in a row while the bot sat blind. So after two failures the endpoint itself is
   * treated as the problem and the stream moves to the next one.
   */
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
      this.onError(`stream dead on the previous endpoint (${reason}) — switching to ${this.endpoint}`);
    } else {
      this.onError(`event stream looks dead (${reason}) — resubscribing to ${this.endpoint}`);
    }

    this.lastEventAt = 0;
    this.subscribe();
  }

  /**
   * Handled a batch at a time rather than line by line, because a launch and the
   * creator's own buy of it land in the same transaction. Pairing them here reveals how
   * much of the supply the dev took at launch — the clearest rug signal available, and
   * it costs nothing: the data is already in the logs.
   */
  private handleBatch(lines: string[], signature: string) {
    let create: CreateEvent | null = null;
    const trades: TradeUpdate[] = [];

    for (const line of lines) {
      if (!line.startsWith(LOG_DATA_PREFIX)) continue;
      let data: Buffer;
      try {
        data = Buffer.from(line.slice(LOG_DATA_PREFIX.length), 'base64');
      } catch {
        this.counters.undecodable++;
        continue;
      }
      if (data.length < 8) continue;
      const discriminator = data.subarray(0, 8);

      try {
        if (discriminator.equals(TRADE_EVENT_DISCRIMINATOR)) {
          const trade = decodeTradeEventPrefix(data);
          if (trade) {
            this.counters.trades++;
            trades.push(trade);
            this.onTrade(trade);
          }
        } else if (discriminator.equals(CREATE_EVENT_DISCRIMINATOR)) {
          create = decodeCreateEvent(data);
        }
      } catch (err) {
        this.counters.undecodable++;
        this.onError(`could not decode a pump.fun event: ${(err as Error).message}`);
      }
    }

    if (!create) return;
    // The same launch can appear on more than one notification; only act once.
    if (this.seenCreates.has(signature)) return;
    this.seenCreates.add(signature);
    if (this.seenCreates.size > 5000) this.seenCreates.clear();
    this.counters.creates++;

    const devBuy = trades.find(
      (t) => t.isBuy && t.mint.equals(create.mint) && t.user.equals(create.user),
    );
    const supply = create.tokenTotalSupply;
    this.onToken({
      ...create,
      signature,
      detectedAt: Date.now(),
      devBuyPct:
        devBuy && supply > 0n ? Number((devBuy.tokenAmount * 10_000n) / supply) / 100 : 0,
      devBuySol: devBuy ? Number(devBuy.solAmount) / 1e9 : 0,
    });
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
