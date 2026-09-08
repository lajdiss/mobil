import type { AttentionTracker } from './attention.js';

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

  /**
   * Scores at selection time, not at insertion. A token's activity keeps changing
   * while it waits, and the whole point is to compare candidates as they are now.
   */
  private score(mint: string): number {
    const crowd = this.attention.crowd(mint, this.scoreWindowSeconds);
    if (crowd) return crowd.tradeRate;
    const stats = this.attention.stats(mint);
    // Falling back to the lifetime count rather than to zero: an unknown token should
    // rank below a busy one, not below a dead one.
    return stats ? (stats.buys + stats.sells) / Math.max(1, stats.ageSeconds) : 0;
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

    const ranked = [...this.waiting.values()]
      .map((candidate) => ({ candidate, score: this.score(candidate.mint) }))
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
