import { PublicKey } from '@solana/web3.js';
import type { AttentionStats, AttentionTracker } from './attention.js';
import { HypeClient, type HypeSnapshot } from './hype.js';

/**
 * Picks tokens that are alive and being bought by a crowd, regardless of age.
 *
 * Every earlier mode was tied to the launch, and everything measured says that is the
 * wrong place to stand: the exits are already at their ceiling, and the entry is a
 * latency race a public RPC cannot win. This drops the launch entirely. A token that
 * has been trading for an hour is not worse than one that launched ten seconds ago —
 * it is merely not a race.
 *
 * Two sources, and the split between them matters:
 *
 * pump.fun's API supplies the candidate pool and liveness. It cannot supply attention:
 * every token sampled had its last comment months in the past, so reply counts are
 * history rather than a signal, and livestreams appeared on 2 of 295 live tokens.
 * Socials are on two thirds of them, which makes them a weak discriminator at best.
 *
 * Attention therefore comes from the event streams this bot already runs, where the
 * buyer's wallet is on every trade. How many different people are buying is the
 * signal; how many trades happened is not, because one bot cycling produces plenty.
 */
export interface TrendingConfig {
  /** Seconds since the last trade before a token stops counting as alive. */
  maxTradeAgeSeconds: number;
  /** Distinct buyers required inside the observation window. */
  minUniqueBuyers: number;
  /** Buy share of trades; below this the crowd is selling, not buying. */
  minBuyRatio: number;
  /** Reject when one wallet is most of the buying — that is a whale, not a crowd. */
  maxTopBuyerShare: number;
  /** Market cap band in SOL. Too small is nothing; too large has already run. */
  minMarketCapSol: number;
  maxMarketCapSol: number;
  /** How long to watch a candidate before it is allowed to qualify. */
  warmupSeconds: number;
  /** Require at least one of twitter, telegram or website. */
  requireSocial: boolean;
  /** How often to refresh the candidate pool, in seconds. */
  scanIntervalSeconds: number;
  /** Pages of 50 to pull per scan. */
  scanPages: number;
}

export interface TrendingCandidate {
  mint: PublicKey;
  hype: HypeSnapshot;
  attention: AttentionStats;
  score: number;
}

interface Watched {
  hype: HypeSnapshot;
  since: number;
  entered: boolean;
}

export class TrendingScanner {
  private watched = new Map<string, Watched>();
  private timer: NodeJS.Timeout | null = null;

  readonly counters = { scans: 0, pooled: 0, watching: 0, qualified: 0, apiFailures: 0 };

  constructor(
    private readonly client: HypeClient,
    private readonly attention: AttentionTracker,
    private readonly config: TrendingConfig,
    private readonly onReady: (candidate: TrendingCandidate) => void,
    private readonly onWatch: (mint: PublicKey, graduated: boolean) => void,
    private readonly onLog: (message: string) => void,
  ) {}

  start() {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.config.scanIntervalSeconds * 1000);
    // Candidates are judged on a rolling basis, not only when the pool refreshes:
    // a token can cross the threshold between scans and the window is short.
    setInterval(() => this.evaluateAll(), 3000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  health() {
    return { ...this.counters, watching: this.watched.size, api: this.client.health() };
  }

  private async scan() {
    this.counters.scans++;
    const coins = await this.client.listActive(this.config.scanPages);
    if (coins.length === 0) {
      this.counters.apiFailures++;
      // Fail closed: an empty pool means the API did not answer, not that nothing is
      // trading. Keeping the existing watchlist is right; inventing candidates is not.
      return;
    }
    this.counters.pooled = coins.length;

    for (const coin of coins) {
      if (!this.eligible(coin)) continue;
      if (this.watched.has(coin.mint)) continue;
      let mint: PublicKey;
      try {
        mint = new PublicKey(coin.mint);
      } catch {
        continue;
      }
      this.watched.set(coin.mint, { hype: coin, since: Date.now(), entered: false });
      this.attention.register(coin.mint);
      // Tells the streams to start attributing this token's trades to us.
      this.onWatch(mint, coin.graduated);
    }

    // A watchlist that only grows would keep paying attention to dead tokens.
    for (const [key, entry] of this.watched) {
      const age = (Date.now() - entry.since) / 1000;
      if (entry.entered || age > this.config.warmupSeconds * 4) this.watched.delete(key);
    }
    this.attention.sweep();
    this.counters.watching = this.watched.size;
  }

  /** Cheap gates from the API alone, before anything is watched or scored. */
  private eligible(coin: HypeSnapshot): boolean {
    if (coin.isBanned) return false;
    if (coin.lastTradeAgoSeconds === null) return false;
    if (coin.lastTradeAgoSeconds > this.config.maxTradeAgeSeconds) return false;
    if (coin.marketCapSol < this.config.minMarketCapSol) return false;
    if (coin.marketCapSol > this.config.maxMarketCapSol) return false;
    if (
      this.config.requireSocial &&
      !coin.hasTwitter &&
      !coin.hasTelegram &&
      !coin.hasWebsite
    ) {
      return false;
    }
    return true;
  }

  private evaluateAll() {
    for (const [key, entry] of this.watched) {
      if (entry.entered) continue;
      const watchedFor = (Date.now() - entry.since) / 1000;
      // Before the warm-up the buyer count is a measure of how long we have been
      // looking, not of how many people are buying.
      if (watchedFor < this.config.warmupSeconds) continue;

      const stats = this.attention.stats(key);
      if (!stats) continue;
      if (stats.uniqueBuyers < this.config.minUniqueBuyers) continue;
      if (stats.buyRatio < this.config.minBuyRatio) continue;
      if (stats.topBuyerShare > this.config.maxTopBuyerShare) continue;

      entry.entered = true;
      this.counters.qualified++;
      this.onLog(
        `${entry.hype.symbol}: ${stats.uniqueBuyers} different buyers in ${watchedFor.toFixed(0)}s, ` +
          `${(stats.buyRatio * 100).toFixed(0)}% buys, top buyer ${(stats.topBuyerShare * 100).toFixed(0)}%`,
      );
      this.onReady({
        mint: new PublicKey(key),
        hype: entry.hype,
        attention: stats,
        score: trendingScore(entry.hype, stats),
      });
    }
  }
}

/**
 * One number for how much of a crowd a token has, so it can be swept like any other
 * parameter. The weights are a starting point and nothing here is trusted until the
 * offline replay says these fields separate outcomes.
 */
export function trendingScore(hype: HypeSnapshot, attention: AttentionStats): number {
  let score = 0;
  score += Math.min(40, attention.uniqueBuyers * 2);
  score += Math.min(20, attention.buyersPerMinute * 2);
  score += Math.min(15, Math.max(0, (attention.buyRatio - 0.5) * 60));
  score += Math.min(10, Math.max(0, attention.netSolFlow));
  // One wallet doing most of the buying is the opposite of a crowd.
  score -= Math.round(attention.topBuyerShare * 25);
  if (hype.hasTwitter) score += 5;
  if (hype.isCurrentlyLive) score += 8;
  if (hype.athMarketCapSol > 0 && hype.marketCapSol < hype.athMarketCapSol * 0.4) score -= 10;
  return Math.round(score);
}
