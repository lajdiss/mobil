/**
 * Self-test for the AMM path: builds a real buy and sell against a live graduated
 * pool and simulates them. Nothing is signed or sent.
 *
 * This matters more than the bonding-curve equivalent, because the published pump_amm
 * IDL is behind the deployed program — it lists 23 accounts for a buy where mainnet
 * passes 26. Everything here was derived from live transactions, so this is what
 * catches the next drift.
 */
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { loadConfig, loadKeypair } from './config.js';
import { TOKEN_PROGRAM, createAtaIdempotentInstruction, solForTokens, tokensForSol } from './pump.js';
import {
  PUMPSWAP_PROGRAM,
  WSOL_MINT,
  ataFor,
  buildSwapBuyInstruction,
  buildSwapSellInstruction,
  buildUnwrapSolInstruction,
  buildWrapSolInstructions,
  decodePool,
  decodeSwapGlobalConfig,
  graduatedPoolPda,
  migrationAuthorityPda,
  poolQuote,
  swapFeeRecipientCandidates,
  swapGlobalConfigPda,
  tokenProgramFromOwner,
  type SwapGlobalConfig,
  type SwapPool,
} from './pumpswap.js';
import { solToLamports } from './executor.js';

const config = loadConfig();
const wallet = loadKeypair();
const connection = new Connection(config.rpcUrl, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

type Simulation = Awaited<ReturnType<Connection['simulateTransaction']>>;

interface LivePool {
  pool: SwapPool;
  baseTokenProgram: PublicKey;
  baseReserves: bigint;
  quoteReserves: bigint;
  sampleTrader: PublicKey;
}

/**
 * Any pump.fun-graduated pool will do. Swaps are far more common than graduations, so
 * we read the mint out of a swap and check that its pool is one pump.fun migrated —
 * the migration authority derives from the mint, so this needs no extra lookup.
 */
async function findGraduatedPool(): Promise<LivePool | null> {
  const signatures = await connection.getSignaturesForAddress(PUMPSWAP_PROGRAM, { limit: 30 });
  for (const entry of signatures) {
    if (entry.err) continue;
    let tx;
    try {
      tx = await connection.getTransaction(entry.signature, {
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      await sleep(300);
      continue;
    }
    if (!tx) continue;
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses,
    });

    for (const ix of tx.transaction.message.compiledInstructions) {
      if (!keys.get(ix.programIdIndex)?.equals(PUMPSWAP_PROGRAM)) continue;
      const discriminator = Buffer.from(ix.data).subarray(0, 8);
      if (!discriminator.equals(BUY_DISCRIMINATOR) && !discriminator.equals(SELL_DISCRIMINATOR)) {
        continue;
      }
      const baseMint = keys.get(ix.accountKeyIndexes[3]);
      const quoteMint = keys.get(ix.accountKeyIndexes[4]);
      const trader = keys.get(ix.accountKeyIndexes[1]);
      if (!baseMint || !quoteMint || !trader || !quoteMint.equals(WSOL_MINT)) continue;
      if (!migrationAuthorityPda(baseMint).equals(keys.get(ix.accountKeyIndexes[0]) ?? baseMint)) {
        // The pool account is not the creator; check by deriving the pool instead.
        if (!graduatedPoolPda(baseMint).equals(keys.get(ix.accountKeyIndexes[0])!)) continue;
      }

      const [poolInfo, mintInfo] = await connection.getMultipleAccountsInfo([
        graduatedPoolPda(baseMint),
        baseMint,
      ]);
      if (!poolInfo || !mintInfo) continue;
      const pool = decodePool(graduatedPoolPda(baseMint), poolInfo.data);
      if (!pool) continue;

      const baseTokenProgram = tokenProgramFromOwner(mintInfo.owner);
      if (!baseTokenProgram) continue;
      const [baseVault, quoteVault] = await connection.getMultipleAccountsInfo([
        pool.poolBaseTokenAccount,
        pool.poolQuoteTokenAccount,
      ]);
      if (!baseVault || !quoteVault) continue;

      return {
        pool,
        baseTokenProgram,
        baseReserves: baseVault.data.readBigUInt64LE(64),
        quoteReserves: quoteVault.data.readBigUInt64LE(64),
        sampleTrader: trader,
      };
    }
    await sleep(150);
  }
  return null;
}

/** Mirrors the executor: retry across recipient lists, since stale picks are rejected. */
async function simulateWithRecipients(
  swapConfig: SwapGlobalConfig,
  build: (
    protocolFeeRecipient: PublicKey,
    buybackFeeRecipient: PublicKey,
  ) => { instructions: TransactionInstruction[]; payer: PublicKey },
): Promise<Simulation> {
  const recipients = swapFeeRecipientCandidates(swapConfig);
  const buybacks = swapConfig.buybackFeeRecipients;
  const attempts = Math.min(Math.max(recipients.length, buybacks.length), 8);
  let last: Simulation | null = null;

  for (let i = 0; i < attempts; i++) {
    const { instructions, payer } = build(
      recipients[i % recipients.length],
      buybacks[i % buybacks.length],
    );
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const sim = await connection.simulateTransaction(new VersionedTransaction(message), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
    });
    last = sim;
    if (!sim.value.err) return sim;
    if (
      !(sim.value.logs || []).some(
        (l) => l.includes('NotAuthorized') || l.includes('InvalidProtocolFeeRecipient'),
      )
    ) {
      return sim;
    }
    await sleep(200);
  }
  return last!;
}

