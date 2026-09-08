import type { TradeUpdate } from './pump.js';

/** One trade, kept only long enough to answer questions about the recent past. */
interface Tick {
  at: number;
  /** Quote reserves after the trade, so a price change can be derived. */
  vq: bigint;
  vt: bigint;
}

/**
 * How many different people are buying a token, and how fast that is changing.
 *
 * The trade stream already carries the buyer's wallet on every event, and nothing in
 * this bot has used it for selection. That is a gap worth closing, because the count
 * of trades is a much weaker signal than the count of buyers: twenty buys from three
 * wallets is one bot cycling, and twenty buys from twenty wallets is a crowd. Only the
 * second is what "in" means.
 *
 * It is also the only attention signal available at the moment a token is worth
 * deciding about. pump.fun's own comment count is the obvious alternative and it is
 * empty when it matters — measured across fresh launches, every token under five
 * minutes old had zero replies, because the conversation starts later than the trade
 * does. Buyers show up immediately.
 */
export interface AttentionStats {
  uniqueBuyers: number;
  uniqueSellers: number;
  buys: number;
  sells: number;
  /** Distinct buyers per minute since the token launched. */
  buyersPerMinute: number;
  /** Buy share of all trades; below a half the token is being sold into. */
  buyRatio: number;
  /** SOL that has gone in, minus what has come out. */
  netSolFlow: number;
  /** Largest single buy in SOL — one whale is not a crowd. */
  largestBuySol: number;
  /** Share of buy volume from the single biggest buyer, 0-1. */
  topBuyerShare: number;
  ageSeconds: number;
}

/** What the crowd has been doing over a recent window, rather than since launch. */
export interface CrowdWindow {
  /** Trades per second over the window. */
  tradeRate: number;
  /** Price change across the window in percent, as a holder would have seen it. */
  runUpPct: number;
  /** Trades the window is based on; below a handful the rate means little. */
  trades: number;
}

/** Ticks older than this cannot inform any window the bot asks about. */
const TICK_RETENTION_MS = 120_000;

interface Tracked {
  bornAt: number;
  ticks: Tick[];
  buyers: Map<string, number>;
  sellers: Set<string>;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  largestBuySol: number;
}

export class AttentionTracker {
  private tracked = new Map<string, Tracked>();

  constructor(private readonly retentionSeconds = 900) {}

  /** Called for every launch, so counting starts from the first trade. */
  register(mint: string, at = Date.now()) {
    if (this.tracked.has(mint)) return;
    this.tracked.set(mint, {
      bornAt: at,
      ticks: [],
      buyers: new Map(),
      sellers: new Set(),
      buys: 0,
      sells: 0,
      solIn: 0,
      solOut: 0,
      largestBuySol: 0,
    });
  }

  onTrade(trade: TradeUpdate) {
    const entry = this.tracked.get(trade.mint.toBase58());
    if (!entry) return;
    const sol = Number(trade.solAmount) / 1e9;
    const wallet = trade.user.toBase58();

    const now = Date.now();
    entry.ticks.push({ at: now, vq: trade.virtualQuoteReserves, vt: trade.virtualTokenReserves });
    // Trimmed from the front; a busy token would otherwise keep every trade of its life.
    const cutoff = now - TICK_RETENTION_MS;
    while (entry.ticks.length > 0 && entry.ticks[0].at < cutoff) entry.ticks.shift();

    if (trade.isBuy) {
      entry.buys++;
      entry.solIn += sol;
      entry.buyers.set(wallet, (entry.buyers.get(wallet) ?? 0) + sol);
      entry.largestBuySol = Math.max(entry.largestBuySol, sol);
    } else {
      entry.sells++;
      entry.solOut += sol;
      entry.sellers.add(wallet);
    }
  }

  stats(mint: string, at = Date.now()): AttentionStats | null {
    const entry = this.tracked.get(mint);
    if (!entry) return null;
    const ageSeconds = Math.max(1, (at - entry.bornAt) / 1000);
    const trades = entry.buys + entry.sells;
    const topBuyerSol = Math.max(0, ...entry.buyers.values());

    return {
      uniqueBuyers: entry.buyers.size,
      uniqueSellers: entry.sellers.size,
      buys: entry.buys,
      sells: entry.sells,
      buyersPerMinute: entry.buyers.size / (ageSeconds / 60),
      buyRatio: trades > 0 ? entry.buys / trades : 0,
      netSolFlow: entry.solIn - entry.solOut,
      largestBuySol: entry.largestBuySol,
      topBuyerShare: entry.solIn > 0 ? topBuyerSol / entry.solIn : 0,
      ageSeconds,
    };
  }

  /**
   * How fast the crowd is arriving, and whether the price has already moved.
   *
   * These two answer different halves of the same question and measured in opposite
   * directions: heavy trading predicted good outcomes, an existing run-up predicted
   * bad ones. The reading is that the crowd visible in the price is the exit rather
   * than the entry — what pays is buying while people are still arriving and the
   * price has not caught up.
   *
   * Null when the window holds too few trades to say anything, so a caller that fails
   * closed can tell "quiet" from "not yet known".
   */
  crowd(mint: string, windowSeconds: number, at = Date.now()): CrowdWindow | null {
    const entry = this.tracked.get(mint);
    if (!entry) return null;
    const from = at - windowSeconds * 1000;
    const window = entry.ticks.filter((t) => t.at >= from);
    if (window.length < 4) return null;

    const first = window[0];
    const last = window[window.length - 1];
    // Value of a fixed holding at each end — the same constant-product price the
    // entry and the exit use, so the number means the same thing everywhere.
    const unit = 10n ** 6n;
    const priceAt = (tick: Tick) =>
      tick.vt + unit > 0n ? Number((unit * tick.vq) / (tick.vt + unit)) : 0;
    const before = priceAt(first);
    const after = priceAt(last);

    return {
      tradeRate: window.length / windowSeconds,
      runUpPct: before > 0 ? ((after - before) / before) * 100 : 0,
      trades: window.length,
    };
  }

  /** Bounded: launches arrive all day and most stop mattering within minutes. */
  sweep(at = Date.now()) {
    const cutoff = at - this.retentionSeconds * 1000;
    for (const [mint, entry] of this.tracked) {
      if (entry.bornAt < cutoff) this.tracked.delete(mint);
    }
  }

  get size(): number {
    return this.tracked.size;
  }
}
