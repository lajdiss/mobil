import type { RecordedPath } from './recorder.js';

/**
 * The exit engine, shared by the replay CLIs.
 *
 * Kept separate from any script so it can be imported without running one — the entry
 * sweep drives the same simulator over synthetic entries at different delays.
 */
export interface ExitRule {
  label: string;
  /**
   * Seconds between a rule firing and the sale actually pricing.
   *
   * Without this the replay fills at the sample that triggered the exit, which is a
   * price the bot cannot get: it sees the trade event, builds a transaction, and lands
   * a second or two later. On sparse samples the difference is not small — a rule with
   * a 10% target was scoring its take-profit exits at an average of +27%, because the
   * price gapped past the threshold between samples and the fill was booked at the top
   * of the gap. The live bot measures the same effect as overshoot on its stop-losses.
   */
  executionDelaySeconds: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  maxHoldSeconds: number;
  partialTakeProfitPct: number;
  partialSellPct: number;
  breakEvenAfterPartial: boolean;
  creatorSellMinBps: number;
}

export interface Outcome {
  pct: number;
  reason: string;
  heldSeconds: number;
}

/** Constant product, matching the executor. */
const solForTokens = (vt: bigint, vq: bigint, tokens: bigint) =>
  tokens <= 0n ? 0n : (tokens * vq) / (vt + tokens);

/**
 * One position, one rule. Walks the recorded samples in order and applies the rule as
 * the live bot would, including the fee on every sale — a scale-out pays it twice, and
 * ignoring that would make partial exits look better than they are.
 */
export function simulate(path: RecordedPath, rule: ExitRule): Outcome {
  const feeMultiplier = (1e4 - path.feeBps) / 1e4;
  let tokens = BigInt(path.entryTokens);
  let realised = 0;
  let peak = path.entrySol;
  let partialTaken = false;
  let stopAtBreakEven = false;

  const valueAt = (s: { vt: string; vq: string }) =>
    realised + (Number(solForTokens(BigInt(s.vt), BigInt(s.vq), tokens)) / 1e9) * feeMultiplier;

  let nextSale = 0;

  /** Value of the position at the first sample at least `delay` after `fromMs`. */
  const fillAfter = (fromMs: number) => {
    const target = fromMs + rule.executionDelaySeconds * 1000;
    for (const s of path.samples) {
      if (s.t >= target) return valueAt(s);
    }
    // The recording ends before the fill would have landed; the last price is the best
    // estimate available, and it is the same one a path-ended exit would use.
    return valueAt(path.samples[path.samples.length - 1]);
  };

  for (const sample of path.samples) {
    // Creator sales are stored with their own timestamps, so they are applied at the
    // first sample at or after they happened rather than assumed to land on one.
    while (nextSale < path.creatorSales.length && path.creatorSales[nextSale].t <= sample.t) {
      const sale = path.creatorSales[nextSale++];
      if (rule.creatorSellMinBps > 0 && sale.bps >= rule.creatorSellMinBps) {
        const filled = fillAfter(sample.t);
        return {
          pct: ((filled - path.entrySol) / path.entrySol) * 100,
          reason: 'dev-sold',
          heldSeconds: sample.t / 1000,
        };
      }
    }

    const value = valueAt(sample);
    peak = Math.max(peak, value);
    const pnl = ((value - path.entrySol) / path.entrySol) * 100;
    // The rule decides on this sample; the sale prices at whatever the market is doing
    // once the transaction lands.
    const done = (reason: string) => {
      const filled = fillAfter(sample.t);
      return {
        pct: ((filled - path.entrySol) / path.entrySol) * 100,
        reason,
        heldSeconds: sample.t / 1000,
      };
    };

    if (pnl >= rule.takeProfitPct) return done('take-profit');
    if (pnl <= -rule.stopLossPct) return done('stop-loss');
    if (stopAtBreakEven && pnl <= 0) return done('break-even');
    if (rule.trailingStopPct > 0 && peak > path.entrySol) {
      if (((peak - value) / peak) * 100 >= rule.trailingStopPct) return done('trailing-stop');
    }
    if (sample.t / 1000 >= rule.maxHoldSeconds) return done('timeout');

    if (
      rule.partialTakeProfitPct > 0 &&
      !partialTaken &&
      pnl >= rule.partialTakeProfitPct &&
      pnl < rule.takeProfitPct
    ) {
      const sold = (tokens * BigInt(rule.partialSellPct)) / 100n;
      // A partial is a real sale and lands on the same delay as any other.
      const at = path.samples.find((s) => s.t >= sample.t + rule.executionDelaySeconds * 1000)
        ?? path.samples[path.samples.length - 1];
      realised +=
        (Number(solForTokens(BigInt(at.vt), BigInt(at.vq), sold)) / 1e9) * feeMultiplier;
      tokens -= sold;
      partialTaken = true;
      if (rule.breakEvenAfterPartial) stopAtBreakEven = true;
    }
  }

  const last = path.samples[path.samples.length - 1];
  const value = valueAt(last);
  return {
    pct: ((value - path.entrySol) / path.entrySol) * 100,
    // The recording ended before the rule fired; the result is where it stood, and the
    // label says so rather than pretending a rule closed it.
    reason: 'path-ended',
    heldSeconds: last.t / 1000,
  };
}


/** Builds a rule from the shared defaults, overriding only what a case varies. */
export const rule = (label: string, over: Partial<ExitRule>): ExitRule => ({
  label,
  takeProfitPct: 50,
  stopLossPct: 30,
  trailingStopPct: 0,
  maxHoldSeconds: 300,
  partialTakeProfitPct: 0,
  partialSellPct: 50,
  breakEvenAfterPartial: true,
  creatorSellMinBps: 0,
  // Measured on this bot's own exits: the sale lands a second or two after the rule
  // fires. Overridable so the cost of latency can itself be swept.
  executionDelaySeconds: Number(process.env.REPLAY_EXEC_DELAY ?? 1.5),
  ...over,
});
