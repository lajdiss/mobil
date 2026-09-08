/**
 * Stage timings for the entry path, in milliseconds with sub-millisecond resolution.
 *
 * The point is not decoration. Published guides put competitive pump.fun bots under
 * 50ms end to end, and rounds here measured the whole edge of a snipe living in the
 * first few hundred milliseconds. Without real numbers, "make it faster" is a feeling —
 * these say which stage to attack and whether the result moved at all.
 */

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

export type Stage = 'detect' | 'filter' | 'quote' | 'build' | 'submit' | 'confirm';

export interface Attempt {
  mint: string;
  startedAt: number;
  marks: Partial<Record<Stage, number>>;
  outcome?: 'bought' | 'rejected' | 'failed';
  reason?: string;
}

/** Percentile over a sorted copy; p50 and p95 say more than a mean over a long tail. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export class Metrics {
  private attempts = new Map<string, Attempt>();
  private completed: Attempt[] = [];
  private rejections = new Map<string, number>();
  private rpcSamples: number[] = [];

  start(mint: string): Attempt {
    const attempt: Attempt = { mint, startedAt: now(), marks: {} };
    this.attempts.set(mint, attempt);
    // Bounded: launches arrive all day and most never become a position.
    if (this.attempts.size > 500) {
      const oldest = this.attempts.keys().next().value;
      if (oldest) this.attempts.delete(oldest);
    }
    return attempt;
  }

  mark(mint: string, stage: Stage) {
    const attempt = this.attempts.get(mint);
    if (!attempt) return;
    attempt.marks[stage] = now() - attempt.startedAt;
  }

  finish(mint: string, outcome: Attempt['outcome'], reason?: string) {
    const attempt = this.attempts.get(mint);
    if (!attempt) return;
    attempt.outcome = outcome;
    attempt.reason = reason;
    this.attempts.delete(mint);

    if (reason) this.rejections.set(reason, (this.rejections.get(reason) ?? 0) + 1);
    // Only completed entries carry useful stage timings.
    if (outcome === 'bought' || outcome === 'failed') {
      this.completed.push(attempt);
      if (this.completed.length > 300) this.completed.shift();
    }
  }

  /** Timed separately: RPC latency dominates every stage that touches the network. */
  async timeRpc<T>(fn: () => Promise<T>): Promise<T> {
    const started = now();
    try {
      return await fn();
    } finally {
      this.rpcSamples.push(now() - started);
      if (this.rpcSamples.length > 500) this.rpcSamples.shift();
    }
  }

  snapshot() {
    const stages: Stage[] = ['filter', 'quote', 'build', 'submit', 'confirm'];
    const byStage: Record<string, { p50: number | null; p95: number | null }> = {};
    for (const stage of stages) {
      const values = this.completed
        .map((a) => a.marks[stage])
        .filter((v): v is number => v !== undefined);
      byStage[stage] = { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
    }

    // The number that matters: detection to the moment the transaction goes out.
    const endToEnd = this.completed
      .map((a) => a.marks.submit ?? a.marks.build)
      .filter((v): v is number => v !== undefined);

    return {
      samples: this.completed.length,
      stages: byStage,
      endToEnd: { p50: percentile(endToEnd, 0.5), p95: percentile(endToEnd, 0.95) },
      rpc: {
        p50: percentile(this.rpcSamples, 0.5),
        p95: percentile(this.rpcSamples, 0.95),
        samples: this.rpcSamples.length,
      },
      rejections: [...this.rejections.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([reason, count]) => ({ reason, count })),
    };
  }
}
