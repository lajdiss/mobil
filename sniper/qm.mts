import { Connection, PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM, CREATE_EVENT_DISCRIMINATOR, decodeCreateEvent } from './src/pump.js';
import { WSOL_MINT } from './src/pumpswap.js';
const c = new Connection('https://api.mainnet-beta.solana.com', {
  commitment: 'confirmed', wsEndpoint: 'wss://api.mainnet-beta.solana.com',
});
let n = 0;
const seen = new Map<string, number>();
c.onLogs(PUMP_PROGRAM, (l) => {
  if (l.err) return;
  for (const line of l.logs) {
    if (!line.startsWith('Program data: ')) continue;
    let d: Buffer; try { d = Buffer.from(line.slice(14), 'base64'); } catch { continue; }
    if (d.length < 8 || !d.subarray(0,8).equals(CREATE_EVENT_DISCRIMINATOR)) continue;
    try {
      const e = decodeCreateEvent(d);
      const qm = e.quoteMint.toBase58();
      seen.set(qm, (seen.get(qm) ?? 0) + 1);
      if (n < 5) {
        console.log(`${e.symbol.padEnd(12)} quoteMint=${qm}`);
        console.log(`   == WSOL? ${e.quoteMint.equals(WSOL_MINT)}   == default(0)? ${e.quoteMint.equals(PublicKey.default)}`);
        console.log(`   virtualQuoteReserves=${e.virtualQuoteReserves}  virtualSolReserves=${e.virtualSolReserves}`);
      }
      n++;
    } catch {}
  }
}, 'processed');
setTimeout(() => {
  console.log(`\n${n} launchů, rozdělení quoteMint:`);
  for (const [k, v] of [...seen.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${v.toString().padStart(4)}  ${k}`);
  process.exit(0);
}, 45000);
