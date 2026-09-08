import type { RecordedLaunch } from './launches.js';

/**
 * Measures what the market has been doing lately, from launches that have already
 * finished being observed.
 *
 * Splitting the recordings in half produced the finding this exists for: the first
 * half returned a 9.3% win rate and a loss under every exit rule, the second returned
 * 53.5% and a profit under almost all of them, and no rule held across both. The win
 * rate was a property of the window the bot traded in, not of the rule it traded with.
 * If that is right, the lever is not a better rule but knowing which window you are in.
 *
 * Every feature here is strictly backward-looking, and deliberately so. A regime
 * feature is trivial to compute with lookahead and worthless with it: judging a launch
 * needs its first `observationSeconds`, so at time T only launches that started at
 * least that long before T can contribute. Anything else is reading the answer.
 */
export interface RegimeFeatures {
  /** Launches started in the last `rateWindowSeconds`. Known immediately. */
  launchRate: number;
  /** Share of recently finished launches whose price rose at all. 0-1, or null. */
  winShare: number | null;
  /** Median peak return of those launches, in percent, or null when too few. */
  medianPeakPct: number | null;
  /** How many finished launches the two figures above are based on. */
  sampleSize: number;
}

export interface RegimeConfig {
  /** How long a launch must be observable before it can inform anything. */
  observationSeconds: number;
  /** How far back to look for finished launches. */
  lookbackSeconds: number;
  /** Window for the raw launch rate, which needs no observation lag. */
  rateWindowSeconds: number;
  /** Minimum finished launches before winShare and medianPeakPct mean anything. */
  minSample: number;
}

export const DEFAULT_REGIME: RegimeConfig = {
  observationSeconds: 120,
  lookbackSeconds: 600,
  rateWindowSeconds: 300,
  minSample: 5,
};

const solForTokens = (vt: bigint, vq: bigint, tokens: bigint) =>
  tokens <= 0n ? 0n : (tokens * vq) / (vt + tokens);
const tokensForSol = (vt: bigint, vq: bigint, sol: bigint) =>
  sol <= 0n ? 0n : (sol * vt) / (vq + sol);

const BUY_LAMPORTS = 50_000_000n;

/**
 * Best return a buyer entering `delaySeconds` after this launch could have had, using
 * only the launch's first `withinSeconds` of holding. Null when the recording cannot
 * answer.
 *
 * Returns the timestamp of the last sample it actually read, so a caller can prove it
 * did not consult a price from after the moment it is reasoning about. That is not
 * decoration: the first version of this was allowed to run 5 seconds past its own
 * eligibility window, and the lookahead check missed it because both sides of the
 * comparison shared the fault.
 */
export function peakWithin(
  launch: RecordedLaunch,
  delaySeconds: number,
  withinSeconds: number,
): { peakPct: number; lastSampleMs: number } | null {
  const entryIndex = launch.samples.findIndex((s) => s.t >= delaySeconds * 1000);
  if (entryIndex === -1) return null;
  const entry = launch.samples[entryIndex];
  const vt = BigInt(entry.vt);
  const vq = BigInt(entry.vq);
  if (vt <= 0n || vq <= 0n) return null;

  const tokens = tokensForSol(vt, vq, BUY_LAMPORTS);
  if (tokens <= 0n) return null;
  const cost = (Number(solForTokens(vt, vq, tokens)) / 1e9) * ((1e4 + launch.feeBps) / 1e4);
  if (cost <= 0) return null;

  const fee = (1e4 - launch.feeBps) / 1e4;
  const cutoff = (delaySeconds + withinSeconds) * 1000;
  let best = -Infinity;
  let lastSampleMs = entry.t;
  for (const sample of launch.samples) {
    if (sample.t < entry.t || sample.t > cutoff) continue;
    const value = (Number(solForTokens(BigInt(sample.vt), BigInt(sample.vq), tokens)) / 1e9) * fee;
    best = Math.max(best, ((value - cost) / cost) * 100);
    lastSampleMs = Math.max(lastSampleMs, sample.t);
  }
  return Number.isFinite(best) ? { peakPct: best, lastSampleMs } : null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Features as of `at`, from `history` only. `history` must be sorted by launchedAt.
 *
 * The observation lag is the whole safety property: a launch contributes only once
 * `at` is past its launch plus the observation window, so nothing in the result
 * depends on a price that had not happened yet.
 */
export function regimeAt(
  history: RecordedLaunch[],
  at: number,
  config: RegimeConfig = DEFAULT_REGIME,
  entryDelaySeconds = 5,
): RegimeFeatures {
  const observationMs = config.observationSeconds * 1000;
  const finished: number[] = [];
  let launchRate = 0;

  for (const launch of history) {
    if (launch.launchedAt >= at) break; // sorted; nothing later can qualify
    if (at - launch.launchedAt <= config.rateWindowSeconds * 1000) launchRate++;

    // Judging a launch reads its prices from the entry delay through the observation
    // window, so it is only usable once `at` is past the END of that span — not past
    // its start. Getting this wrong by the entry delay alone was enough to leak the
    // future into every reading.
    const judgeableAt = launch.launchedAt + entryDelaySeconds * 1000 + observationMs;
    if (judgeableAt > at) continue;
    if (at - launch.launchedAt > config.lookbackSeconds * 1000) continue;

    const peak = peakWithin(launch, entryDelaySeconds, config.observationSeconds);
    if (peak === null) continue;
    // Belt and braces: the sample this actually read must predate `at`.
    if (launch.launchedAt + peak.lastSampleMs > at) continue;
    finished.push(peak.peakPct);
  }

  const enough = finished.length >= config.minSample;
  return {
    launchRate,
    winShare: enough ? finished.filter((p) => p > 2).length / finished.length : null,
    medianPeakPct: enough ? median(finished) : null,
    sampleSize: finished.length,
  };
}
