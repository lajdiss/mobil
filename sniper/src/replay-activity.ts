/**
 * Sweeps when to enter against how much trading a token must already have had.
 *
 * These two pull against each other and neither can be chosen alone. Entering earlier
 * keeps more of the move — the ceiling measurements have it collapsing within the
 * first few seconds — but the activity floor needs time to accumulate the trades it
 * counts. A floor of twelve is meaningless at two seconds and most of the market is
 * gone by ninety.
 *
 * The floor itself is the largest single effect measured in this project: on launches
 * entered at 45 seconds, requiring twelve prior trades moved the win rate from 36% to
 * 45% and expectancy from -0.29% to +1.16%. This asks where that trade-off sits.
 *
 *   npm run replay:activity -- data/launches.jsonl
 */
import { readFileSync } from 'node:fs';
import { entryPathFromLaunch, type RecordedLaunch } from './launches.js';
import { rule, simulate, type ExitRule } from './exitrules.js';

const EXIT: ExitRule = rule('TP10 / SL50', {
  takeProfitPct: 10,
  stopLossPct: 50,
  maxHoldSeconds: 180,
});

// Fine around 30s on purpose. The coarse sweep put a positive row there with
// negatives either side, and a one-point spike is what noise looks like — a real
// effect should show as a plateau across neighbouring delays, not a needle.
const DELAYS = [2, 5, 10, 15, 20, 25, 28, 30, 32, 35, 40, 45, 60, 90];
const FLOORS = [0, 3, 5, 8, 12, 20, 30];

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? 'data/launches.jsonl';
const splitHalves = args.includes('--split');
const allLaunches: RecordedLaunch[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as RecordedLaunch)
  .sort((a, b) => a.launchedAt - b.launchedAt);
let launches = allLaunches;

