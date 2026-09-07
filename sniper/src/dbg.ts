import { Connection } from '@solana/web3.js';
import { loadConfig } from './config.js';
import { Detector } from './detector.js';

const config = loadConfig();
const connection = new Connection(config.rpcUrl, {
  commitment: 'confirmed',
  wsEndpoint: config.wsUrl,
});

const detector = new Detector(
  connection,
  (t) => console.log('CREATE:', t.symbol, t.mint.toBase58()),
  () => {},
  (m) => console.log('ERROR:', m),
);
detector.start();
console.log('detector started');

setTimeout(() => {
  console.log('counters after 30s:', JSON.stringify(detector.counters));
  process.exit(0);
}, 30000);
