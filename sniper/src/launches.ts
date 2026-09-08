import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PublicKey } from '@solana/web3.js';
import type { CurveQuote } from './pump.js';

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
    // Finer than this is detail no entry delay or exit rule can act on.
    if (t - last.t < 250) return;
    record.samples.push({
      t,
      vt: curve.virtualTokenReserves.toString(),
      vq: curve.virtualQuoteReserves.toString(),
    });
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