if (launches.length === 0) {
  console.log(`no recorded launches in ${file}`);
  process.exit(1);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const winRate = (xs: number[]) => (xs.filter((x) => x > 0).length / xs.length) * 100;
const minusTop3 = (xs: number[]) =>
  xs.length > 3 ? mean([...xs].sort((a, b) => b - a).slice(3)) : NaN;

/**
 * Trades a token had before a moment, counted from the recording's own samples.
 *
 * A sample only exists because somebody traded, so their density is the activity —
 * and it is available for every launch, not only the ones carrying signal snapshots.
 * Strictly before the entry, so nothing here is knowable only in hindsight.
 */
const tradesBefore = (launch: RecordedLaunch, seconds: number) =>
  launch.samples.filter((s) => s.t <= seconds * 1000).length;

interface Cell {
  n: number;
  kept: number;
  winRate: number;
  expectancy: number;
  minusTop3: number;
  median: number;
}

function cell(delay: number, floor: number): Cell | null {
  const eligible = launches.filter((l) => entryPathFromLaunch(l, delay) !== null);
  const outcomes: number[] = [];
  for (const launch of eligible) {
    if (tradesBefore(launch, delay) < floor) continue;
    const path = entryPathFromLaunch(launch, delay);
    if (!path) continue;
    const result = simulate(path, EXIT);
    if (Number.isFinite(result.pct)) outcomes.push(result.pct);
  }
  if (outcomes.length < 15) return null;
  return {
    n: outcomes.length,
    kept: (outcomes.length / eligible.length) * 100,
    winRate: winRate(outcomes),
    expectancy: mean(outcomes),
    minusTop3: minusTop3(outcomes),
    median: median(outcomes),
  };
}

/**
 * Runs one delay against both halves of the recording.
 *
 * The coarse sweep put a positive row at exactly 30 seconds with negatives either
 * side, which is what an unstable estimate looks like rather than a timing effect —
 * the 28s and 30s samples overlap almost completely (423 launches against 413) and
 * their median entry differs by two seconds, yet they come out with opposite signs.
 * A delay that is genuinely better should be better in both halves of the data.
 */
if (splitHalves) {
  const half = Math.floor(allLaunches.length / 2);
  const halves = [allLaunches.slice(0, half), allLaunches.slice(half)];
  console.log(
    `${allLaunches.length} launches split by time into ${halves[0].length} + ${halves[1].length}\n` +
      `${EXIT.label}, activity floor 12\n`,
  );
  console.log(
    '  wait' + 'FIRST HALF'.padStart(28) + 'SECOND HALF'.padStart(30) + '   same sign?',
  );
  console.log(
    '      ' + 'n'.padStart(6) + 'win%'.padStart(7) + 'exp%'.padStart(8) + 'exp-3'.padStart(8) +
      'n'.padStart(8) + 'win%'.padStart(7) + 'exp%'.padStart(8) + 'exp-3'.padStart(8),
  );
  console.log('  ' + '-'.repeat(76));
  for (const delay of DELAYS) {
    const scored = halves.map((h) => {
      launches = h;
      return cell(delay, 12);
    });
    launches = allLaunches;
    const [a, b] = scored;
    if (!a || !b) {
      console.log(`  ${delay}s`.padEnd(8) + '  (too few in one half)');
      continue;
    }
    const agree = Math.sign(a.expectancy) === Math.sign(b.expectancy);
    console.log(
      `  ${delay}s`.padEnd(6) +
        String(a.n).padStart(6) + a.winRate.toFixed(0).padStart(7) +
        a.expectancy.toFixed(2).padStart(8) + a.minusTop3.toFixed(2).padStart(8) +
        String(b.n).padStart(8) + b.winRate.toFixed(0).padStart(7) +
        b.expectancy.toFixed(2).padStart(8) + b.minusTop3.toFixed(2).padStart(8) +
        (agree ? (a.expectancy > 0 ? '   BOTH +' : '   both -') : '   flips'),
    );
  }
  console.log(
    '\nA delay whose sign flips between halves has not been measured, it has been\n' +
      'sampled. Only "BOTH +" is a candidate, and even that is the minimum bar.',
  );
  console.log(
    `\nAnd the bar is lower than it looks: ${DELAYS.length} delays are being tested, so\n` +
      'some will land positive in both halves by chance alone. A survivor is only\n' +
      'interesting if its neighbours agree — a delay that works while the ones two\n' +
      'seconds either side of it do not is an artifact of which trades fell where.',
  );
  process.exit(0);
}

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`${launches.length} recorded launches, ${EXIT.label}, exit latency ${EXIT.executionDelaySeconds}s`);
console.log('rows = seconds waited after launch, columns = trades required before entering\n');

for (const metric of ['WIN RATE %', 'EXPECTANCY %', 'EXPECTANCY MINUS TOP 3 %', 'KEPT %'] as const) {
  console.log(metric);
  console.log(pad('  wait', 8) + FLOORS.map((f) => `>=${f}`.padStart(9)).join(''));
  console.log('  ' + '-'.repeat(6 + FLOORS.length * 9));
  for (const delay of DELAYS) {
    const cells = FLOORS.map((floor) => {
      const c = cell(delay, floor);
      if (!c) return '—'.padStart(9);
      const value =
        metric === 'WIN RATE %'
          ? c.winRate
          : metric === 'EXPECTANCY %'
            ? c.expectancy
            : metric === 'EXPECTANCY MINUS TOP 3 %'
              ? c.minusTop3
              : c.kept;
      return value.toFixed(metric === 'WIN RATE %' || metric === 'KEPT %' ? 0 : 2).padStart(9);
    });
    console.log(pad(`  ${delay}s`, 8) + cells.join(''));
  }
  console.log('');
}

console.log(
  'A dash means fewer than 15 launches survived that combination — too few to read.\n' +
    'The win-rate grid on its own is the trap: a high floor keeps only the tokens that\n' +
    'were already running, which wins often and loses badly. Read it against the\n' +
    'expectancy grid, and trust neither until the minus-top-3 grid agrees.',
);
