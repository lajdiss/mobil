import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PublicKey } from '@solana/web3.js';
import type { CurveQuote } from './pump.js';
import type { RecordedPath } from './recorder.js';

/**
 * Records a token's price from the moment it launches, without taking a position.
 *
 * The position recorder answers "which exit rule is best", and on the first real
 * sample it answered it conclusively: nothing. With perfect foresight — selling every
 * path at its own peak — only 3 of 41 tokens ever traded 2% above the entry, which is
 * the same 7.3% the best exit rule already achieved. There was no exit improvement
 * left to find, because the exits were already at the ceiling.
 *
 * The reason is in the timing: 39% of those tokens peaked within five seconds of the
 * entry, meaning the move was over before the bot bought. That makes the entry delay
 * the variable worth sweeping, and it cannot be swept from paths that begin at the
 * entry — they contain no record of what the price did before it.
 *
 * So this records from the launch event instead. One file of launch-relative price
 * series lets the replay construct an entry at any delay and score any exit rule
 * against it, on the same tokens.
 */
export interface LaunchSample {
  /** Milliseconds since the launch event. */
  t: number;
  vt: string;
  vq: string;
  /**
   * Trades since the previous sample, this one included.
   *
   * Samples closer together than the write interval are collapsed to keep the files
   * small, which means sample density understates activity on exactly the tokens where
   * activity matters — the measured rate saturates and a frantic token looks like a
   * merely busy one. Trade rate turned out to be the strongest feature found here, so
   * it is worth counting properly rather than inferring from how often a sample
   * happened to be written.
   */
  n?: number;
}

export interface RecordedLaunch {
  mint: string;
  symbol: string;
  name: string;
  launchedAt: number;
  feeBps: number;
  devBuyPct: number;
  samples: LaunchSample[];
  creatorSales: { t: number; bps: number }[];
  /**
   * Selection signals captured at a fixed moment after the launch, so the replay can
   * test whether they predict anything before any of them gates a real trade. Absent
   * on recordings made before they existed.
   */
  signals?: LaunchSignals;
  /**
   * The same signals taken at several offsets.
   *
   * One offset was not enough. Reading the crowd at 45 seconds means only ever
   * testing an entry at 45 seconds, and the ceiling measurements say the move is
   * usually over well before that — so a single offset conflates "this signal does
   * not work" with "this signal was read too late to act on".
   */
  signalSeries?: LaunchSignals[];
}

export interface LaunchSignals {
  /** Seconds after the launch at which these were taken. */
  atSeconds: number;
  /** From the trade stream: how many different wallets had bought by then. */
  uniqueBuyers?: number;
  buyersPerMinute?: number;
  buyRatio?: number;
  netSolFlow?: number;
  topBuyerShare?: number;
  /** From pump.fun: comment count and socials. Absent when the API did not answer. */
  replyCount?: number;
  repliesPerMinute?: number;
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  isCurrentlyLive?: boolean;
  hypeScore?: number;
  /** True when pump.fun was asked and did not answer — distinct from "no hype". */
  hypeUnavailable?: boolean;
}

export class LaunchRecorder {
  private open = new Map<string, RecordedLaunch>();