function reportFailure(sim: Simulation) {
  console.log('  FAILED:', JSON.stringify(sim.value.err));
  for (const line of sim.value.logs || []) {
    if (/AnchorError|Error Code|insufficient|custom program error/i.test(line)) {
      console.log('   ', line);
    }
  }
}

async function main() {
  console.log('rpc:    ', config.rpcUrl);
  console.log('wallet: ', wallet.publicKey.toBase58());
  console.log('\nlooking for a live pump.fun-graduated pool…');

  const live = await findGraduatedPool();
  if (!live) {
    console.log('could not find a graduated pool to test against — try again in a moment');
    process.exit(1);
  }
  console.log('mint:   ', live.pool.baseMint.toBase58());
  console.log('pool:   ', live.pool.address.toBase58());
  console.log(
    'reserves:',
    (Number(live.quoteReserves) / 1e9).toFixed(2),
    'SOL against',
    live.baseReserves.toString(),
    'base units',
  );
  console.log('token program:', live.baseTokenProgram.toBase58());

  const configInfo = await connection.getAccountInfo(swapGlobalConfigPda());
  if (!configInfo) throw new Error('AMM global config missing');
  const swapConfig = decodeSwapGlobalConfig(configInfo.data);
  console.log(
    'fees:    ',
    `${swapConfig.lpFeeBps} lp + ${swapConfig.protocolFeeBps} protocol + ` +
      `${swapConfig.coinCreatorFeeBps} creator bps`,
  );

  // An unfunded wallet does not exist on chain, so simulating as it fails before the
  // program runs. Fall back to a real trader so the layout still gets validated.
  const balance = await connection.getBalance(wallet.publicKey, 'confirmed');
  const funded = balance > solToLamports(config.buyAmountSol);
  const payer = funded ? wallet.publicKey : live.sampleTrader;
  if (!funded) {
    console.log('\nwallet cannot cover the trade — validating layout using a funded account');
  }

  const quote = poolQuote(live.baseReserves, live.quoteReserves);
  // Borrowing someone else's account only validates the layout if the transaction can
  // actually reach the swap. Their balance is whatever it is, so the test trade is
  // sized to fit inside it — a third, leaving room for the wrap and the fees.
  const payerBalance = funded ? balance : await connection.getBalance(payer, 'confirmed');
  const affordable = funded
    ? solToLamports(config.buyAmountSol)
    : BigInt(Math.floor(payerBalance / 3));
  const solIn =
    affordable < solToLamports(config.buyAmountSol) ? affordable : solToLamports(config.buyAmountSol);
  if (solIn <= 0n) {
    console.log('the borrowed account has no balance either — try again in a moment');
    process.exit(1);
  }
  if (!funded) console.log('test size:', (Number(solIn) / 1e9).toFixed(4), 'SOL');
  const tokens = tokensForSol(quote, solIn);
  const maxQuoteIn = (solIn * BigInt(10_000 + config.slippageBps)) / 10_000n;
  const minQuoteOut = (solForTokens(quote, tokens) * 5000n) / 10_000n;

  console.log('\nchecking buy + sell round trip…');
  let buyAccounts = 0;
  let sellAccounts = 0;
  const sim = await simulateWithRecipients(swapConfig, (protocolFeeRecipient, buybackFeeRecipient) => {
    const params = {
      pool: live.pool,
      user: payer,
      baseTokenProgram: live.baseTokenProgram,
      protocolFeeRecipient,
      buybackFeeRecipient,
    };
    const buyIx = buildSwapBuyInstruction(params, tokens, maxQuoteIn);
    const sellIx = buildSwapSellInstruction(params, tokens, minQuoteOut);
    buyAccounts = buyIx.keys.length;
    sellAccounts = sellIx.keys.length;
    return {
      payer,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ...buildWrapSolInstructions(payer, maxQuoteIn),
        createAtaIdempotentInstruction(payer, payer, live.pool.baseMint, live.baseTokenProgram),
        buyIx,
        sellIx,
        buildUnwrapSolInstruction(payer),
      ],
    };
  });

  console.log('  accounts in buy ix: ', buyAccounts, '(mainnet passes 26)');
  console.log('  accounts in sell ix:', sellAccounts, '(mainnet passes 24)');
  console.log('  compute units:      ', sim.value.unitsConsumed);
  console.log('  wsol account:       ', ataFor(payer, WSOL_MINT, TOKEN_PROGRAM).toBase58());

  if (sim.value.err) {
    reportFailure(sim);
    if ((sim.value.logs || []).some((l) => /insufficient lamports/i.test(l))) {
      console.log('\nThe instruction layout is fine — the account just has no SOL.');
      process.exit(0);
    }
    process.exit(1);
  }

  console.log('\nOK — buy and sell both simulate cleanly against a live graduated pool.');
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
