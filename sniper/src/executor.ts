import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';
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
  TOKEN_PROGRAM,
} from './pump.js';
import {
  ataFor,
  buildSwapBuyInstruction,
  buildSwapSellInstruction,
  buildUnwrapSolInstruction,
  buildWrapSolInstructions,
  decodePool,
  decodeSwapGlobalConfig,
  graduatedPoolPda,
  poolQuote,
  swapFeeBps,
  swapFeeRecipientCandidates,
  swapGlobalConfigPda,
  tokenProgramFromOwner,
  WSOL_MINT,
  type SwapGlobalConfig,
  type SwapPool,
} from './pumpswap.js';

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
    private readonly metrics?: Metrics,
  ) {}

  /** Every network call goes through here so RPC latency is measured, not guessed. */
  private rpc<T>(fn: () => Promise<T>): Promise<T> {
    return this.metrics ? this.metrics.timeRpc(fn) : fn();
  }

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

  /**
   * Which token program owns a mint. Launch events carry this, but a token picked up
   * later — by age or by a scan — has no launch event to read it from, and guessing
   * wrong builds an instruction against the wrong program.
   */
  async getMintTokenProgram(mint: PublicKey): Promise<PublicKey | null> {
    const info = await this.rpc(() => this.connection.getAccountInfo(mint, 'processed'));
    return info ? tokenProgramFromOwner(info.owner) : null;
  }

  async getBondingCurve(mint: PublicKey): Promise<BondingCurve | null> {
    const info = await this.rpc(() => this.connection.getAccountInfo(bondingCurvePda(mint)));
    return info ? decodeBondingCurve(info.data) : null;
  }

  /** One request for every open position, so polling stays cheap on a free RPC. */
  async getBondingCurves(mints: PublicKey[]): Promise<Map<string, BondingCurve>> {
    const out = new Map<string, BondingCurve>();
    if (mints.length === 0) return out;

    for (let i = 0; i < mints.length; i += 100) {
      const batch = mints.slice(i, i + 100);
      const infos = await this.rpc(() =>
        this.connection.getMultipleAccountsInfo(batch.map(bondingCurvePda), 'processed'),
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
    // All of them; a cap here silently makes the last candidates unreachable.
    const attempts = Math.max(feeRecipients.length, buybacks.length);
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

    // Simulating first turns a silent on-chain failure (which still costs the fee) into
    // a local error we can log and skip. It also costs a full RPC round trip on the
    // entry path, measured here at 44ms median and 195ms at p95 — which on a launch is
    // the difference between landing and not. Kept on by default; the trade is the
    // caller's to make, not one to take silently for speed.
    if (this.config.simulateBeforeSend) {
      const sim = await this.rpc(() =>
        this.connection.simulateTransaction(tx, { commitment: 'processed' }),
      );
      if (sim.value.err) {
        const anchorError = (sim.value.logs || []).find((l) => l.includes('AnchorError'));
        throw new Error(
          `${label} simulation failed: ${JSON.stringify(sim.value.err)}${
            anchorError ? ` — ${anchorError}` : ''
          }`,
        );
      }
    }

    tx.sign([this.wallet]);
    const signature = await this.rpc(() =>
      this.connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 2 }),
    );
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

  /**
   * Sells `tokenAmount`, or the whole balance when that is smaller. A scale-out passes
   * less than it holds, and the token account is then left open on purpose — closing
   * it needs a zero balance, and the remainder is the whole point of a partial.
   */
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
    const toSell = tokenAmount > 0n && tokenAmount < held ? tokenAmount : held;

    const expectedSol = solForTokens(curve, toSell);
    const minSolOutput = (expectedSol * BigInt(10_000 - this.config.slippageBps)) / 10_000n;

    const result = await this.sendWithRecipients(async (feeRecipient, buyback) => {
      const params = this.tradeParams(mint, creator, tokenProgram, feeRecipient, buyback);
      return [buildSellInstruction(params, toSell, minSolOutput)];
    }, 'sell');

    const rentReclaimed =
      toSell === held ? await this.closeTokenAccount(mint, tokenProgram) : false;
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

  // --- pump.fun AMM (post-graduation) ---------------------------------------

  private swapConfig: SwapGlobalConfig | null = null;
  private swapConfigFetchedAt = 0;

  /** Total AMM take per side: lp plus protocol plus the coin creator's cut. */
  get swapFeeBpsValue(): number {
    return this.swapConfig ? swapFeeBps(this.swapConfig) : 30;
  }

  private async getSwapConfig(): Promise<SwapGlobalConfig> {
    const age = Date.now() - this.swapConfigFetchedAt;
    if (this.swapConfig && age < 5 * 60_000) return this.swapConfig;
    const info = await this.connection.getAccountInfo(swapGlobalConfigPda());
    if (!info) throw new Error('pump AMM global config not found');
    this.swapConfig = decodeSwapGlobalConfig(info.data);
    this.swapConfigFetchedAt = Date.now();
    return this.swapConfig;
  }

  /**
   * A graduated pool, its token program and both reserves in a single round trip.
   *
   * The pool address derives from the mint alone, and the vaults are the pool's own
   * associated token accounts, so every address here is computed locally and the four
   * candidates go out together. The vault the pool account names still has to match
   * the one derived from the mint's token program: if they disagree, something about
   * the pool is not what this code assumes and it refuses to trade rather than guess.
   */
  async getSwapPool(
    baseMint: PublicKey,
  ): Promise<{ pool: SwapPool; baseTokenProgram: PublicKey; quote: CurveQuote } | null> {
    const address = graduatedPoolPda(baseMint);
    const quoteVault = ataFor(address, WSOL_MINT, TOKEN_PROGRAM);
    const infos = await this.rpc(() =>
      this.connection.getMultipleAccountsInfo(
        [address, baseMint, quoteVault, ataFor(address, baseMint, TOKEN_PROGRAM)],
        'processed',
      ),
    );
    const [poolInfo, mintInfo, quoteInfo] = infos;
    if (!poolInfo || !mintInfo || !quoteInfo) return null;

    const pool = decodePool(address, poolInfo.data);
    if (!pool) return null;
    // Not knowing which token program owns the mint is a reason to leave the token
    // alone, not to assume classic SPL and build the wrong instruction.
    const baseTokenProgram = tokenProgramFromOwner(mintInfo.owner);
    if (!baseTokenProgram) return null;
    const baseVault = ataFor(address, baseMint, baseTokenProgram);
    if (!pool.poolBaseTokenAccount.equals(baseVault)) {
      throw new Error('pool base vault is not the derived associated account');
    }

    // The classic-SPL candidate went out with the batch, so a Token-2022 mint needs
    // one more read and a classic one needs none.
    const baseInfo = baseTokenProgram.equals(TOKEN_PROGRAM)
      ? infos[3]
      : (await this.rpc(() => this.connection.getMultipleAccountsInfo([baseVault], 'processed')))[0];
    if (!baseInfo) return null;

    return {
      pool,
      baseTokenProgram,
      quote: poolQuote(baseInfo.data.readBigUInt64LE(64), quoteInfo.data.readBigUInt64LE(64)),
    };
  }

  /**
   * Same rotation problem as the bonding curve: the AMM keeps eight protocol fee
   * recipients and eight buyback recipients, and a stale pick is rejected outright.
   */
  private async sendWithSwapRecipients(
    build: (
      protocolFeeRecipient: PublicKey,
      buybackFeeRecipient: PublicKey,
    ) => ReturnType<typeof buildSwapBuyInstruction>[],
    label: string,
  ): Promise<TradeResult> {
    const config = await this.getSwapConfig();
    const recipients = swapFeeRecipientCandidates(config);
    const buybacks = config.buybackFeeRecipients;
    // Every candidate, not the first eight. The cap used to be 8 while the list holds
    // nine — eight protocol recipients plus the reserved one — so the reserved
    // recipient was never reached. Mayhem pools require exactly that one, which made
    // them look untradeable: the rotation exhausted itself and reported "no authorized
    // fee recipient" while never having tried the one that works.
    const attempts = Math.max(recipients.length, buybacks.length);
    let lastError: Error | null = null;

    for (let i = 0; i < attempts; i++) {
      const instructions = build(
        recipients[i % recipients.length],
        buybacks[i % buybacks.length],
      );
      try {
        return await this.sendAndConfirm(instructions, label);
      } catch (err) {
        lastError = err as Error;
        // Two ways the AMM says "not that one": a stale buyback recipient and a
        // protocol recipient it no longer accepts. Both mean try the next pair.
        if (
          !lastError.message.includes('NotAuthorized') &&
          !lastError.message.includes('InvalidProtocolFeeRecipient')
        ) {
          throw lastError;
        }
      }
    }
    throw lastError ?? new Error(`${label}: no authorized fee recipient`);
  }

  async buySwap(
    pool: SwapPool,
    baseTokenProgram: PublicKey,
    quote: CurveQuote,
    solAmount: number,
  ): Promise<{ result: TradeResult | null; tokenAmount: bigint; solSpent: number }> {
    if (pool.isCashbackCoin) throw new Error('cashback coin — this bot cannot sell it');
    // Mayhem pools are traded, not skipped. Two live ones simulate a clean buy and
    // sell once the recipient rotation actually reaches the reserved recipient they
    // require — which it did not, before the cap above was removed.

    const solIn = solToLamports(solAmount);
    const tokens = tokensForSol(quote, solIn);
    if (tokens <= 0n) throw new Error('pool returned zero tokens');
    const expectedCost = solCostForTokens(quote, tokens);
    const maxQuoteIn = (solIn * BigInt(10_000 + this.config.slippageBps)) / 10_000n;

    await this.getSwapConfig().catch(() => null);
    const withFee = (expectedCost * BigInt(10_000 + this.swapFeeBpsValue)) / 10_000n;
    if (this.config.dryRun) {
      return { result: null, tokenAmount: tokens, solSpent: lamportsToSol(withFee) };
    }

    const result = await this.sendWithSwapRecipients(
      (protocolFeeRecipient, buybackFeeRecipient) => [
        // Wrap the slippage cap rather than the quote: the program pulls what the
        // trade actually costs and the unwrap at the end returns the difference.
        ...buildWrapSolInstructions(this.wallet.publicKey, maxQuoteIn),
        createAtaIdempotentInstruction(
          this.wallet.publicKey,
          this.wallet.publicKey,
          pool.baseMint,
          baseTokenProgram,
        ),
        buildSwapBuyInstruction(
          {
            pool,
            user: this.wallet.publicKey,
            baseTokenProgram,
            protocolFeeRecipient,
            buybackFeeRecipient,
          },
          tokens,
          maxQuoteIn,
        ),
        // In the same transaction on purpose: an unwrap that could fail separately
        // would leave the wallet's SOL sitting in a token account.
        buildUnwrapSolInstruction(this.wallet.publicKey),
      ],
      'AMM buy',
    );

    return { result, tokenAmount: tokens, solSpent: lamportsToSol(withFee) };
  }

  async sellSwap(
    pool: SwapPool,
    baseTokenProgram: PublicKey,
    quote: CurveQuote,
    tokenAmount: bigint,
  ): Promise<{ result: TradeResult | null; solOut: number; rentReclaimed: boolean }> {
    const gross = solForTokens(quote, tokenAmount);
    const net = (gross * BigInt(10_000 - this.swapFeeBpsValue)) / 10_000n;

    if (this.config.dryRun) {
      await this.getSwapConfig().catch(() => null);
      return { result: null, solOut: lamportsToSol(net), rentReclaimed: false };
    }

    const held = await this.getTokenBalance(pool.baseMint, baseTokenProgram);
    if (held <= 0n) throw new Error('no tokens held to sell');
    const toSell = tokenAmount > 0n && tokenAmount < held ? tokenAmount : held;

    const expected = solForTokens(quote, toSell);
    const minQuoteOut = (expected * BigInt(10_000 - this.config.slippageBps)) / 10_000n;

    const result = await this.sendWithSwapRecipients(
      (protocolFeeRecipient, buybackFeeRecipient) => [
        // Created empty: the AMM pays the proceeds into this account, and the close
        // at the end is what turns them back into spendable SOL.
        ...buildWrapSolInstructions(this.wallet.publicKey, 0n),
        buildSwapSellInstruction(
          {
            pool,
            user: this.wallet.publicKey,
            baseTokenProgram,
            protocolFeeRecipient,
            buybackFeeRecipient,
          },
          toSell,
          minQuoteOut,
        ),
        buildUnwrapSolInstruction(this.wallet.publicKey),
      ],
      'AMM sell',
    );

    const rentReclaimed =
      toSell === held ? await this.closeTokenAccount(pool.baseMint, baseTokenProgram) : false;
    return { result, solOut: lamportsToSol(net), rentReclaimed };
  }

  async getBalanceSol(): Promise<number> {
    const lamports = await this.connection.getBalance(this.wallet.publicKey, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  }
}
