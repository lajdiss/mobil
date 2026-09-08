/**
 * Tests whether good trading windows can be recognised before trading in them.
 *
 * Splitting the recordings in half showed the win rate was a property of the window,
 * not the rule: 9.3% in one half, 53.5% in the other, nothing holding across both. If
 * the regime is what matters, the useful question is not which rule to use but whether
 * you can tell in advance that the next few minutes are worth trading at all.
 *
 * The outcome scored here is a real exit rule, not the peak. An earlier version scored
 * the best price available with perfect foresight and reported a 55% "win rate", which
 * is a ceiling and not something any rule can capture.
 *
 *   npm run replay:regime -- data/launches.jsonl
 */
import { readFileSync } from 'node:fs';
import { entryPathFromLaunch, type RecordedLaunch } from './launches.js';
import { DEFAULT_REGIME, peakWithin, regimeAt, type RegimeFeatures } from './regime.js';
import { rule, simulate } from './exitrules.js';

const ENTRY_DELAY_SECONDS = 5;
const JUDGE_WITHIN_SECONDS = 120;
// The rule that came top of the pooled exit sweep, so this asks whether the regime
// explains when that rule works — the question the split test left open.
const EXIT = rule('TP15 / SL20', {
  takeProfitPct: 15,
  stopLossPct: 20,
  maxHoldSeconds: JUDGE_WITHIN_SECONDS,
});

const file = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/launches.jsonl';
const launches: RecordedLaunch[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as RecordedLaunch)
  .sort((a, b) => a.launchedAt - b.launchedAt);

if (launches.length === 0) {
  console.log(`no recorded launches in ${file}`);
  process.exit(1);
}

/**
 * An independent check that the features cannot see the future.
 *
 * Comparing the features against a time-filtered history is not independent — the
 * filter and the feature can share the same off-by-one, and they did: the first
 * version read prices up to 125 seconds into a launch while only requiring 120 to have
 * elapsed, and a filter built on the same predicate agreed with it perfectly.
 *
 * So this corrupts instead. Every price sample dated after the moment being reasoned
 * about is replaced with garbage. If the features still come out identical, they
 * genuinely never read them; if any reading moves, the corruption found a leak.
 */
function corruptionCheck(): { passed: boolean; detail: string } {
  let checked = 0;
  for (const target of launches) {
    const at = target.launchedAt + ENTRY_DELAY_SECONDS * 1000;
    const poisoned = launches.map((l) => ({
      ...l,
      samples: l.samples.map((s) =>
        l.launchedAt + s.t > at ? { t: s.t, vt: '999999999999999', vq: '1' } : s,
      ),
    }));
    const clean = regimeAt(launches, at, DEFAULT_REGIME, ENTRY_DELAY_SECONDS);
    const dirty = regimeAt(poisoned, at, DEFAULT_REGIME, ENTRY_DELAY_SECONDS);
    if (
      clean.winShare !== dirty.winShare ||
      clean.medianPeakPct !== dirty.medianPeakPct ||
      clean.sampleSize !== dirty.sampleSize ||
      clean.launchRate !== dirty.launchRate
    ) {
      return {
        passed: false,
        detail:
          `at ${new Date(at).toISOString().slice(11, 19)}: clean winShare=${clean.winShare} ` +
          `n=${clean.sampleSize} vs poisoned winShare=${dirty.winShare} n=${dirty.sampleSize}`,
      };
    }
    checked++;
  }
  return { passed: true, detail: `${checked} readings unchanged when future prices are corrupted` };
}

const check = corruptionCheck();
console.log(`lookahead check: ${check.passed ? 'PASS' : 'FAIL'} — ${check.detail}`);
if (!check.passed) {
  console.log('\nRefusing to report: a regime feature that can see the future predicts nothing.');
  process.exit(1);
}

interface Row {
  symbol: string;
  features: RegimeFeatures;
  /** What the exit rule actually returned. */
  traded: number;
  /** What was available with perfect foresight, for context only. */
  ceiling: number;
}

