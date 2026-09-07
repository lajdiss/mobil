/**
 * Self-test: builds real pump.fun buy and sell transactions against a live token and
 * simulates them. Nothing is signed or sent. Run this after pulling changes — pump.fun
 * updates its program, and an account-layout drift shows up here first.
 */
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { loadConfig, loadKeypair } from './config.js';
import {
  PUMP_PROGRAM,
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
} from './pump.js';
import { solToLamports } from './executor.js';

const config = loadConfig();
const wallet = loadKeypair();
const connection = new Connection(config.rpcUrl, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

interface LiveToken {
  mint: PublicKey;
  creator: PublicKey;
  tokenProgram: PublicKey;
  sampleBuyer: PublicKey;
}

type Simulation = Awaited<ReturnType<Connection['simulateTransaction']>>;

/**
 * Any token still on its bonding curve will do. Buys are far more common than creates,
 * so we look for a buy and read the mint out of it.
 */
async function findLiveToken(): Promise<LiveToken | null> {
  const signatures = await connection.getSignaturesForAddress(PUMP_PROGRAM, { limit: 40 });
  for (const entry of signatures) {
    if (entry.err) continue;
    let tx;
    try {
      tx = await connection.getTransaction(entry.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
    } catch {
      await sleep(500);
      continue;
    }
    if (!tx?.meta) continue;

    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses,
    });
    const candidates: { programIdIndex: number; data: Buffer; accounts: readonly number[] }[] = [];
    for (const ix of tx.transaction.message.compiledInstructions || []) {
      candidates.push({
        programIdIndex: ix.programIdIndex,
        data: Buffer.from(ix.data),
        accounts: ix.accountKeyIndexes,
      });
    }
    for (const inner of tx.meta.innerInstructions || []) {
      for (const ix of inner.instructions) {
        candidates.push({
          programIdIndex: ix.programIdIndex,
          data: Buffer.from(bs58.decode(ix.data)),
          accounts: ix.accounts,
        });
      }
    }

    for (const candidate of candidates) {
      if (!keys.get(candidate.programIdIndex)?.equals(PUMP_PROGRAM)) continue;
      if (!candidate.data.subarray(0, 8).equals(BUY_DISCRIMINATOR)) continue;

      const mint = keys.get(candidate.accounts[2]);
      const sampleBuyer = keys.get(candidate.accounts[6]);
      if (!mint || !sampleBuyer) continue;

      const curveInfo = await connection.getAccountInfo(bondingCurvePda(mint));
      if (!curveInfo) continue;
      const curve = decodeBondingCurve(curveInfo.data);
      if (curve.complete) continue;

      const mintInfo = await connection.getAccountInfo(mint);
      if (!mintInfo) continue;

      return { mint, creator: curve.creator, tokenProgram: mintInfo.owner, sampleBuyer };
    }
    await sleep(120);
  }
  return null;
}

/** Mirrors the executor: retry across recipient lists, since stale picks are rejected. */
async function simulateWithRecipients(
  global: GlobalState,
  build: (
    fee: PublicKey,
    buyback: PublicKey,
  ) => { instructions: TransactionInstruction[]; payer: PublicKey },
): Promise<Simulation> {
  const fees = feeRecipientCandidates(global);
  const buybacks = global.buybackFeeRecipients;
  const attempts = Math.min(Math.max(fees.length, buybacks.length), 8);
  let last: Simulation | null = null;

  for (let i = 0; i < attempts; i++) {
    const { instructions, payer } = build(fees[i % fees.length], buybacks[i % buybacks.length]);
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
    if (!(sim.value.logs || []).some((l) => l.includes('NotAuthorized'))) return sim;
    await sleep(200);
  }
  return last!;
}

function reportFailure(sim: Simulation) {
  console.log('  FAILED:', JSON.stringify(sim.value.err));
  for (const line of sim.value.logs || []) {
    if (/AnchorError|Error Code|insufficient/i.test(line)) console.log('   ', line);
  }
}

/**
 * Buys and sells in a single simulated transaction. The buy funds the token account the
 * sell then spends, so the sell layout is validated without hunting for an existing
 * holder on a rate-limited public RPC.
 */
