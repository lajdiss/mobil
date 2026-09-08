/**
 * What each entry mode does with a launch that has passed the filters.
 *
 * This is a table rather than a chain of ifs because a chain of ifs is how the delay
 * mode came to do nothing. The branch that scheduled the delayed entry was never in
 * the file — a bad edit dropped it silently — so the mode advertised "buy every
 * qualifying launch 30 seconds later", logged that on startup, and bought at the
 * launch instead. Nothing errored, and the dashboard's own description of the mode
 * was the lie.
 *
 * A table can be asserted against the list of modes; a chain of ifs cannot.
 */
import type { Config } from './config.js';

export type LaunchRoute =
  /** Buy now, on the launch event's own reserves. */
  | 'enter-now'
  /** Buy after a delay, optionally competing in the selection pool first. */
  | 'enter-after-delay'
  /** Hand to a tracker that decides later. */
  | 'momentum-tracker'
  | 'copy-tracker'
  | 'consensus-tracker'
  /** This mode does not enter on launches at all. */
  | 'ignore';

export const LAUNCH_ROUTES: Record<Config['entryMode'], LaunchRoute> = {
  snipe: 'enter-now',
  delay: 'enter-after-delay',
  momentum: 'momentum-tracker',
  copy: 'copy-tracker',
  consensus: 'consensus-tracker',
  // Both of these find their own candidates; a launch means nothing to them.
  graduate: 'ignore',
  trending: 'ignore',
};

export const routeForMode = (mode: Config['entryMode']): LaunchRoute => LAUNCH_ROUTES[mode];
