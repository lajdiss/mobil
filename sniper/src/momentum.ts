import { PublicKey } from '@solana/web3.js';
import type { DetectedToken } from './detector.js';
import type { TradeUpdate } from './pump.js';

export interface MomentumConfig {
  /** Curve liquidity a token must reach before it is worth entering, in SOL. */
  minLiquiditySol: number;
  /** Distinct buys required — liquidity from a single whale is not interest. */
  minBuys: number;
  /** Past this age a launch is no longer an early entry, just a late one. */
  maxAgeSeconds: number;
  /** Buy share of all trades; below this the token is already being sold into. */
  minBuyRatio: number;
}

interface Candidate {
  token: DetectedToken;
  bornAt: number;
  buys: number;
  sells: number;
  liquiditySol: number;
  entered: boolean;
}

/**
 * An alternative to racing the launch.
 *
 * Sniping is a latency contest that a public RPC cannot win: every measured round
 * showed the entire upside living in the first few hundred milliseconds. This waits
 * instead — a token has to attract real liquidity and repeated buyers before it is
 * worth entering. It gives up the launch pop in exchange for not buying every rug,
 * and crucially it does not care how fast the bot is.
 */
export class MomentumTracker {
  private candidates = new Map<string, Candidate>();

  constructor(
    private readonly config: MomentumConfig,
    private readonly onReady: (token: DetectedToken, liquiditySol: number, buys: number) => void,
  ) {}

  register(token: DetectedToken) {
    this.candidates.set(token.mint.toBase58(), {
      token,
      bornAt: Date.now(),
      buys: 0,
      sells: 0,
      liquiditySol: 0,
      entered: false,
    });
    this.evictStale();
  }

  onTrade(trade: TradeUpdate) {
    const key = trade.mint.toBase58();
    const candidate = this.candidates.get(key);
    if (!candidate || candidate.entered) return;

    if (trade.isBuy) candidate.buys++;
    else candidate.sells++;
    // Virtual reserves start at 30 SOL, so the real deposited amount is the excess.
    candidate.liquiditySol = Math.max(0, Number(trade.virtualQuoteReserves) / 1e9 - 30);

    const ageSeconds = (Date.now() - candidate.bornAt) / 1000;
    if (ageSeconds > this.config.maxAgeSeconds) {
      this.candidates.delete(key);
      return;
    }

    const trades = candidate.buys + candidate.sells;
    const buyRatio = trades > 0 ? candidate.buys / trades : 0;

    if (
      candidate.liquiditySol >= this.config.minLiquiditySol &&
      candidate.buys >= this.config.minBuys &&
      buyRatio >= this.config.minBuyRatio
    ) {
      candidate.entered = true;
      this.candidates.delete(key);
      this.onReady(candidate.token, candidate.liquiditySol, candidate.buys);
    }
  }

  private evictStale() {
    const cutoff = Date.now() - this.config.maxAgeSeconds * 1000;
    for (const [key, candidate] of this.candidates) {
      if (candidate.bornAt < cutoff) this.candidates.delete(key);
    }
  }

  get watching(): number {
    return this.candidates.size;
  }
}

export const mintKey = (mint: PublicKey) => mint.toBase58();
