import type { AttentionTracker } from './attention.js';
import type { EntryFeatures } from './memory.js';

/** What the queue needs from the outcome memory; kept narrow so tests can fake it. */
export interface RankingMemory {
  readonly warm: boolean;
  score(features: EntryFeatures): number | null;
}

/**
 * Picks the best candidate instead of the first acceptable one.
 *
 * A floor is not a selector, and treating it as one was making the bot buy exactly
 * what it should have skipped. Measured over 679 recorded launches, the activity floor
 * of twelve trades passes 50% of everything — while the busiest tokens run to 121
 * trades in the same window. Entering on the first token to cross the floor fills the
 * open-position slots with median tokens, and the genuinely active ones arrive to find
 * no room.
 *
 * So candidates wait briefly in a pool and the best one goes first. The wait costs
 * entry time, which is real; the alternative costs the whole point of measuring
 * activity at all.
 */
export interface Candidate<T> {
  mint: string;
  token: T;
  addedAt: number;
}

export interface SelectionConfig {
  /** How long candidates pool before the best is taken, in seconds. */
  windowSeconds: number;
  /** Candidates older than this are dropped unpicked. */
  maxAgeSeconds: number;
  /** How many to release per round; the rest keep competing or expire. */
  perRound: number;
}

export class EntryQueue<T> {
  private waiting = new Map<string, Candidate<T>>();
  private timer: NodeJS.Timeout | null = null;

  readonly counters = { queued: 0, released: 0, expired: 0, passedOver: 0 };

  constructor(
    private readonly config: SelectionConfig,
    private readonly attention: AttentionTracker,
    /** Seconds of history the score looks back over. */
    private readonly scoreWindowSeconds: number,
    private readonly onRelease: (token: T) => void,
    private readonly canRelease: () => boolean,
    /** Once warm, candidates are ranked by what conditions like theirs have paid. */
    private readonly memory?: RankingMemory,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.round(), this.config.windowSeconds * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  add(mint: string, token: T) {
    if (this.waiting.has(mint)) return;
    this.waiting.set(mint, { mint, token, addedAt: Date.now() });
    this.counters.queued++;
  }

  get size(): number {
    return this.waiting.size;
  }

  health() {
    return { ...this.counters, waiting: this.waiting.size };
  }

  /** The crowd reading a candidate is judged on, taken at selection time. */
  features(mint: string): EntryFeatures {
    const crowd = this.attention.crowd(mint, this.scoreWindowSeconds);
    const stats = this.attention.stats(mint);
    return {
      // Falling back to the lifetime rate rather than to zero: an unknown token should
      // rank below a busy one, not below a dead one.
      tradeRate: crowd
        ? crowd.tradeRate
        : stats
          ? (stats.buys + stats.sells) / Math.max(1, stats.ageSeconds)
          : 0,
      runUpPct: crowd?.runUpPct,
      uniqueBuyers: stats?.uniqueBuyers,
    };
  }

  /**
   * Scores at selection time, not at insertion. A token's activity keeps changing
   * while it waits, and the whole point is to compare candidates as they are now.
   *
   * `useMemory` is decided once per round rather than per candidate: expected percent
   * and trades per second are different units, and ranking half a field by one and
   * half by the other would order them by which happened to be available.
   */
  private score(mint: string, useMemory: boolean): number {
    const features = this.features(mint);
    if (useMemory) {
      const learned = this.memory?.score(features);
      if (learned !== null && learned !== undefined) return learned;
    }
    return features.tradeRate ?? 0;
  }

  private round() {
    const cutoff = Date.now() - this.config.maxAgeSeconds * 1000;
    for (const [mint, candidate] of this.waiting) {
      if (candidate.addedAt < cutoff) {
        this.waiting.delete(mint);
        this.counters.expired++;
      }
    }
    if (this.waiting.size === 0) return;

    const useMemory = this.memory?.warm === true;
    const ranked = [...this.waiting.values()]
      .map((candidate) => ({ candidate, score: this.score(candidate.mint, useMemory) }))
      .sort((a, b) => b.score - a.score);

    for (const { candidate } of ranked.slice(0, this.config.perRound)) {
      if (!this.canRelease()) break;
      this.waiting.delete(candidate.mint);
      this.counters.released++;
      this.onRelease(candidate.token);
    }
    // Everything else stays in the pool and competes again next round, which is what
    // makes this a ranking rather than a queue.
    this.counters.passedOver += Math.max(0, ranked.length - this.config.perRound);
  }
}
