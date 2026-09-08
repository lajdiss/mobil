import { Connection, PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM, bondingCurvePda, decodeBondingCurve } from './src/pump.js';

const c = new Connection(process.env.EP || 'https://solana-rpc.publicnode.com', 'confirmed');
const BUY = Buffer.from([102,6,61,18,1,218,235,234]).toString('hex');
const SELL = Buffer.from([51,230,133,164,1,127,131,173]).toString('hex');
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));

// Najdi reálné obchody na pump.fun a rozděl je podle toho, jestli je token mayhem.
const sigs = await c.getSignaturesForAddress(PUMP_PROGRAM, { limit: 25 });
const seen = new Map<string, {mayhem:boolean; buyAccts:number; sellAccts:number; buyLen:number}>();
let fails=0, empty=0, fetched=0, pumpIx=0, tradeIx=0, curveFail=0;

for (const s of sigs) {
  if (s.err) continue;
  let tx; try { tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }); }
  catch (e) { fails++; await sleep(300); continue; }
  if (!tx) { empty++; continue; }
  fetched++;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  for (const ix of tx.transaction.message.compiledInstructions) {
    if (!keys.get(ix.programIdIndex)?.equals(PUMP_PROGRAM)) continue;
    pumpIx++;
    const data = Buffer.from(ix.data); const d = data.subarray(0,8).toString('hex');
    const kind = d===BUY?'buy':d===SELL?'sell':null;
    if (!kind) continue;
    tradeIx++;
    const mint = keys.get(ix.accountKeyIndexes[2]); // mint je na indexu 2 v pump buy/sell
    if (!mint) continue;
    const key = mint.toBase58();
    if (seen.has(key)) continue;
    const info = await c.getAccountInfo(bondingCurvePda(mint)).catch(()=>null);
    if (!info) continue;
    let curve; try { curve = decodeBondingCurve(info.data); } catch { curveFail++; continue; }
    seen.set(key, {
      mayhem: curve.isMayhemMode,
      buyAccts: kind==='buy'?ix.accountKeyIndexes.length:0,
      sellAccts: kind==='sell'?ix.accountKeyIndexes.length:0,
      buyLen: data.length,
    });
    await sleep(150);
  }
  if (seen.size >= 12) break;
}

console.log(`diagnostika: staženo ${fetched}, chyb ${fails}, prázdných ${empty}, pump ix ${pumpIx}, obchodních ix ${tradeIx}, nedekódovaných křivek ${curveFail}\n`);
console.log('token'.padEnd(46)+'mayhem  účtů  data');
for (const [mint, v] of seen) {
  console.log(mint.padEnd(46)+(v.mayhem?'  ANO ':'  ne  ')+String(v.buyAccts||v.sellAccts).padStart(5)+String(v.buyLen).padStart(6));
}
const mayhem=[...seen.values()].filter(v=>v.mayhem);
const normal=[...seen.values()].filter(v=>!v.mayhem);
console.log(`\nmayhem tokenů: ${mayhem.length}, normálních: ${normal.length}`);
if (mayhem.length && normal.length) {
  const acc=(v:any)=>v.buyAccts||v.sellAccts;
  console.log('účtů v instrukci — mayhem:', [...new Set(mayhem.map(acc))].join(','), ' normální:', [...new Set(normal.map(acc))].join(','));
  console.log(JSON.stringify([...new Set(mayhem.map(acc))])===JSON.stringify([...new Set(normal.map(acc))])
    ? '-> STEJNÝ layout, mayhem se obchoduje úplně stejně'
    : '-> JINÝ layout, mayhem potřebuje jinou instrukci');
}
