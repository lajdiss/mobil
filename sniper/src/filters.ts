import type { Config } from './config.js';
import type { DetectedToken } from './detector.js';
import { WSOL_MINT } from './pumpswap.js';

export interface FilterVerdict {
  passed: boolean;
  reason?: string;
}

/**
 * Tracks how often each creator launches. A wallet spraying launches is the single
 * clearest serial-rugger signal available without an indexer.
 */
export class CreatorHistory {
  private launches = new Map<string, number[]>();

  record(creator: string, at = Date.now()) {
    const list = this.launches.get(creator) || [];
    list.push(at);
    this.launches.set(creator, list);
  }

  countLastHour(creator: string, now = Date.now()): number {
    const cutoff = now - 3_600_000;
    const list = (this.launches.get(creator) || []).filter((t) => t >= cutoff);
    this.launches.set(creator, list);
    return list.length;
  }
}

export function evaluate(
  token: DetectedToken,
  config: Config,
  history: CreatorHistory,
): FilterVerdict {
  const name = token.name.toLowerCase();
  const symbol = token.symbol.toLowerCase();

  for (const pattern of config.blockedNamePatterns) {
    if (name.includes(pattern) || symbol.includes(pattern)) {
      return { passed: false, reason: `blocked pattern "${pattern}"` };
    }
  }

  if (config.requireSocials && !token.uri) {
    return { passed: false, reason: 'no metadata uri' };
  }

  const recentLaunches = history.countLastHour(token.creator.toBase58());
  if (recentLaunches > config.maxCreatorLaunchesPerHour) {
    return {
      passed: false,
      reason: `creator launched ${recentLaunches} tokens in the last hour`,
    };
  }

  if (config.maxDevBuyPct > 0 && token.devBuyPct > config.maxDevBuyPct) {
    return {
      passed: false,
      reason: `dev bought ${token.devBuyPct.toFixed(1)}% of supply at launch`,
    };
  }

  if (token.isMayhemMode) {
    return { passed: false, reason: 'mayhem mode token' };
  }

  // pump.fun allows curves quoted in something other than SOL. Every price in this
  // bot — the entry quote, the stop-loss, the exit — divides by the quote reserves,
  // and for those tokens the SOL-denominated reserves are zero. Found in recorded
  // data: one launch produced a NaN profit rather than an error, which is the worst
  // possible failure because nothing raises. Reject rather than mispricing them.
  if (!token.quoteMint.equals(WSOL_MINT)) {
    return { passed: false, reason: 'curve is not quoted in SOL' };
  }
  const quoteReserves = token.virtualQuoteReserves || token.virtualSolReserves;
  if (quoteReserves <= 0n) {
    return { passed: false, reason: 'curve reports no quote reserves' };
  }

  // Selling a cashback coin fails with InvalidCashbackAccumulator (6073) — the sell
  // wants an accumulator account the plain instruction does not carry. Buying one
  // would mean a position stop-loss cannot exit, so skip them entirely.
  if (token.isCashbackEnabled) {
    return { passed: false, reason: 'cashback token (cannot be sold by this bot)' };
  }

  return { passed: true };
}
