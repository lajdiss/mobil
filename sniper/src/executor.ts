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
  buildBuyInstruction,
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
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
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

  async sell(
    mint: PublicKey,
    creator: PublicKey,
    tokenProgram: PublicKey,
    tokenAmount: bigint,
  ): Promise<{ result: TradeResult | null; solOut: number }> {
    const curve = await this.getBondingCurve(mint);
    if (!curve) throw new Error('bonding curve not found');

    const expectedSol = solForTokens(curve, tokenAmount);
    const minSolOutput = (expectedSol * BigInt(10_000 - this.config.slippageBps)) / 10_000n;

    if (this.config.dryRun) {
      return { result: null, solOut: lamportsToSol(expectedSol) };
    }

    const result = await this.sendWithRecipients(async (feeRecipient, buyback) => {
      const params = this.tradeParams(mint, creator, tokenProgram, feeRecipient, buyback);
      return [buildSellInstruction(params, tokenAmount, minSolOutput)];
    }, 'sell');
    return { result, solOut: lamportsToSol(expectedSol) };
  }

  async getBalanceSol(): Promise<number> {
    const lamports = await this.connection.getBalance(this.wallet.publicKey, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  }
}