  constructor(
    private readonly path: string,
    /** How long to follow each launch before writing it out, in seconds. */
    private readonly windowSeconds: number,
    private readonly feeBps: number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  begin(mint: PublicKey, symbol: string, name: string, devBuyPct: number, curve: CurveQuote) {
    const key = mint.toBase58();
    if (this.open.has(key)) return;
    this.open.set(key, {
      mint: key,
      symbol,
      name,
      launchedAt: Date.now(),
      feeBps: this.feeBps,
      devBuyPct,
      // The launch event's own reserves are t=0: the price before anyone traded it.
      samples: [{ t: 0, vt: curve.virtualTokenReserves.toString(), vq: curve.virtualQuoteReserves.toString() }],
      creatorSales: [],
    });
  }

  sample(mint: PublicKey, curve: CurveQuote) {
    const record = this.open.get(mint.toBase58());
    if (!record) return;
    const t = Date.now() - record.launchedAt;
    const last = record.samples[record.samples.length - 1];
    // Collapsed samples still count toward the trade tally, so the rate stays exact
    // even where the price series is thinned.
    if (t - last.t < 250) {
      last.n = (last.n ?? 1) + 1;
      return;
    }
    record.samples.push({
      t,
      vt: curve.virtualTokenReserves.toString(),
      vq: curve.virtualQuoteReserves.toString(),
      n: 1,
    });
  }

  /** Attaches one reading to a launch still being followed. */
  attachSignals(mint: PublicKey, signals: LaunchSignals) {
    const record = this.open.get(mint.toBase58());
    if (!record) return;
    (record.signalSeries ??= []).push(signals);
    // The single-offset field stays populated with the first reading so recordings
    // remain readable by anything written before the series existed.
    record.signals ??= signals;
  }

  creatorSale(mint: PublicKey, bps: number) {
    const record = this.open.get(mint.toBase58());
    if (!record) return;
    record.creatorSales.push({ t: Date.now() - record.launchedAt, bps });
  }

  /** Writes out launches past their window; call on a timer. */
  sweep() {
    const cutoff = Date.now() - this.windowSeconds * 1000;
    for (const [key, record] of this.open) {
      if (record.launchedAt > cutoff) continue;
      this.open.delete(key);
      // A launch nobody traded carries no information about entering it.
      if (record.samples.length >= 4) appendFileSync(this.path, JSON.stringify(record) + '\n');
    }
  }

  flushAll() {
    for (const [key, record] of this.open) {
      this.open.delete(key);
      if (record.samples.length >= 4) appendFileSync(this.path, JSON.stringify(record) + '\n');
    }
  }

  get tracking(): number {
    return this.open.size;
  }
}

const solForTokens = (vt: bigint, vq: bigint, tokens: bigint) =>
  tokens <= 0n ? 0n : (tokens * vq) / (vt + tokens);
const tokensForSol = (vt: bigint, vq: bigint, sol: bigint) =>
  sol <= 0n ? 0n : (sol * vt) / (vq + sol);

/** Matches the live runs, so replayed sizes and fees are the ones actually traded. */
export const REPLAY_BUY_LAMPORTS = 50_000_000n;

/**
 * The path a buyer entering `delaySeconds` after the launch would have seen.
 *
 * Returns null when the recording does not reach that far, rather than entering at the
 * last sample it has — scoring a delay against a launch that ended before it would
 * quietly bias every result toward longer delays.
 */
export function entryPathFromLaunch(
  launch: RecordedLaunch,
  delaySeconds: number,
): RecordedPath | null {
  const entryIndex = launch.samples.findIndex((s) => s.t >= delaySeconds * 1000);
  if (entryIndex === -1) return null;
  const after = launch.samples.slice(entryIndex);
  // One sample is a price, not a path; there is nothing for an exit rule to act on.
  if (after.length < 2) return null;

  const entry = after[0];
  const vt = BigInt(entry.vt);
  const vq = BigInt(entry.vq);
  // A curve quoted in something other than SOL reports zero SOL reserves, and every
  // price here divides by them — it would produce NaN rather than an error.
  if (vt <= 0n || vq <= 0n) return null;

  const tokens = tokensForSol(vt, vq, REPLAY_BUY_LAMPORTS);
  if (tokens <= 0n) return null;
  const costLamports = Number(solForTokens(vt, vq, tokens)) * ((1e4 + launch.feeBps) / 1e4);
  if (costLamports <= 0) return null;

  return {
    mint: launch.mint,
    symbol: launch.symbol,
    venue: 'pump',
    openedAt: launch.launchedAt + entry.t,
    entrySol: costLamports / 1e9,
    entryTokens: tokens.toString(),
    feeBps: launch.feeBps,
    samples: after.map((s) => ({ t: s.t - entry.t, vt: s.vt, vq: s.vq })),
    creatorSales: launch.creatorSales
      .filter((c) => c.t >= entry.t)
      .map((c) => ({ t: c.t - entry.t, bps: c.bps })),
  };
}
