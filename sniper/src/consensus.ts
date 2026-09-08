import { PublicKey } from '@solana/web3.js';
import type { DetectedToken } from './detector.js';
import type { TradeUpdate } from './pump.js';

export interface ConsensusConfig {
  /** Distinct proven wallets that must buy the same token before it counts. */
  minWallets: number;
  /** How long agreement stays agreement, in seconds. */
  windowSeconds: number;
  /** Past this age the launch is no longer what the wallets are reacting to. */
  maxAgeSeconds: number;
}

interface Watch {
  token: DetectedToken;
  bornAt: number;
  /** Wallet -> when it bought, so the window can be applied per wallet. */
  buyers: Map<string, number>;
  entered: boolean;
}

/**
 * Entry on agreement between wallets, rather than on any single wallet's say-so.
 *
 * Copy mode follows the first proven wallet into a token, and two measured rounds said
 * that is not an edge: round 17 came out at +1.36% and its replication at -4.29%. The
 * likeliest reason is that one wallet with a good record is mostly luck surviving a
 * filter — with thousands of wallets tracked, some will look proven by chance, and
 * following them is following noise.
 *
 * Several independent proven wallets buying the same token inside a short window is a
 * different claim. It is much harder to produce by accident, and it is the closest
 * thing available to smart money actually agreeing on something. Whether that survives
 * contact with the data is the open question — the same one every other mode had to
 * answer — but it is a genuinely different signal rather than the same one retuned.
 */
export class ConsensusTracker {
  private watching = new Map<string, Watch>();

  readonly counters = { tracked: 0, entered: 0, bestAgreement: 0 };

  constructor(
    private readonly config: ConsensusConfig,
    private readonly onReady: (token: DetectedToken, wallets: string[]) => void,
  ) {}

  register(token: DetectedToken) {
    this.watching.set(token.mint.toBase58(), {
      token,
      bornAt: Date.now(),
      buyers: new Map(),
      entered: false,
    });
    this.counters.tracked++;
    this.evictStale();
  }

  /**
   * Called only for buys from wallets that already passed the proven filter, so the
   * count here is agreement among wallets with a record — not raw popularity, which
   * every rug has plenty of.
   */
  recordProvenBuy(trade: TradeUpdate) {
    const key = trade.mint.toBase58();
    const watch = this.watching.get(key);
    if (!watch || watch.entered) return;

    const now = Date.now();
    if ((now - watch.bornAt) / 1000 > this.config.maxAgeSeconds) {
      this.watching.delete(key);
      return;
    }

    watch.buyers.set(trade.user.toBase58(), now);

    // Agreement is only agreement if it happens together: wallets that bought longer
    // ago than the window are dropped rather than counted toward a total.
    const cutoff = now - this.config.windowSeconds * 1000;
    for (const [wallet, at] of watch.buyers) {
      if (at < cutoff) watch.buyers.delete(wallet);
    }

    if (watch.buyers.size > this.counters.bestAgreement) {
      this.counters.bestAgreement = watch.buyers.size;
    }
    if (watch.buyers.size < this.config.minWallets) return;

    watch.entered = true;
    this.watching.delete(key);
    this.counters.entered++;
    this.onReady(watch.token, [...watch.buyers.keys()]);
  }

  private evictStale() {
    const cutoff = Date.now() - this.config.maxAgeSeconds * 1000;
    for (const [key, watch] of this.watching) {
      if (watch.bornAt < cutoff) this.watching.delete(key);
    }
  }

  get size(): number {
    return this.watching.size;
  }

  health() {
    return { ...this.counters, watching: this.watching.size };
  }
}

export const mintOf = (mint: PublicKey) => mint.toBase58();
