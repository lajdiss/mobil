/**
 * Replays exit rules over recorded price paths.
 *
 * Every live round so far cost hours to evaluate one configuration, and the
 * comparisons were not even paired: a rule that exits faster frees a position slot, so
 * it trades a different set of tokens than the rule it is being compared against. One
 * round measured 31 trades against 12 and called it an A/B.
 *
 * Here every configuration sees the identical trades, and a grid of them runs in
 * seconds. Win rate and expectancy are always printed together, because win rate on
 * its own is a dial: the break-even rate is stopLoss / (takeProfit + stopLoss) plus
 * fees, so a rule can lift win rate well past 60% and still lose money on every pass.
 *
 *   npm run replay -- data/paths.jsonl
 */
import { readFileSync } from 'node:fs';
import type { RecordedPath } from './recorder.js';

interface ExitRule {
  label: string;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  maxHoldSeconds: number;
  partialTakeProfitPct: number;
  partialSellPct: number;
  breakEvenAfterPartial: boolean;
  creatorSellMinBps: number;
}

interface Outcome {
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
function simulate(path: RecordedPath, rule: ExitRule): Outcome {
  const feeMultiplier = (1e4 - path.feeBps) / 1e4;
  let tokens = BigInt(path.entryTokens);
  let realised = 0;
  let peak = path.entrySol;
  let partialTaken = false;
  let stopAtBreakEven = false;

  const valueAt = (s: { vt: string; vq: string }) =>
    realised + (Number(solForTokens(BigInt(s.vt), BigInt(s.vq), tokens)) / 1e9) * feeMultiplier;

  let nextSale = 0;

  for (const sample of path.samples) {
    // Creator sales are stored with their own timestamps, so they are applied at the
    // first sample at or after they happened rather than assumed to land on one.
    while (nextSale < path.creatorSales.length && path.creatorSales[nextSale].t <= sample.t) {
      const sale = path.creatorSales[nextSale++];
      if (rule.creatorSellMinBps > 0 && sale.bps >= rule.creatorSellMinBps) {
        const value = valueAt(sample);
        return {
          pct: ((value - path.entrySol) / path.entrySol) * 100,
          reason: 'dev-sold',
          heldSeconds: sample.t / 1000,
        };
      }
    }

    const value = valueAt(sample);
    peak = Math.max(peak, value);
    const pnl = ((value - path.entrySol) / path.entrySol) * 100;
    const done = (reason: string) => ({ pct: pnl, reason, heldSeconds: sample.t / 1000 });

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
      realised +=
        (Number(solForTokens(BigInt(sample.vt), BigInt(sample.vq), sold)) / 1e9) * feeMultiplier;
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

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function evaluate(paths: RecordedPath[], rule: ExitRule) {
  const outcomes = paths.map((p) => simulate(p, rule));
  const wins = outcomes.filter((o) => o.pct > 0).length;
  const pcts = outcomes.map((o) => o.pct);
  const expectancy = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const avgFeeBps = paths.reduce((a, p) => a + p.feeBps, 0) / paths.length;
  // w·TP = (1 − w)·SL, with the round trip's fees on top.
  const breakEven =
    ((rule.stopLossPct + (avgFeeBps / 100) * 2) / (rule.takeProfitPct + rule.stopLossPct)) * 100;

  const reasons: Record<string, number> = {};
  for (const o of outcomes) reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;

  return {
    rule,
    winRate: (wins / outcomes.length) * 100,
    breakEven,
    expectancy,
    median: median(pcts),
    best: Math.max(...pcts),
    worst: Math.min(...pcts),
    avgHold: outcomes.reduce((a, o) => a + o.heldSeconds, 0) / outcomes.length,
    reasons,
    // With a fat tail, the mean is one lucky trade away from meaningless. This says
    // how much of the total the three best contributed.
    top3Share: (() => {
      const sorted = [...pcts].sort((a, b) => b - a);
      const total = pcts.reduce((a, b) => a + b, 0);
      return total > 0 ? (sorted.slice(0, 3).reduce((a, b) => a + b, 0) / total) * 100 : null;
    })(),
  };
}

const rule = (label: string, over: Partial<ExitRule>): ExitRule => ({
  label,
  takeProfitPct: 50,
  stopLossPct: 30,
  trailingStopPct: 0,
  maxHoldSeconds: 300,
  partialTakeProfitPct: 0,
  partialSellPct: 50,
  breakEvenAfterPartial: true,
  creatorSellMinBps: 0,
  ...over,
});

function buildGrid(): ExitRule[] {
  const rules: ExitRule[] = [
    rule('buy and hold (no exit)', { takeProfitPct: 1e6, stopLossPct: 99.9, maxHoldSeconds: 1e6 }),
  ];
  for (const tp of [15, 30, 50, 100, 200]) {
    for (const sl of [10, 20, 30, 50]) {
      rules.push(rule(`TP${tp} / SL${sl}`, { takeProfitPct: tp, stopLossPct: sl }));
    }
  }
  for (const trail of [10, 20, 35]) {
    rules.push(rule(`trail ${trail}%`, { takeProfitPct: 1e6, stopLossPct: 50, trailingStopPct: trail }));
  }
  for (const partial of [15, 25, 40]) {
    for (const share of [30, 50, 70]) {
      rules.push(
        rule(`partial ${share}% at +${partial}`, {
          partialTakeProfitPct: partial,
          partialSellPct: share,
        }),
      );
    }
  }
  for (const bps of [25, 50, 150]) {
    rules.push(rule(`dev-sell exit >${bps}bps`, { creatorSellMinBps: bps }));
    rules.push(
      rule(`dev-sell >${bps}bps + partial 50% at +25`, {
        creatorSellMinBps: bps,
        partialTakeProfitPct: 25,
      }),
    );
  }
  for (const hold of [60, 120, 600]) {
    rules.push(rule(`hold ${hold}s`, { maxHoldSeconds: hold }));
  }
  return rules;
}

const file = process.argv[2] ?? 'data/paths.jsonl';
const paths: RecordedPath[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as RecordedPath);

if (paths.length === 0) {
  console.log(`no recorded paths in ${file}`);
  process.exit(1);
}

const coverage = paths.map((p) => p.samples[p.samples.length - 1].t / 1000);
console.log(`${paths.length} recorded paths from ${file}`);
console.log(
  `each followed for a median of ${median(coverage).toFixed(0)}s ` +
    `(shortest ${Math.min(...coverage).toFixed(0)}s, longest ${Math.max(...coverage).toFixed(0)}s)`,
);
console.log(
  'A rule needing longer than a path was recorded for cannot be judged from it — ' +
    'those show as path-ended.\n',
);

const results = buildGrid()
  .map((r) => evaluate(paths, r))
  .sort((a, b) => b.expectancy - a.expectancy);

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number, n: number, digits = 1) => v.toFixed(digits).padStart(n);

console.log(
  pad('rule', 32) + 'win%'.padStart(7) + 'need'.padStart(7) + 'exp%'.padStart(8) +
    'med%'.padStart(8) + 'worst'.padStart(8) + 'hold'.padStart(7) + '  top3',
);
console.log('-'.repeat(84));
for (const r of results) {
  console.log(
    pad(r.rule.label, 32) +
      num(r.winRate, 7) +
      num(r.breakEven, 7) +
      num(r.expectancy, 8, 2) +
      num(r.median, 8, 2) +
      num(r.worst, 8, 1) +
      num(r.avgHold, 7, 0) +
      (r.top3Share === null ? '     —' : num(r.top3Share, 6, 0) + '%'),
  );
}

console.log(
  '\nwin% is the share of trades that made money; need is the win rate that rule ' +
    'requires\njust to break even after fees. A rule beating its own "need" is the ' +
    'only kind worth having.',
);
