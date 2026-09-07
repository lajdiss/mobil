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
  solCostForTokens,
  solForTokens,
  type CurveQuote,
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

  /** Total pump.fun take per side, read from chain; 1% until Global has loaded. */
  get feeBps(): number {
    if (!this.globalState) return 100;
    return Number(this.globalState.feeBasisPoints + this.globalState.creatorFeeBasisPoints);
  }

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
    knownCurve?: CurveQuote,
  ): Promise<{ result: TradeResult | null; tokenAmount: bigint; solSpent: number }> {
    // A fresh launch comes with its reserves in the CreateEvent, so the entry path can
    // skip reading the bonding curve entirely. Only fall back when there is no quote.
    let curve: CurveQuote;
    if (knownCurve) {
      curve = knownCurve;
    } else {
      const onChain = await this.getBondingCurve(mint);
      if (!onChain) throw new Error('bonding curve not found');
      if (onChain.complete) throw new Error('bonding curve already complete (migrated)');
      // Last line of defence: selling these fails, never take a position we cannot exit.
      if (onChain.isCashbackCoin) throw new Error('cashback coin — this bot cannot sell it');
      if (onChain.isMayhemMode) throw new Error('mayhem mode coin — not supported');
      curve = onChain;
    }

    const solIn = solToLamports(solAmount);
    // buy takes an exact token amount and caps the SOL, so asking for fewer tokens does
    // not protect against slippage — it just spends less. Ask for the full quote and let
    // maxSolCost absorb any adverse move.
    const tokens = tokensForSol(curve, solIn);
    if (tokens <= 0n) throw new Error('curve returned zero tokens');
    const maxSolCost = (solIn * BigInt(10_000 + this.config.slippageBps)) / 10_000n;
    const expectedCost = solCostForTokens(curve, tokens);

    if (this.config.dryRun) {
      // Charge the same fee the program would, or dry run reports better results than
      // live trading would ever produce — and dry run is what the decision rests on.
      await this.getGlobalState().catch(() => null);
      const withFee = (expectedCost * BigInt(10_000 + this.feeBps)) / 10_000n;
      return { result: null, tokenAmount: tokens, solSpent: lamportsToSol(withFee) };
    }

    const result = await this.sendWithRecipients(async (feeRecipient, buyback) => {
      const params = this.tradeParams(mint, creator, tokenProgram, feeRecipient, buyback);
      return [
        createAtaIdempotentInstruction(this.wallet.publicKey, this.wallet.publicKey, mint, tokenProgram),
        buildBuyInstruction(params, tokens, maxSolCost),
      ];
    }, 'buy');

    // Reading the wallet before and after would be exact, but both reads sit on the
    // entry path where latency decides whether the snipe lands at all. The quote plus
    // the program's own fee is close, and the sell reads the real balance anyway.
    const withFee = (expectedCost * BigInt(10_000 + this.feeBps)) / 10_000n;
    return { result, tokenAmount: tokens, solSpent: lamportsToSol(withFee) };
  }

  /**
   * Distinguishes "the account holds nothing" from "the RPC did not answer". Treating a
   * failed lookup as a zero balance would abandon a position instead of selling it.
   */
  private async getTokenBalance(mint: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    const ata = associatedTokenAddress(this.wallet.publicKey, mint, tokenProgram);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const balance = await this.connection.getTokenAccountBalance(ata, 'confirmed');
        return BigInt(balance.value.amount);
      } catch (err) {
        lastError = err;
        // A missing account is a real zero, not a transport failure.
        if (String(err).includes('could not find account')) return 0n;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    throw new Error(`could not read token balance: ${String(lastError)}`);
  }

  async sell(
    mint: PublicKey,
    creator: PublicKey,
    tokenProgram: PublicKey,
    tokenAmount: bigint,
    knownCurve?: CurveQuote,
  ): Promise<{ result: TradeResult | null; solOut: number; rentReclaimed: boolean }> {
    // The caller usually just read this curve to decide to exit; re-fetching it would
    // add a round trip to the most latency-sensitive path in the bot.
    const curve = knownCurve ?? (await this.getBondingCurve(mint));
    if (!curve) throw new Error('bonding curve not found');

    if (this.config.dryRun) {
      await this.getGlobalState().catch(() => null);
      const gross = solForTokens(curve, tokenAmount);
      const net = (gross * BigInt(10_000 - this.feeBps)) / 10_000n;
      return { result: null, solOut: lamportsToSol(net), rentReclaimed: false };
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
