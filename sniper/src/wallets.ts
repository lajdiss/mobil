import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TradeUpdate } from './pump.js';

interface OpenLot {
  tokens: bigint;
  solIn: number;
  /** When the wallet first bought into this token, for measuring how long it holds. */
  openedAt: number;
}

interface WalletStat {
  /** Realised SOL across completed round trips only. */
  realisedSol: number;
  closed: number;
  wins: number;
  lastSeen: number;
  /**
   * Total and count of holding periods, so the average survives a reload without
   * storing every trade. Optional: files written before this existed have neither.
   */
  holdMsSum?: number;
  holdCount?: number;
}

interface Snapshot {
  version: 1;
  wallets: Record<string, WalletStat>;
}

/**
 * Every wallet on the curve is tracked, which is tens of thousands over a day. Capped
 * and pruned by least-recently-active so memory stays bounded.
 */
const MAX_TRACKED = 20_000;
const PRUNE_TO = 12_000;

/**
 * Scores wallets by what they have actually made on the bonding curve, so the bot can
 * follow buyers with a record instead of guessing which token will run.
 *
 * The honest limit: this only sees pump.fun's curve. Once a token graduates its trading
 * moves to PumpSwap and becomes invisible here, so a wallet that habitually holds
 * through graduation looks worse than it is. Wallets that round-trip on the curve —
 * which is most of them — are measured correctly.
 */
export class WalletTracker {
  private open = new Map<string, Map<string, OpenLot>>();
  private stats = new Map<string, WalletStat>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Snapshot;
      if (parsed.version === 1) {
        for (const [key, stat] of Object.entries(parsed.wallets)) this.stats.set(key, stat);
      }
    } catch {
      // Starting empty is correct when there is nothing to load.
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Only wallets with a closed trade are worth persisting.
      const wallets: Record<string, WalletStat> = {};
      for (const [key, stat] of this.stats) {
        if (stat.closed > 0) wallets[key] = stat;
      }
      writeFileSync(this.path, JSON.stringify({ version: 1, wallets } satisfies Snapshot));
    } catch {
      // Losing the file is not worth interrupting trading over.
    }
  }

  record(trade: TradeUpdate) {
    const wallet = trade.user.toBase58();
    const mint = trade.mint.toBase58();
    const sol = Number(trade.solAmount) / 1e9;
    if (sol <= 0) return;

    let lots = this.open.get(wallet);
    if (!lots) {
      lots = new Map();
      this.open.set(wallet, lots);
    }

    if (trade.isBuy) {
      const lot = lots.get(mint) ?? { tokens: 0n, solIn: 0, openedAt: Date.now() };
      lot.tokens += trade.tokenAmount;
      lot.solIn += sol;
      lots.set(mint, lot);
      return;
    }

    // A sell only counts once there is a matching buy; selling something bought before
    // the bot started watching would otherwise look like pure profit.
    const lot = lots.get(mint);
    if (!lot || lot.tokens <= 0n) return;

    const soldFraction =
      trade.tokenAmount >= lot.tokens ? 1 : Number(trade.tokenAmount) / Number(lot.tokens);
    const costBasis = lot.solIn * soldFraction;
    const profit = sol - costBasis;

    lot.tokens -= trade.tokenAmount >= lot.tokens ? lot.tokens : trade.tokenAmount;
    lot.solIn -= costBasis;
    if (lot.tokens <= 0n) lots.delete(mint);

    const stat = this.stats.get(wallet) ?? { realisedSol: 0, closed: 0, wins: 0, lastSeen: 0 };
    stat.realisedSol += profit;
    stat.closed++;
    if (profit > 0) stat.wins++;
    stat.lastSeen = Date.now();
    // How long this wallet actually held. Every exit setting in this bot has so far
    // been a guess; wallets with thousands of profitable closes are the one source of
    // an answer that is not a guess.
    if (lot.openedAt) {
      stat.holdMsSum = (stat.holdMsSum ?? 0) + (Date.now() - lot.openedAt);
      stat.holdCount = (stat.holdCount ?? 0) + 1;
    }
    this.stats.set(wallet, stat);

    if (this.stats.size > MAX_TRACKED) this.prune();
  }

  private prune() {
    const byAge = [...this.stats.entries()].sort((a, b) => b[1].lastSeen - a[1].lastSeen);
    this.stats = new Map(byAge.slice(0, PRUNE_TO));
    // Open lots for wallets we no longer track are dead weight.
    for (const wallet of this.open.keys()) {
      if (!this.stats.has(wallet)) this.open.delete(wallet);
    }
  }

  /**
   * How long wallets hold, split by whether they actually make money.
   *
   * Every exit setting in this bot started as a guess. These wallets did not guess —
   * the profitable ones have thousands of closed round trips behind their average, and
   * whatever holding period they converged on is an answer drawn from the market
   * rather than from a default. If the winners hold for a minute and the losers hold
   * for ten, that is worth more than any parameter sweep.
   */
  holdingProfile(minClosed: number) {
    const winners: number[] = [];
    const losers: number[] = [];
    for (const stat of this.stats.values()) {
      if (stat.closed < minClosed || !stat.holdCount) continue;
      const avgSeconds = stat.holdMsSum! / stat.holdCount / 1000;
      (stat.realisedSol > 0 ? winners : losers).push(avgSeconds);
    }
    const median = (xs: number[]) => {
      if (xs.length === 0) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    return {
      winners: { wallets: winners.length, medianHoldSeconds: median(winners) },
      losers: { wallets: losers.length, medianHoldSeconds: median(losers) },
    };
  }

  /** True when this wallet has enough of a record to be worth following. */
  isProven(wallet: string, minClosed: number, minRealisedSol: number, minWinRate: number): boolean {
    const stat = this.stats.get(wallet);
    if (!stat || stat.closed < minClosed) return false;
    if (stat.realisedSol < minRealisedSol) return false;
    return stat.wins / stat.closed >= minWinRate;
  }

  stat(wallet: string) {
    return this.stats.get(wallet);
  }

  leaderboard(minClosed: number, limit = 10) {
    return [...this.stats.entries()]
      .filter(([, s]) => s.closed >= minClosed)
      .map(([wallet, s]) => ({
        wallet,
        realisedSol: s.realisedSol,
        closed: s.closed,
        winRatePct: (s.wins / s.closed) * 100,
      }))
      .sort((a, b) => b.realisedSol - a.realisedSol)
      .slice(0, limit);
  }

  /**
   * Counts against the same test that actually triggers a buy. An easier count here
   * would report wallets as qualified that the bot would never follow.
   */
  summary(minClosed: number, minRealisedSol: number, minWinRate: number) {
    let proven = 0;
    for (const [wallet] of this.stats) {
      if (this.isProven(wallet, minClosed, minRealisedSol, minWinRate)) proven++;
    }
    return { tracked: this.stats.size, proven };
  }
}
