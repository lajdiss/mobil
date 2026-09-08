import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CurveQuote } from './pump.js';

/**
 * Writes the price path of every position to disk so exit rules can be tested against
 * it later, offline.
 *
 * The reason this exists: every experiment so far cost hours of wall-clock time to
 * evaluate one configuration, and the comparisons were not even paired — a rule that
 * exits faster frees a position slot, so it ends up trading a different set of tokens
 * than the rule it is being compared against. Thirty-one trades against twelve is not
 * a controlled experiment.
 *
 * Recording the path once and replaying rules over it fixes both. Every rule sees the
 * identical trades, and a hundred configurations can be evaluated in seconds instead
 * of a hundred hours. It also survives this environment killing long-running
 * processes, which live rounds do not.
 *
 * Record with the exits switched off — a wide take-profit, a long hold — or the path
 * stops at whatever the recording run's own rules decided, and no replay can invent
 * the part that was never observed.
 */
export interface PathSample {
  /** Milliseconds since the position opened. */
  t: number;
  /** Reserves, so the replay can price any holding rather than just replaying a PnL. */
  vt: string;
  vq: string;
}

export interface CreatorSale {
  t: number;
  /** Sale size as a share of pool liquidity, in basis points. */
  bps: number;
}

export interface RecordedPath {
  mint: string;
  symbol: string;
  venue: string;
  openedAt: number;
  entrySol: number;
  entryTokens: string;
  feeBps: number;
  samples: PathSample[];
  creatorSales: CreatorSale[];
}

export class PathRecorder {
  private open = new Map<string, RecordedPath>();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  begin(entry: Omit<RecordedPath, 'samples' | 'creatorSales'>) {
    this.open.set(entry.mint, { ...entry, samples: [], creatorSales: [] });
  }

  sample(mint: string, curve: CurveQuote) {
    const record = this.open.get(mint);
    if (!record) return;
    const t = Date.now() - record.openedAt;
    const last = record.samples[record.samples.length - 1];
    // The stream fires many times a second on a busy token. Anything finer than this
    // is detail no exit rule can act on, and it makes the files enormous.
    if (last && t - last.t < 250) return;
    record.samples.push({
      t,
      vt: curve.virtualTokenReserves.toString(),
      vq: curve.virtualQuoteReserves.toString(),
    });
  }

  creatorSale(mint: string, bps: number) {
    const record = this.open.get(mint);
    if (!record) return;
    record.creatorSales.push({ t: Date.now() - record.openedAt, bps });
  }

  /** Written on close so a killed process loses at most the positions still open. */
  finish(mint: string) {
    const record = this.open.get(mint);
    if (!record) return;
    this.open.delete(mint);
    if (record.samples.length < 2) return;
    appendFileSync(this.path, JSON.stringify(record) + '\n');
  }

  /**
   * Writes out every path still in progress.
   *
   * Paths are otherwise only written when a position closes, which means a killed
   * process loses everything currently open — and in this environment processes are
   * reclaimed regularly. A truncated path is still worth having: it can score any rule
   * that would have fired inside the span it covers, and the replay reports anything
   * needing longer as path-ended rather than scoring it.
   */
  flushAll() {
    for (const mint of [...this.open.keys()]) this.finish(mint);
  }

  get tracking(): number {
    return this.open.size;
  }
}
