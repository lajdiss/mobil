/**
 * Sweeps entry delay against exit rule over recorded launches.
 *
 * The exit sweep answered its question and the answer was "nothing helps": with
 * perfect foresight, selling every recorded path at its own peak, only 3 of 41 tokens
 * ever traded 2% above the entry — the same 7.3% the best exit rule already reached.
 * The exits were already at the ceiling. What moved the ceiling was timing: 39% of
 * those tokens peaked within five seconds of the entry, so the move was over before
 * the bot bought.
 *
 * That makes the entry delay the parameter worth sweeping, and it needs launch-relative
 * recordings — a path that starts at the entry has no record of what came before it.
 * Here every (delay, exit) pair is constructed against the same launches, so the two
 * are separable for the first time.
 *
 *   npm run replay:entry -- data/launches.jsonl
 */
import { readFileSync } from 'node:fs';
import { entryPathFromLaunch, type RecordedLaunch } from './launches.js';
import type { RecordedPath } from './recorder.js';
import { rule, simulate, type ExitRule } from './exitrules.js';

const solForTokens = (vt: bigint, vq: bigint, tokens: bigint) =>
  tokens <= 0n ? 0n : (tokens * vq) / (vt + tokens);
const tokensForSol = (vt: bigint, vq: bigint, sol: bigint) =>
  sol <= 0n ? 0n : (sol * vt) / (vq + sol);

const BUY_LAMPORTS = 50_000_000n; // 0.05 SOL, matching the live runs

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const file = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/launches.jsonl';
const launches: RecordedLaunch[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as RecordedLaunch);

if (launches.length === 0) {
  console.log(`no recorded launches in ${file}`);
  process.exit(1);
}

const coverage = launches.map((l) => l.samples[l.samples.length - 1].t / 1000);
console.log(`${launches.length} recorded launches from ${file}`);
console.log(
  `each followed for a median of ${median(coverage).toFixed(0)}s after launch ` +
    `(longest ${Math.max(...coverage).toFixed(0)}s)\n`,
);

// 0s is included as a reference line only. It prices the entry off the launch event's
// own reserves — the price before anyone traded the token — which no transaction can
// actually get: by the time a buy lands, it has moved the curve itself and competed
// with everyone else doing the same. Read it as the unattainable upper bound, not as
// a strategy.
const DELAYS = [0, 2, 5, 10, 20, 30, 60, 120, 240];
const EXITS: ExitRule[] = [
  rule('TP30 / SL20', { takeProfitPct: 30, stopLossPct: 20 }),
  rule('TP50 / SL30', { takeProfitPct: 50, stopLossPct: 30 }),
  rule('TP100 / SL30', { takeProfitPct: 100, stopLossPct: 30 }),
  rule('trail 20%', { takeProfitPct: 1e6, stopLossPct: 50, trailingStopPct: 20 }),
  rule('hold 60s', { maxHoldSeconds: 60, takeProfitPct: 1e6, stopLossPct: 99 }),
  rule('buy and hold', { takeProfitPct: 1e6, stopLossPct: 99.9, maxHoldSeconds: 1e6 }),
];

const pad = (s: string, n: number) => s.padEnd(n);
const cell = (v: number | null, n: number) => (v === null ? '—' : v.toFixed(1)).padStart(n);

/**
 * Three tables, not one. A mean on a fat-tailed distribution is one lucky trade away
 * from meaningless — an early run showed +54% expectancy at a delay whose median peak
 * was negative, which is one winner carrying twenty-four losers. The median says what
 * a typical trade did, and top3 says how much of the mean came from three of them.
 */
for (const label of ['WIN RATE %', 'EXPECTANCY %', 'MEDIAN %', 'TOP-3 SHARE OF PROFIT %'] as const) {
  console.log(`\n${label}  (rows = seconds waited after launch, columns = exit rule)`);
  console.log(pad('  wait', 8) + EXITS.map((e) => pad(e.label, 14)).join('') + 'n');
  console.log('-'.repeat(8 + EXITS.length * 14 + 4));
  for (const delay of DELAYS) {
    const paths = launches
      .map((l) => entryPathFromLaunch(l, delay))
      .filter((p): p is RecordedPath => p !== null);
    if (paths.length === 0) continue;
    const cells = EXITS.map((exit) => {
      const outcomes = paths.map((p) => simulate(p, exit));
      const pcts = outcomes.map((o) => o.pct);
      const total = pcts.reduce((a, b) => a + b, 0);
      let value: number | null;
      if (label === 'WIN RATE %') {
        value = (pcts.filter((p) => p > 0).length / pcts.length) * 100;
      } else if (label === 'EXPECTANCY %') {
        value = total / pcts.length;
      } else if (label === 'MEDIAN %') {
        value = median(pcts);
      } else {
        // Only meaningful when the rule made money overall; otherwise there is no
        // profit for three trades to be a share of.
        const top3 = [...pcts].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
        value = total > 0 ? (top3 / total) * 100 : null;
      }
      return cell(value, 8).padEnd(14);
    });
    console.log(
      pad(`  ${delay}s`, 8) +
        cells.join('') +
        String(paths.length).padStart(4) +
        (delay === 0 ? '   <- unattainable (launch price)' : ''),
    );
  }
}

// The ceiling every exit rule in the table above is competing against.
console.log('\nPERFECT-FORESIGHT CEILING — sell at the peak, per entry delay');
console.log(pad('  wait', 8) + 'ever >0%'.padStart(10) + 'ever >2%'.padStart(10) +
  'median peak'.padStart(13) + '   n');
for (const delay of DELAYS) {
  const paths = launches
    .map((l) => entryPathFromLaunch(l, delay))
    .filter((p): p is RecordedPath => p !== null);
  if (paths.length === 0) continue;
  const peaks = paths.map((p) => {
    const tokens = BigInt(p.entryTokens);
    const fee = (1e4 - p.feeBps) / 1e4;
    return Math.max(
      ...p.samples.map(
        (s) =>
          (((Number(solForTokens(BigInt(s.vt), BigInt(s.vq), tokens)) / 1e9) * fee - p.entrySol) /
            p.entrySol) *
          100,
      ),
    );
  });
  console.log(
    pad(`  ${delay}s`, 8) +
      ((peaks.filter((p) => p > 0).length / peaks.length) * 100).toFixed(1).padStart(9) + '%' +
      ((peaks.filter((p) => p > 2).length / peaks.length) * 100).toFixed(1).padStart(9) + '%' +
      median(peaks).toFixed(2).padStart(12) + '%' +
      String(peaks.length).padStart(4),
  );
}

console.log(
  '\nThe ceiling is what an exit rule cannot beat: a trade is only a win if the price\n' +
    'traded above the entry at some point. Where the ceiling is low, no exit helps.',
);
