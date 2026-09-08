import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What the bot has learned about which entry conditions paid.
 *
 * Everything else here that resembles learning is about the token — its name, or the
 * wallets trading it. Nothing has ever remembered the thing the offline replays keep
 * finding: that outcomes depend on measurable conditions at the moment of entry, and
 * that those conditions are knowable before buying. Every finding so far had to be
 * carried back into the config by hand, which means the bot ends each run knowing
 * exactly as much as it did at the start.
 *
 * This closes that loop. Conditions at entry are bucketed, outcomes are recorded
 * against the bucket, and the result survives a restart.
 *
 * Two rules keep it from being another way to fool ourselves:
 *
 * It says nothing until it has enough trades. With a handful of samples every bucket
 * looks either brilliant or fatal, and acting on that is how a grid search finds
 * noise — which has happened repeatedly in this project.
 *
 * And a bucket's own average is pulled toward the overall average in proportion to how
 * little evidence it has. A bucket with three trades barely moves off the global mean
 * however good those three were; one with eighty is mostly its own. That is the same
 * shrinkage the keyword memory uses, for the same reason: the single loudest lesson
 * from every round here is that three lucky trades look exactly like an edge.
 */
export interface EntryFeatures {
  /** Trades per second over the window before entry. */
  tradeRate?: number;
  /** Percent the price had already moved over that window. */
  runUpPct?: number;
  /** Distinct wallets that had bought by then. */
  uniqueBuyers?: number;
}

interface Bucket {
  n: number;
  /** Sum of percentage outcomes, so the mean survives a reload without the trades. */
  sum: number;
  wins: number;
}

interface Snapshot {
  version: 1;
  global: Bucket;
  buckets: Record<string, Bucket>;
}

export interface MemoryConfig {
  /** Closed trades before any score is returned at all. */
  minTrades: number;
  /** Trades in a bucket that count as "fully its own"; below that it is shrunk. */
  shrinkageStrength: number;
}

export const DEFAULT_MEMORY: MemoryConfig = { minTrades: 60, shrinkageStrength: 12 };

/**
 * Bucket edges, chosen from the ranges the offline replays actually separated on
 * rather than from round numbers. Coarse on purpose: finer buckets mean fewer trades
 * in each, and this needs evidence per bucket more than it needs resolution.
 */
const TRADE_RATE_EDGES = [0.5, 1.0, 1.5, 2.5];
const RUN_UP_EDGES = [-25, 0, 10, 50];
const BUYER_EDGES = [5, 12, 25, 50];

const bucketIndex = (value: number, edges: number[]): number => {
  let i = 0;
  while (i < edges.length && value >= edges[i]) i++;
  return i;
};

/** A short stable label per feature, so the persisted file stays readable. */
export function featureKeys(features: EntryFeatures): string[] {
  const keys: string[] = [];
  if (features.tradeRate !== undefined) {
    keys.push(`rate:${bucketIndex(features.tradeRate, TRADE_RATE_EDGES)}`);
  }
  if (features.runUpPct !== undefined) {
    keys.push(`runup:${bucketIndex(features.runUpPct, RUN_UP_EDGES)}`);
  }
  if (features.uniqueBuyers !== undefined) {
    keys.push(`buyers:${bucketIndex(features.uniqueBuyers, BUYER_EDGES)}`);
  }
  return keys;
}

export class OutcomeMemory {
  private global: Bucket = { n: 0, sum: 0, wins: 0 };
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly path: string,
    private readonly config: MemoryConfig = DEFAULT_MEMORY,
  ) {
    this.load();
  }

  private load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Snapshot;
      if (parsed.version !== 1) return;
      this.global = parsed.global;
      for (const [key, bucket] of Object.entries(parsed.buckets)) this.buckets.set(key, bucket);
    } catch {
      // Starting empty is correct when there is nothing to load.
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const buckets: Record<string, Bucket> = {};
      for (const [key, bucket] of this.buckets) buckets[key] = bucket;
      writeFileSync(this.path, JSON.stringify({ version: 1, global: this.global, buckets }, null, 1));
    } catch {
      // Losing the file is not worth interrupting trading over.
    }
  }

  /** Called once per closed position, with the conditions that were true at entry. */
  record(features: EntryFeatures, outcomePct: number) {
    if (!Number.isFinite(outcomePct)) return;
    this.global.n++;
    this.global.sum += outcomePct;
    if (outcomePct > 0) this.global.wins++;

    for (const key of featureKeys(features)) {
      const bucket = this.buckets.get(key) ?? { n: 0, sum: 0, wins: 0 };
      bucket.n++;
      bucket.sum += outcomePct;
      if (outcomePct > 0) bucket.wins++;
      this.buckets.set(key, bucket);
    }
  }

  get warm(): boolean {
    return this.global.n >= this.config.minTrades;
  }

  /**
   * Expected outcome for these conditions, in percent, or null while cold.
   *
   * Averaged across the features present rather than combined multiplicatively: the
   * buckets overlap heavily — a fast-trading token is usually also one with many
   * buyers — so multiplying would count the same evidence several times.
   */
  score(features: EntryFeatures): number | null {
    if (!this.warm) return null;
    const globalMean = this.global.sum / this.global.n;
    const keys = featureKeys(features);
    if (keys.length === 0) return globalMean;

    const k = this.config.shrinkageStrength;
    let total = 0;
    for (const key of keys) {
      const bucket = this.buckets.get(key);
      if (!bucket || bucket.n === 0) {
        total += globalMean;
        continue;
      }
      // The shrinkage: a bucket with k trades sits halfway between its own mean and
      // the global one, and approaches its own mean from there.
      total += (bucket.sum + globalMean * k) / (bucket.n + k);
    }
    return total / keys.length;
  }

  /** What the dashboard shows, so the learning is inspectable rather than implied. */
  stats() {
    const globalMean = this.global.n > 0 ? this.global.sum / this.global.n : null;
    const rows = [...this.buckets.entries()]
      .map(([key, bucket]) => ({
        key,
        trades: bucket.n,
        rawPct: bucket.sum / bucket.n,
        shrunkPct:
          globalMean === null
            ? null
            : (bucket.sum + globalMean * this.config.shrinkageStrength) /
              (bucket.n + this.config.shrinkageStrength),
        winRatePct: (bucket.wins / bucket.n) * 100,
      }))
      .sort((a, b) => (b.shrunkPct ?? -Infinity) - (a.shrunkPct ?? -Infinity));

    return {
      trades: this.global.n,
      warm: this.warm,
      needed: Math.max(0, this.config.minTrades - this.global.n),
      globalPct: globalMean,
      globalWinRatePct: this.global.n > 0 ? (this.global.wins / this.global.n) * 100 : null,
      buckets: rows,
    };
  }
}
