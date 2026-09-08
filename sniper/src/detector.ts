import type { RpcEndpoint } from './config.js';
import { LogStream, decodeLogEvents } from './logstream.js';
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
  private readonly stream: LogStream;
  private seenCreates = new Set<string>();

  readonly counters = { creates: 0, trades: 0, undecodable: 0 };

  constructor(
    endpoints: RpcEndpoint[],
    private readonly onToken: (token: DetectedToken) => void,
    private readonly onTrade: (trade: TradeUpdate) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.stream = new LogStream(
      endpoints,
      PUMP_PROGRAM,
      STALE_STREAM_MS,
      (lines, signature) => this.handleBatch(lines, signature),
      onError,
    );
  }

  get endpoint(): string {
    return this.stream.endpoint;
  }

  /** Everything depends on this stream, so its health is worth reporting. */
  health() {
    return { ...this.stream.health(), ...this.counters };
  }

  start() {
    this.stream.start();
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

    for (const data of decodeLogEvents(lines)) {
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
    await this.stream.stop();
  }
}
