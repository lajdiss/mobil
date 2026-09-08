import type { Config } from './config.js';
import type { DetectedToken } from './detector.js';
import { PublicKey } from '@solana/web3.js';
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

  // Mayhem mode is NOT rejected, though it was for most of this bot's life. The flag
  // was treated as unsupported without ever being tested, and it was throwing away 38%
  // of every launch on the platform — 34 of 90 recent curves carried it. Simulating a
  // buy and a sell against three live mayhem tokens with the ordinary instruction
  // layout succeeded on all three; nothing about them needs different accounts.
  //
  // The cashback flag below is a different matter and is real.

  // pump.fun allows curves quoted in something other than SOL, and every price in this
  // bot — the entry quote, the stop-loss, the exit — divides by the quote reserves.
  // For those tokens the SOL-denominated reserves are zero, and one recorded launch
  // produced a NaN profit rather than an error, which is the worst kind of failure
  // because nothing raises.
  //
  // The identity check is on the reserves, not on the mint. A curve quoted in native
  // SOL leaves quoteMint unset — it arrives as the all-zero pubkey, not as WSOL — so
  // requiring WSOL here rejected every launch on the platform. Measured: 57 of 57.
  const nativeSol =
    token.quoteMint.equals(PublicKey.default) || token.quoteMint.equals(WSOL_MINT);
  if (!nativeSol) {
    return { passed: false, reason: `curve is quoted in ${token.quoteMint.toBase58().slice(0, 8)}` };
  }
  const quoteReserves = token.virtualQuoteReserves || token.virtualSolReserves;
  if (quoteReserves <= 0n) {
    return { passed: false, reason: 'curve reports no quote reserves' };
  }

  // Selling a cashback coin fails with InvalidCashbackAccumulator (6073) — the sell
  // wants an accumulator account the plain instruction does not carry. Buying one
  // would mean a position stop-loss cannot exit, so skip them entirely. Re-confirmed
  // against three live cashback tokens: all three simulate a clean buy and fail on
  // the sell, which is the worst shape a position can have.
  if (token.isCashbackEnabled) {
    return { passed: false, reason: 'cashback token (cannot be sold by this bot)' };
  }

  return { passed: true };
}