async function checkRoundTrip(
  token: LiveToken,
  payer: PublicKey,
  global: GlobalState,
  curve: BondingCurve,
  minTokens: bigint,
  maxSolCost: bigint,
) {
  console.log('\nchecking sell instruction layout (buy + sell round trip)…');
  const minSolOutput = (solForTokens(curve, minTokens) * 5000n) / 10_000n;

  let accountCount = 0;
  const sim = await simulateWithRecipients(global, (fee, buyback) => {
    const params = {
      mint: token.mint,
      user: payer,
      creator: token.creator,
      tokenProgram: token.tokenProgram,
      feeRecipient: fee,
      buybackFeeRecipient: buyback,
    };
    const sellIx = buildSellInstruction(params, minTokens, minSolOutput);
    accountCount = sellIx.keys.length;
    return {
      payer,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        createAtaIdempotentInstruction(payer, payer, token.mint, token.tokenProgram),
        buildBuyInstruction(params, minTokens, maxSolCost),
        sellIx,
      ],
    };
  });

  console.log('  accounts in sell ix:', accountCount);
  if (sim.value.err) {
    reportFailure(sim);
    process.exitCode = 1;
    return;
  }
  console.log('  OK — buy + sell round trip simulates cleanly against mainnet.');
}

async function main() {
  console.log('rpc:    ', config.rpcUrl);
  console.log('wallet: ', wallet.publicKey.toBase58());
  console.log('\nlooking for a live pump.fun token…');

  const token = await findLiveToken();
  if (!token) {
    console.log('could not find a live token to test against — try again in a moment');
    process.exit(1);
  }
  console.log('mint:   ', token.mint.toBase58());

  // An unfunded wallet does not exist on chain, so simulating as it fails before the
  // program runs. Fall back to a funded buyer so the layout still gets validated.
  const balance = await connection.getBalance(wallet.publicKey, 'confirmed');
  const funded = balance > 0;
  const payer = funded ? wallet.publicKey : token.sampleBuyer;
  if (!funded) {
    console.log('\nwallet has 0 SOL — validating layout using a funded account instead');
  }

  const globalInfo = await connection.getAccountInfo(globalPda());
  if (!globalInfo) throw new Error('global account missing');
  const global = decodeGlobal(globalInfo.data);

  const curveInfo = await connection.getAccountInfo(bondingCurvePda(token.mint));
  if (!curveInfo) throw new Error('bonding curve missing');
  const curve = decodeBondingCurve(curveInfo.data);

  const solIn = solToLamports(config.buyAmountSol);
  const expected = tokensForSol(curve, solIn);
  const minTokens = (expected * BigInt(10_000 - config.slippageBps)) / 10_000n;
  const maxSolCost = (solIn * BigInt(10_000 + config.slippageBps)) / 10_000n;

  let accountCount = 0;
  const sim = await simulateWithRecipients(global, (fee, buyback) => {
    const instruction = buildBuyInstruction(
      {
        mint: token.mint,
        user: payer,
        creator: token.creator,
        tokenProgram: token.tokenProgram,
        feeRecipient: fee,
        buybackFeeRecipient: buyback,
      },
      minTokens,
      maxSolCost,
    );
    accountCount = instruction.keys.length;
    return {
      payer,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: config.computeUnitLimit }),
        createAtaIdempotentInstruction(payer, payer, token.mint, token.tokenProgram),
        instruction,
      ],
    };
  });

  console.log('\naccounts in buy ix:', accountCount);
  console.log('compute units:     ', sim.value.unitsConsumed);

  if (sim.value.err) {
    reportFailure(sim);
    if ((sim.value.logs || []).some((l) => /insufficient lamports/i.test(l))) {
      console.log('\nThe instruction layout is fine — the wallet just has no SOL.');
      process.exit(0);
    }
    process.exit(1);
  }

  console.log(
    funded
      ? '\nOK — buy instruction simulates cleanly against mainnet with your wallet.'
      : '\nOK — buy instruction layout is valid against mainnet. Fund the wallet to trade.',
  );

  await checkRoundTrip(token, payer, global, curve, minTokens, maxSolCost);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
