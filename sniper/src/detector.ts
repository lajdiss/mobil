import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  ANCHOR_CPI_EVENT_PREFIX,
  CREATE_EVENT_DISCRIMINATOR,
  PUMP_PROGRAM,
  decodeCreateEvent,
  type CreateEvent,
} from './pump.js';

export interface DetectedToken extends CreateEvent {
  signature: string;
  detectedAt: number;
  latencyMs: number;
}

/**
 * Watches for new pump.fun launches.
 *
 * The program emits CreateEvent via `emit_cpi!`, so the payload lives in an inner
 * instruction rather than a "Program data:" log line. logsSubscribe only gives us
 * logs, so we use it as a trigger and then fetch the transaction to read the event.
 * That round trip is why a public RPC lands you several slots behind.
 */
export class Detector {
  private subscriptionId: number | null = null;
  private seen = new Set<string>();

  constructor(
    private readonly connection: Connection,
    private readonly onToken: (token: DetectedToken) => void,
    private readonly onError: (message: string) => void,
  ) {}

  start() {
    this.subscriptionId = this.connection.onLogs(
      PUMP_PROGRAM,
      (logs) => {
        if (logs.err) return;
        if (!logs.logs.some((l) => l.includes('Instruction: Create'))) return;
        if (this.seen.has(logs.signature)) return;
        this.seen.add(logs.signature);
        if (this.seen.size > 5000) this.seen.clear();
        this.counters.noticed++;
        void this.hydrate(logs.signature, Date.now());
      },
      'processed',
    );
  }

  /** Launches seen in the logs, and those we failed to read the details for. */
  readonly counters = { noticed: 0, hydrated: 0, dropped: 0 };

  private async hydrate(signature: string, noticedAt: number) {
    try {
      // logsSubscribe fires at processed, but the transaction is only fetchable once
      // confirmed. Without retrying, every launch we hear about too early is dropped.
      let tx = null;
      for (let attempt = 0; attempt < 5 && !tx; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
        tx = await this.connection
          .getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
          .catch(() => null);
      }
      if (!tx?.meta) {
        this.counters.dropped++;
        return;
      }

      const keys = tx.transaction.message.getAccountKeys({
        accountKeysFromLookups: tx.meta.loadedAddresses,
      });

      for (const inner of tx.meta.innerInstructions || []) {
        for (const ix of inner.instructions) {
          if (!keys.get(ix.programIdIndex)?.equals(PUMP_PROGRAM)) continue;
          const data = Buffer.from(bs58.decode(ix.data));
          if (!data.subarray(0, 8).equals(ANCHOR_CPI_EVENT_PREFIX)) continue;
          const payload = data.subarray(8);
          if (!payload.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)) continue;

          const event = decodeCreateEvent(payload);
          this.counters.hydrated++;
          this.onToken({
            ...event,
            signature,
            detectedAt: noticedAt,
            latencyMs: Date.now() - noticedAt,
          });
          return;
        }
      }
      // Reached only when no CreateEvent was found in the transaction.
      this.counters.dropped++;
    } catch (err) {
      this.counters.dropped++;
      this.onError(`failed to read create tx ${signature.slice(0, 8)}: ${(err as Error).message}`);
    }
  }

  async stop() {
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }
  }
}

export interface CurveWatch {
  mint: PublicKey;
  onUpdate: (data: Buffer) => void;
}

/** Push-based price updates for open positions; cheaper than polling on a free RPC. */
export class CurveWatcher {
  private subscriptions = new Map<string, number>();

  constructor(private readonly connection: Connection) {}

  watch(curveAddress: PublicKey, onUpdate: (data: Buffer) => void) {
    const key = curveAddress.toBase58();
    if (this.subscriptions.has(key)) return;
    const id = this.connection.onAccountChange(
      curveAddress,
      (info) => onUpdate(info.data),
      'processed',
    );
    this.subscriptions.set(key, id);
  }

  async unwatch(curveAddress: PublicKey) {
    const key = curveAddress.toBase58();
    const id = this.subscriptions.get(key);
    if (id === undefined) return;
    await this.connection.removeAccountChangeListener(id);
    this.subscriptions.delete(key);
  }
}
