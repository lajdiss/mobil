/**
 * Checks that every entry mode is routed somewhere deliberate.
 *
 * The bug this guards against did not throw, did not log, and described itself
 * correctly on startup: delay mode announced "buy every qualifying launch 30 seconds
 * later" and bought at the launch, because the branch that scheduled the delay was
 * missing from the file. The mode existed in the config, in the dashboard and in the
 * README — everywhere except where it mattered.
 *
 * So the test asserts the two things that were wrong: that the mode list and the
 * routing table agree, and that a mode claiming to delay is not routed to immediate
 * entry.
 */
import { LAUNCH_ROUTES, routeForMode } from './routing.js';
import type { Config } from './config.js';

// Every mode the config will accept. Kept literal so adding a mode without routing it
// fails here rather than at runtime.
const MODES: Config['entryMode'][] = [
  'snipe',
  'delay',
  'momentum',
  'copy',
  'consensus',
  'graduate',
  'trending',
];

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)}${detail}`);
};

for (const mode of MODES) {
  const route = routeForMode(mode);
  check(`${mode} is routed`, route !== undefined, route ?? 'MISSING');
}

check(
  'no mode is missing from the table',
  MODES.every((m) => m in LAUNCH_ROUTES),
  `${Object.keys(LAUNCH_ROUTES).length} entries for ${MODES.length} modes`,
);
check(
  'no stale entries in the table',
  Object.keys(LAUNCH_ROUTES).every((k) => MODES.includes(k as Config['entryMode'])),
);

// The specific inversion that shipped: a delaying mode wired to immediate entry.
check(
  'delay does not enter immediately',
  routeForMode('delay') === 'enter-after-delay',
  routeForMode('delay'),
);
check('snipe does enter immediately', routeForMode('snipe') === 'enter-now');
check(
  'modes with their own sources ignore launches',
  routeForMode('graduate') === 'ignore' && routeForMode('trending') === 'ignore',
);

console.log(
  failures === 0
    ? '\nAll good. A mode that describes itself one way and behaves another is the\n' +
        'failure this catches — nothing about it looks wrong from the outside.'
    : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
