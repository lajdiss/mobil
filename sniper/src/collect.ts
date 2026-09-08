/**
 * Overnight data collection.
 *
 * Every offline conclusion in this project comes from data/launches.jsonl, and the
 * most recent round of measurements says the sample is the binding constraint: the
 * crowd result held its sign across both time-split halves, which nothing else had
 * managed, but the second half's profit came from three trades out of twenty-one. That
 * is a sample-size failure, not a direction failure, and the only fix is more launches.
 *
 * This records every launch it sees for five minutes, whether or not anything is
 * bought, and trades in dry run alongside so the outcome memory gets closed trades to
 * learn from. Anything set in a local .env still wins, so a machine already configured
 * for a particular strategy keeps collecting under it.
 *
 * Dry run is forced rather than defaulted. This is meant to be started and left alone
 * for hours, and a run nobody is watching must not be able to spend money because a
 * stale line in a local .env said otherwise.
 *
 *   npm run collect
 */

export {};

/** Set before the config is imported: dotenv does not overwrite what is already here. */
const force = (key: string, value: string) => {
  process.env[key] = value;
};
const preferred = (key: string, value: string) => {
  if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
};

force('DRY_RUN', 'true');
// The recording itself. Five minutes is long enough for every exit rule tested here.
force('RECORD_LAUNCHES_PATH', 'data/launches.jsonl');
preferred('RECORD_LAUNCH_SECONDS', '300');
// Real fills for the positions it does open, so the memory learns from what a buyer
// would actually have got rather than from the price that triggered the decision.
preferred('DRY_RUN_FILL_DELAY_MS', '1500');
preferred('RECORD_PATH', 'data/paths.jsonl');
preferred('MEMORY_PATH', 'data/outcome-memory.json');
// A machine with no strategy configured would otherwise collect under whatever mode
// happened to be left in its .env, and the memory would be learning from a mixture.
preferred('ENTRY_MODE', 'delay');
// Fees are fixed per round trip, so on a 0.01 SOL position they are 2.6% of it — larger
// than any edge measured here. Recording outcomes at that size would teach the memory
// about the fee rather than about the token.
preferred('BUY_AMOUNT_SOL', '0.05');

console.log('\n  collecting launch data — dry run, nothing is bought for real.');
console.log('  leave this running; stop it with Ctrl+C and the last launches are written out.\n');

await import('./index.js');