const rows: Row[] = [];
for (const target of launches) {
  const at = target.launchedAt + ENTRY_DELAY_SECONDS * 1000;
  const path = entryPathFromLaunch(target, ENTRY_DELAY_SECONDS);
  const peak = peakWithin(target, ENTRY_DELAY_SECONDS, JUDGE_WITHIN_SECONDS);
  if (!path || !peak) continue;
  const outcome = simulate(path, EXIT);
  if (!Number.isFinite(outcome.pct)) continue;
  rows.push({
    symbol: target.symbol,
    features: regimeAt(launches, at, DEFAULT_REGIME, ENTRY_DELAY_SECONDS),
    traded: outcome.pct,
    ceiling: peak.peakPct,
  });
}

const usable = rows.filter((r) => r.features.winShare !== null);
console.log(`\n${rows.length} launches traded under ${EXIT.label}; ${usable.length} had a regime reading\n`);
if (usable.length < 10) {
  console.log('Too few to say anything. Keep recording.');
  process.exit(0);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const winRate = (xs: number[]) => (xs.filter((x) => x > 0).length / xs.length) * 100;

function report(name: string, value: (r: Row) => number | null) {
  const scored = usable.filter((r) => value(r) !== null);
  if (scored.length < 10) return;
  const cut = median(scored.map((r) => value(r) as number));
  const low = scored.filter((r) => (value(r) as number) <= cut);
  const high = scored.filter((r) => (value(r) as number) > cut);
  if (low.length < 4 || high.length < 4) {
    console.log(`${name.padEnd(20)} no spread to split on (every reading is ${cut.toFixed(2)})`);
    return;
  }
  const fmt = (rs: Row[]) => {
    const t = rs.map((r) => r.traded);
    // Expectancy with the three best trades removed. The previous apparent find in
    // this project survived every other test and died on this one.
    const trimmed = t.length > 3 ? mean([...t].sort((a, b) => b - a).slice(3)) : null;
    return `n=${String(rs.length).padStart(3)} win ${winRate(t).toFixed(0).padStart(3)}% ` +
      `exp ${mean(t).toFixed(1).padStart(6)}% exp-3 ${
        trimmed === null ? '    —' : trimmed.toFixed(1).padStart(6)
      }% med ${median(t).toFixed(1).padStart(6)}%`;
  };
  console.log(`${name.padEnd(20)}cut ${cut.toFixed(2).padStart(7)}  LOW  ${fmt(low)}   HIGH ${fmt(high)}`);
}

console.log(`DOES THE REGIME READING PREDICT WHAT ${EXIT.label} EARNS ON THE NEXT LAUNCH?\n`);
report('launch rate', (r) => r.features.launchRate);
report('recent win share', (r) => r.features.winShare);
report('recent median peak', (r) => r.features.medianPeakPct);

const traded = usable.map((r) => r.traded);
console.log('\nBASELINE — trade every launch, no regime filter');
const baselineTrimmed = mean([...traded].sort((a, b) => b - a).slice(3));
console.log(
  `                    n=${traded.length}  win ${winRate(traded).toFixed(0)}%  ` +
    `exp ${mean(traded).toFixed(1)}%  exp-3 ${baselineTrimmed.toFixed(1)}%  ` +
    `median ${median(traded).toFixed(1)}%`,
);
console.log(
  `\nFor context, the ceiling over the same launches — best price available with\n` +
    `perfect foresight — was a median of ${median(usable.map((r) => r.ceiling)).toFixed(1)}% ` +
    `and ${winRate(usable.map((r) => r.ceiling)).toFixed(0)}% ever positive.\n` +
    `No rule can reach that; it is the bound the rule is competing against.`,
);
console.log(
  '\nA feature earns its place only if its HIGH bucket beats the baseline by more than\n' +
    'the two buckets differ by chance. At these sample sizes that bar is high.',
);
