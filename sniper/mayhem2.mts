import { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import {
  bondingCurvePda, buildBuyInstruction, buildSellInstruction, createAtaIdempotentInstruction,
  decodeBondingCurve, decodeGlobal, feeRecipientCandidates, globalPda, solForTokens, tokensForSol,
} from './src/pump.js';
import { tokenProgramFromOwner } from './src/pumpswap.js';

const c = new Connection(process.env.EP || 'https://solana-rpc.publicnode.com', 'confirmed');
const launches = readFileSync('data/launches.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const recent = launches.slice(-90).map(l=>new PublicKey(l.mint));

// Najdi mezi nedávnými launchi jeden mayhem a jeden normální, oba ještě na křivce.
// Po dávkách — velký getMultipleAccounts některé veřejné endpointy blokují.
const infos: (Awaited<ReturnType<typeof c.getAccountInfo>>)[] = [];
for (let i = 0; i < recent.length; i += 30) {
  const batch = recent.slice(i, i + 30).map(bondingCurvePda);
  infos.push(...(await c.getMultipleAccountsInfo(batch)));
  await new Promise(r => setTimeout(r, 200));
}
const mayhems: PublicKey[] = [], normals: PublicKey[] = [], cashbacks: PublicKey[] = [];
for (let i=0;i<recent.length;i++){
  const info=infos[i]; if(!info) continue;
  let cur; try { cur = decodeBondingCurve(info.data); } catch { continue; }
  if (cur.complete) continue;
  if (cur.isCashbackCoin) cashbacks.push(recent[i]);
  else if (cur.isMayhemMode) mayhems.push(recent[i]);
  else normals.push(recent[i]);
}
console.log(`z ${recent.length} nedávných launchů na křivce: ${mayhems.length} mayhem, ${cashbacks.length} cashback, ${normals.length} normálních\n`);

const globalInfo = await c.getAccountInfo(globalPda());
const global = decodeGlobal(globalInfo!.data);
const payer = new PublicKey('9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz'); // funded fee recipient

async function trySim(mint: PublicKey, label: string) {
  const [curveInfo, mintInfo] = await c.getMultipleAccountsInfo([bondingCurvePda(mint), mint]);
  if (!curveInfo || !mintInfo) { console.log(label, '- nelze načíst'); return; }
  const curve = decodeBondingCurve(curveInfo.data);
  const tokenProgram = tokenProgramFromOwner(mintInfo.owner);
  if (!tokenProgram) { console.log(label, '- neznámý token program'); return; }

  const solIn = 10_000_000n; // 0.01 SOL
  const tokens = tokensForSol(curve, solIn);
  const maxCost = (solIn * 12000n) / 10000n;
  const minOut = (solForTokens(curve, tokens) * 5000n) / 10000n;

  for (let i = 0; i < 4; i++) {
    const fees = feeRecipientCandidates(global);
    const params = {
      mint, user: payer, creator: curve.creator, tokenProgram,
      feeRecipient: fees[i % fees.length],
      buybackFeeRecipient: global.buybackFeeRecipients[i % global.buybackFeeRecipients.length],
    };
    const { blockhash } = await c.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: payer, recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        createAtaIdempotentInstruction(payer, payer, mint, tokenProgram),
        buildBuyInstruction(params, tokens, maxCost),
        buildSellInstruction(params, tokens, minOut),
      ],
    }).compileToV0Message();
    const sim = await c.simulateTransaction(new VersionedTransaction(msg), {
      sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed',
    });
    if (!sim.value.err) { console.log(`${label}: buy+sell SIMULUJE ČISTĚ (mayhem=${curve.isMayhemMode})`); return; }
    const anchor = (sim.value.logs||[]).find(l=>l.includes('AnchorError')||l.includes('custom program error'));
    if ((sim.value.logs||[]).some(l=>l.includes('NotAuthorized'))) continue;
    console.log(`${label}: SELHALO (mayhem=${curve.isMayhemMode}) ${JSON.stringify(sim.value.err)}`);
    if (anchor) console.log('   ', anchor.slice(0,150));
    return;
  }
  console.log(label, '- nenašel se autorizovaný fee recipient');
}

for (const [label, list] of [['NORMÁLNÍ', normals], ['MAYHEM  ', mayhems], ['CASHBACK', cashbacks]] as const) {
  for (const mint of list.slice(0, 3)) {
    await trySim(mint, `${label} ${mint.toBase58().slice(0,6)}`);
    await new Promise(r => setTimeout(r, 400));
  }
}
