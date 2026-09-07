import { Connection } from '@solana/web3.js';
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
  private subscriptionId: number | null = null;
  private seenCreates = new Set<string>();
  private watchdog: NodeJS.Timeout | null = null;
  private lastEventAt = 0;
  private resubscribes = 0;

  readonly counters = { creates: 0, trades: 0, undecodable: 0 };

  constructor(
    private readonly connection: Connection,
    private readonly onToken: (token: DetectedToken) => void,
    private readonly onTrade: (trade: TradeUpdate) => void,
    private readonly onError: (message: string) => void,
  ) {}

  /** Everything depends on this stream, so its health is worth reporting. */
  health() {
    const silentMs = this.lastEventAt ? Date.now() - this.lastEventAt : null;
    return {
      alive: silentMs !== null && silentMs < STALE_STREAM_MS,
      silentMs,
      resubscribes: this.resubscribes,
      ...this.counters,
    };
  }

  start() {
    this.subscribe();
    // A subscription that never establishes, or one that dies later, leaves the bot
    // blind with nothing in the logs to say so. Silence is the only symptom, so it
    // has to be the trigger.
    this.watchdog = setInterval(() => {
      if (this.lastEventAt === 0) return void this.resubscribe('stream never delivered');
      if (Date.now() - this.lastEventAt > STALE_STREAM_MS) {
        void this.resubscribe(`no events for ${Math.round((Date.now() - this.lastEventAt) / 1000)}s`);
      }
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

  private async resubscribe(reason: string) {
    this.resubscribes++;
    this.onError(`event stream looks dead (${reason}) — resubscribing`);
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId).catch(() => {});
      this.subscriptionId = null;
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
