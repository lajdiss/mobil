import { Connection } from '@solana/web3.js';
import { appendFileSync } from 'node:fs';
import { PUMP_PROGRAM, TRADE_EVENT_DISCRIMINATOR, decodeTradeEventPrefix } from './src/pump.js';
import { graduatedPoolPda } from './src/pumpswap.js';
const OUT='/tmp/claude-0/complete.log';
const say=(s:string)=>appendFileSync(OUT, s+'\n');
const c = new Connection('https://solana-rpc.publicnode.com',{commitment:'confirmed',wsEndpoint:'wss://solana-rpc.publicnode.com'});
const http = new Connection('https://api.mainnet-beta.solana.com','confirmed');
let trades=0, complete=0;
const seen=new Set<string>();
const started=Date.now();
c.onLogs(PUMP_PROGRAM,(l)=>{
  if(l.err) return;
  for(const line of l.logs){
    if(!line.startsWith('Program data: ')) continue;
    let d:Buffer; try{ d=Buffer.from(line.slice(14),'base64'); }catch{continue;}
    if(d.length<8||!d.subarray(0,8).equals(TRADE_EVENT_DISCRIMINATOR)) continue;
    const t=decodeTradeEventPrefix(d); if(!t) continue; trades++;
    if(t.realTokenReserves===0n){
      const k=t.mint.toBase58();
      if(seen.has(k)) continue; seen.add(k); complete++;
      const pool=graduatedPoolPda(t.mint);
      say(`[+${((Date.now()-started)/1000).toFixed(0)}s] CURVE COMPLETE ${k} -> pool ${pool.toBase58()}`);
      let tries=0;
      const check=async()=>{
        tries++;
        const info=await http.getAccountInfo(pool).catch(()=>null);
        if(info){ say(`   ${k.slice(0,8)} pool LIVE after ~${tries*10}s (${info.data.length} bytes)`); return; }
        if(tries<24) setTimeout(()=>void check(),10000); else say(`   ${k.slice(0,8)} pool still absent after 240s`);
      };
      setTimeout(()=>void check(),5000);
    }
  }
},'processed');
setInterval(()=>say(`[${((Date.now()-started)/60000).toFixed(1)}m] trades=${trades} curvesCompleted=${complete}`),60000);
