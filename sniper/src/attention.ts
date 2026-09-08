import type { TradeUpdate } from './pump.js';

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

interface Tracked {
  bornAt: number;
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
