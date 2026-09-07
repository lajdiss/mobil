import type { Config } from './config.js';
import type { DetectedToken } from './detector.js';

export interface FilterVerdict {
  passed: boolean;
  reason?: string;
}

/**
 * Tracks how often each creator launches. A wallet spraying launches is the single
 * clearest serial-rugger signal available without an indexer.
 */
export class CreatorHistory {
  private launches = new Map<string, number[]>();

  record(creator: string, at = Date.now()) {
    const list = this.launches.get(creator) || [];
    list.push(at);
    this.launches.set(creator, list);
  }

  countLastHour(creator: string, now = Date.now()): number {
    const cutoff = now - 3_600_000;
    const list = (this.launches.get(creator) || []).filter((t) => t >= cutoff);
    this.launches.set(creator, list);
    return list.length;
  }
}

export function evaluate(
  token: DetectedToken,
  config: Config,
  history: CreatorHistory,
): FilterVerdict {
  const name = token.name.toLowerCase();
  const symbol = token.symbol.toLowerCase();

  for (const pattern of config.blockedNamePatterns) {
    if (name.includes(pattern) || symbol.includes(pattern)) {
      return { passed: false, reason: `blocked pattern "${pattern}"` };
    }
  }

  if (config.requireSocials && !token.uri) {
    return { passed: false, reason: 'no metadata uri' };
  }

  const recentLaunches = history.countLastHour(token.creator.toBase58());
  if (recentLaunches > config.maxCreatorLaunchesPerHour) {
    return {
      passed: false,
      reason: `creator launched ${recentLaunches} tokens in the last hour`,
    };
  }

  if (token.isMayhemMode) {
    return { passed: false, reason: 'mayhem mode token' };
  }

  return { passed: true };
}
