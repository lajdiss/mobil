import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Config } from './config.js';
import {
  associatedTokenAddress,
  buildBuyInstruction,
  buildCloseAccountInstruction,
  buildSellInstruction,
  createAtaIdempotentInstruction,
  decodeBondingCurve,
  decodeGlobal,
  feeRecipientCandidates,
  bondingCurvePda,
  globalPda,
  solForTokens,
  tokensForSol,
  type BondingCurve,
  type GlobalState,
  type TradeParams,
} from './pump.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const solToLamports = (sol: number) => BigInt(Math.round(sol * LAMPORTS_PER_SOL));
export const lamportsToSol = (lamports: bigint) => Number(lamports) / LAMPORTS_PER_SOL;

export interface TradeResult {
  signature: string;
  solDelta: number;
  tokenDelta: bigint;
}

export class Executor {
  private globalState: GlobalState | null = null;
  private globalFetchedAt = 0;

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Keypair,
    private readonly config: Config,
  ) {}

  /** Cached because the fee recipient lists change rarely but are needed on every trade. */
  private async getGlobalState(): Promise<GlobalState> {
    const age = Date.now() - this.globalFetchedAt;
    if (this.globalState && age < 5 * 60_000) return this.globalState;
    const info = await this.connection.getAccountInfo(globalPda());
    if (!info) throw new Error('pump.fun global account not found');
    this.globalState = decodeGlobal(info.data);
    this.globalFetchedAt = Date.now();
    return this.globalState;
  }

  async getBondingCurve(mint: PublicKey): Promise<BondingCurve | null> {
    const info = await this.connection.getAccountInfo(bondingCurvePda(mint));
    return info ? decodeBondingCurve(info.data) : null;
  }

  /** One request for every open position, so polling stays cheap on a free RPC. */
  async getBondingCurves(mints: PublicKey[]): Promise<Map<string, BondingCurve>> {
    const out = new Map<string, BondingCurve>();
    if (mints.length === 0) return out;

    for (let i = 0; i < mints.length; i += 100) {
      const batch = mints.slice(i, i + 100);
      const infos = await this.connection.getMultipleAccountsInfo(
        batch.map(bondingCurvePda),
        'processed',
      );
      infos.forEach((info, index) => {
        if (!info) return;
        try {
          out.set(batch[index].toBase58(), decodeBondingCurve(info.data));
        } catch {
          // A malformed account is not worth aborting the whole poll for.
        }
      });
    }
    return out;
  }

  /**
   * Kept warm in the background: fetching a blockhash on the exit path adds a round
   * trip at the exact moment latency costs the most.
   */
  private cachedBlockhash: { blockhash: string; lastValidBlockHeight: number; at: number } | null =
    null;

  private async getBlockhash() {
    const cached = this.cachedBlockhash;
    if (cached && Date.now() - cached.at < 15_000) return cached;
    const fresh = await this.connection.getLatestBlockhash('confirmed');
    this.cachedBlockhash = { ...fresh, at: Date.now() };
    return this.cachedBlockhash;
  }

  async refreshBlockhash() {
    try {
      const fresh = await this.connection.getLatestBlockhash('confirmed');
      this.cachedBlockhash = { ...fresh, at: Date.now() };
    } catch {
      // Keep the old one; getBlockhash falls back to fetching on demand.
    }
  }

  private tradeParams(
    mint: PublicKey,
    creator: PublicKey,
    tokenProgram: PublicKey,
    feeRecipient: PublicKey,
    buybackFeeRecipient: PublicKey,
  ): TradeParams {
    return {
      mint,
      user: this.wallet.publicKey,
      creator,
      tokenProgram,
      feeRecipient,
      buybackFeeRecipient,
    };
  }

  /**
   * pump.fun rotates which fee and buyback recipients it accepts, and a stale pick is
   * rejected with NotAuthorized. Retry across both lists; any other error is a real
   * problem with the trade and aborts immediately.
   */
  private async sendWithRecipients(
    build: (
      feeRecipient: PublicKey,
      buybackFeeRecipient: PublicKey,
    ) => Promise<ReturnType<typeof buildBuyInstruction>[]>,
    label: string,
  ): Promise<TradeResult> {
    const global = await this.getGlobalState();
    const feeRecipients = feeRecipientCandidates(global);
    const buybacks = global.buybackFeeRecipients;
    const attempts = Math.min(Math.max(feeRecipients.length, buybacks.length), 8);
    let lastError: Error | null = null;

    for (let i = 0; i < attempts; i++) {
      const instructions = await build(
        feeRecipients[i % feeRecipients.length],
        buybacks[i % buybacks.length],
      );
      try {
        return await this.sendAndConfirm(instructions, label);
      } catch (err) {
        lastError = err as Error;
        if (!lastError.message.includes('NotAuthorized')) throw lastError;
      }
    }
    throw lastError ?? new Error(`${label}: no authorized fee recipient`);
  }

  private async sendAndConfirm(
    instructions: ReturnType<typeof buildBuyInstruction>[],
    label: string,
  ): Promise<TradeResult> {
    const { blockhash, lastValidBlockHeight } = await this.getBlockhash();
    const message = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.config.priorityFeeMicroLamports,
        }),
        ...instructions,
      ],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);

    // Simulating first turns a silent on-chain failure (which still costs the fee)
    // into a local error we can log and skip.
    const sim = await this.connection.simulateTransaction(tx, { commitment: 'processed' });
    if (sim.value.err) {
      const anchorError = (sim.value.logs || []).find((l) => l.includes('AnchorError'));
      throw new Error(
        `${label} simulation failed: ${JSON.stringify(sim.value.err)}${
          anchorError ? ` — ${anchorError}` : ''
        }`,
      );
    }

    tx.sign([this.wallet]);
    const signature = await this.connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 2,
    });
    const confirmation = await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (confirmation.value.err) {
      throw new Error(`${label} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }
    return { signature, solDelta: 0, tokenDelta: 0n };
  }

  async buy(
    mint: PublicKey,
    creator: PublicKey,
    tokenProgram: PublicKey,
    solAmount: number,
  ): Promise<{ result: TradeResult | null; tokenAmount: bigint; solSpent: number }> {
    const curve = await this.getBondingCurve(mint);
    if (!curve) throw new Error('bonding curve not found');
    if (curve.complete) throw new Error('bonding curve already complete (migrated)');
    // Last line of defence: selling these fails, so never take a position we cannot exit.
    if (curve.isCashbackCoin) throw new Error('cashback coin — this bot cannot sell it');
    if (curve.isMayhemMode) throw new Error('mayhem mode coin — not supported');

    const solIn = solToLamports(solAmount);
    const expectedTokens = tokensForSol(curve, solIn);
    if (expectedTokens <= 0n) throw new Error('curve returned zero tokens');

    // Ask for fewer tokens than quoted so front-running does not fail the whole buy.
    const minTokens = (expectedTokens * BigInt(10_000 - this.config.slippageBps)) / 10_000n;
    const maxSolCost = (solIn * BigInt(10_000 + this.config.slippageBps)) / 10_000n;

    if (this.config.dryRun) {
      return { result: null, tokenAmount: minTokens, solSpent: solAmount };
    }

    const result = await this.sendWithRecipients(async (feeRecipient, buyback) => {
      const params = this.tradeParams(mint, creator, tokenProgram, feeRecipient, buyback);
      return [
        createAtaIdempotentInstruction(this.wallet.publicKey, this.wallet.publicKey, mint, tokenProgram),
        buildBuyInstruction(params, minTokens, maxSolCost),
      ];
    }, 'buy');
    return { result, tokenAmount: minTokens, solSpent: solAmount };
  }

  /** The real balance, not what we think we bought — buys can fill above the minimum. */
  private async getTokenBalance(mint: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    const ata = associatedTokenAddress(this.wallet.publicKey, mint, tokenProgram);
    const balance = await this.connection.getTokenAccountBalance(ata).catch(() => null);
    return balance ? BigInt(balance.value.amount) : 0n;
  }

  async sell(
    mint: PublicKey,
    creator: PublicKey,
    tokenProgram: PublicKey,
    tokenAmount: bigint,
    knownCurve?: BondingCurve,
  ): Promise<{ result: TradeResult | null; solOut: number; rentReclaimed: boolean }> {
    // The caller usually just read this curve to decide to exit; re-fetching it would
    // add a round trip to the most latency-sensitive path in the bot.
    const curve = knownCurve ?? (await this.getBondingCurve(mint));
    if (!curve) throw new Error('bonding curve not found');

    if (this.config.dryRun) {
      return {
        result: null,
        solOut: lamportsToSol(solForTokens(curve, tokenAmount)),
        rentReclaimed: false,
      };
    }

    const held = await this.getTokenBalance(mint, tokenProgram);
    if (held <= 0n) throw new Error('no tokens held to sell');

    const expectedSol = solForTokens(curve, held);
    const minSolOutput = (expectedSol * BigInt(10_000 - this.config.slippageBps)) / 10_000n;

    const result = await this.sendWithRecipients(async (feeRecipient, buyback) => {
      const params = this.tradeParams(mint, creator, tokenProgram, feeRecipient, buyback);
      return [buildSellInstruction(params, held, minSolOutput)];
    }, 'sell');

    const rentReclaimed = await this.closeTokenAccount(mint, tokenProgram);
    return { result, solOut: lamportsToSol(expectedSol), rentReclaimed };
  }

  /**
   * Reclaims the token account rent in its own transaction, deliberately not bundled
   * with the sell: closing fails if any dust remains, and that must never be able to
   * take an exit down with it. Best effort — a failure here costs rent, not the trade.
   */
  private async closeTokenAccount(mint: PublicKey, tokenProgram: PublicKey): Promise<boolean> {
    try {
      if ((await this.getTokenBalance(mint, tokenProgram)) > 0n) return false;
      await this.sendAndConfirm(
        [buildCloseAccountInstruction(this.wallet.publicKey, mint, tokenProgram)],
        'close token account',
      );
      return true;
    } catch {
      return false;
    }
  }

  async getBalanceSol(): Promise<number> {
    const lamports = await this.connection.getBalance(this.wallet.publicKey, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  }
}
