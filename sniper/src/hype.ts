/**
 * Reads what pump.fun's own frontend knows about a token: how many people are talking
 * about it, whether it has socials, whether it is live, whether it has been banned.
 *
 * This is the first signal in the project that comes from outside the chain. Everything
 * measured so far says selection is where the problem is — exits are at their ceiling,
 * and the entry timing is a latency race a public RPC loses — and attention is the one
 * thing a meme coin runs on that the chain does not report directly.
 *
 * Three rules govern its use:
 *
 * It costs a network round trip, so it belongs only in the modes that already wait
 * (delay, momentum, graduate). Putting it on the snipe path would add a fetch to the
 * one path where latency is the whole game.
 *
 * It fails closed. An unreachable API returns null, never a default that reads as
 * "no hype" or "safe" — a filter that silently passes everything when its data source
 * is down is worse than no filter.
 *
 * And it is recorded before it is trusted. The fields go into the launch recordings so
 * the offline replay can test whether they predict anything, on the same discipline as
 * everything else here.
 */
const API = 'https://frontend-api-v3.pump.fun';

export interface HypeSnapshot {
  mint: string;
  symbol: string;
  name: string;
  /** Seconds since anyone traded it. The only current liveness signal this API has. */
  lastTradeAgoSeconds: number | null;
  /** False while still on the bonding curve, true once migrated to the AMM. */
  graduated: boolean;
  /** Comments on the coin's pump.fun page — the closest thing to a callout count. */
  replyCount: number;
  /** Replies per minute since creation; 50 in two minutes is not 50 in a day. */
  repliesPerMinute: number;
  lastReplyAgoSeconds: number | null;
  ageSeconds: number;
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
  isCurrentlyLive: boolean;
  reachedKingOfTheHill: boolean;
  marketCapSol: number;
  /** Peak market cap it ever reached, so a token past its run is visible as such. */
  athMarketCapSol: number;
  nsfw: boolean;
  isBanned: boolean;
  verified: boolean;
  fetchedAt: number;
}

interface CacheEntry {
  snapshot: HypeSnapshot | null;
  at: number;
}

export interface HypeClientOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxConcurrent?: number;
  /** Consecutive failures before the client stops calling for a while. */
  breakerThreshold?: number;
  breakerCooldownMs?: number;
}

export class HypeClient {
  private cache = new Map<string, CacheEntry>();
  private inFlight = 0;
  private queue: (() => void)[] = [];
  private consecutiveFailures = 0;
  private breakerUntil = 0;

  readonly counters = { hits: 0, misses: 0, failures: 0, breakerTrips: 0 };

  constructor(private readonly options: HypeClientOptions = {}) {}

  private get timeoutMs() {
    return this.options.timeoutMs ?? 2500;
  }
  private get cacheTtlMs() {
    return this.options.cacheTtlMs ?? 60_000;
  }
  private get maxConcurrent() {
    return this.options.maxConcurrent ?? 4;
  }

  /** Unofficial endpoint on someone else's infrastructure — do not hammer it. */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
      this.queue.shift()?.();
    }
  }

  /** Null means "could not find out", never "nothing here". */
  async fetch(mint: string): Promise<HypeSnapshot | null> {
    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      this.counters.hits++;
      return cached.snapshot;
    }
    if (Date.now() < this.breakerUntil) return null;

    this.counters.misses++;
    const snapshot = await this.withSlot(() => this.request(mint));
    // A failure is not cached as "no data": caching it would turn one bad minute into
    // a filter that passes nothing for as long as the TTL lasts.
    if (snapshot) this.cache.set(mint, { snapshot, at: Date.now() });
    if (this.cache.size > 2000) this.cache.clear();
    return snapshot;
  }

  private async request(mint: string): Promise<HypeSnapshot | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await globalThis.fetch(`${API}/coins/${mint}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const coin = (await response.json()) as Record<string, unknown>;
      this.consecutiveFailures = 0;
      return normalise(mint, coin);
    } catch {
      this.counters.failures++;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= (this.options.breakerThreshold ?? 5)) {
        this.breakerUntil = Date.now() + (this.options.breakerCooldownMs ?? 60_000);
        this.consecutiveFailures = 0;
        this.counters.breakerTrips++;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A page of tokens someone has traded recently — the pool a trending scan picks
   * from. Sorted by last trade because that is the only liveness signal this API
   * exposes that is actually current: comment timestamps across every token sampled
   * were months stale, so the reply fields describe history, not attention.
   */
  async listActive(pages = 4, pageSize = 50): Promise<HypeSnapshot[]> {
    const out = new Map<string, HypeSnapshot>();
    for (let page = 0; page < pages; page++) {
      if (Date.now() < this.breakerUntil) break;
      const query =
        `limit=${pageSize}&offset=${page * pageSize}` +
        '&sort=last_trade_timestamp&order=DESC&includeNsfw=false';
      const coins = await this.withSlot(() => this.requestList(query));
      if (!coins) break;
      for (const coin of coins) {
        const mint = str(coin.mint);
        if (!mint) continue;
        const snapshot = normalise(mint, coin);
        out.set(mint, snapshot);
        this.cache.set(mint, { snapshot, at: Date.now() });
      }
      if (coins.length < pageSize) break;
    }
    if (this.cache.size > 2000) this.cache.clear();
    return [...out.values()];
  }

  private async requestList(query: string): Promise<Record<string, unknown>[] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs * 2);
    try {
      const response = await globalThis.fetch(`${API}/coins?${query}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error('not a list');
      this.consecutiveFailures = 0;
      return body as Record<string, unknown>[];
    } catch {
      this.counters.failures++;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= (this.options.breakerThreshold ?? 5)) {
        this.breakerUntil = Date.now() + (this.options.breakerCooldownMs ?? 60_000);
        this.consecutiveFailures = 0;
        this.counters.breakerTrips++;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  health() {
    return {
      ...this.counters,
      cached: this.cache.size,
      breakerOpen: Date.now() < this.breakerUntil,
    };
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const numOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function normalise(mint: string, coin: Record<string, unknown>): HypeSnapshot {
  const now = Date.now();
  const created = numOf(coin.created_timestamp) || now;
  const ageSeconds = Math.max(1, (now - created) / 1000);
  const replyCount = numOf(coin.reply_count);
  const lastReply = numOf(coin.last_reply);

  const lastTrade = numOf(coin.last_trade_timestamp);
  return {
    mint,
    symbol: str(coin.symbol) || '?',
    name: str(coin.name) || '?',
    lastTradeAgoSeconds: lastTrade > 0 ? (now - lastTrade) / 1000 : null,
    graduated: coin.complete === true,
    replyCount,
    repliesPerMinute: replyCount / (ageSeconds / 60),
    lastReplyAgoSeconds: lastReply > 0 ? (now - lastReply) / 1000 : null,
    ageSeconds,
    hasTwitter: str(coin.twitter).length > 0,
    hasTelegram: str(coin.telegram).length > 0,
    hasWebsite: str(coin.website).length > 0,
    isCurrentlyLive: coin.is_currently_live === true,
    reachedKingOfTheHill: numOf(coin.king_of_the_hill_timestamp) > 0,
    marketCapSol: numOf(coin.market_cap),
    athMarketCapSol: numOf(coin.ath_market_cap),
    nsfw: coin.nsfw === true,
    isBanned: coin.is_banned === true,
    verified: coin.verified === true,
  fetchedAt: now,
  };
}

export interface HypeVerdict {
  passed: boolean;
  reason?: string;
  score: number;
}

export interface HypeRules {
  /** Minimum comments on the coin's page. 0 disables the check. */
  minReplies: number;
  /** Minimum comments per minute since launch. 0 disables. */
  minRepliesPerMinute: number;
  /** Require at least one of twitter, telegram or website. */
  requireSocial: boolean;
  /** Reject a token already well below the peak it reached. 0 disables. */
  maxDrawdownFromAthPct: number;
  /** Minimum combined score, when a score is preferred to individual gates. */
  minScore: number;
}

/**
 * A single number for how much attention a token has, so it can be swept like any
 * other parameter rather than argued about.
 *
 * The weights are a starting point, not a finding. Nothing here is trusted until the
 * offline replay says the fields separate outcomes — which is exactly the test that
 * killed the last two things that looked promising.
 */
export function hypeScore(snapshot: HypeSnapshot): number {
  let score = 0;
  // Attention, with diminishing returns: the step from 0 to 10 comments means far
  // more than the step from 100 to 110.
  score += Math.min(30, Math.log10(1 + snapshot.replyCount) * 15);
  score += Math.min(25, snapshot.repliesPerMinute * 5);
  // Somebody bothered to set these up. Weak on its own, but nearly free.
  if (snapshot.hasTwitter) score += 8;
  if (snapshot.hasTelegram) score += 6;
  if (snapshot.hasWebsite) score += 4;
  if (snapshot.isCurrentlyLive) score += 10;
  if (snapshot.reachedKingOfTheHill) score += 12;
  // A conversation that stopped is not attention.
  if (snapshot.lastReplyAgoSeconds !== null && snapshot.lastReplyAgoSeconds < 120) score += 10;
  // Already had its run.
  if (snapshot.athMarketCapSol > 0 && snapshot.marketCapSol < snapshot.athMarketCapSol * 0.5) {
    score -= 15;
  }
  return Math.round(score);
}

export function judgeHype(snapshot: HypeSnapshot | null, rules: HypeRules): HypeVerdict {
  // Fail closed: no data is not a pass.
  if (!snapshot) return { passed: false, reason: 'no pump.fun data (failed closed)', score: 0 };
  if (snapshot.isBanned) return { passed: false, reason: 'banned on pump.fun', score: 0 };

  const score = hypeScore(snapshot);
  if (rules.minReplies > 0 && snapshot.replyCount < rules.minReplies) {
    return { passed: false, reason: `only ${snapshot.replyCount} comments`, score };
  }
  if (rules.minRepliesPerMinute > 0 && snapshot.repliesPerMinute < rules.minRepliesPerMinute) {
    return {
      passed: false,
      reason: `${snapshot.repliesPerMinute.toFixed(1)} comments/min`,
      score,
    };
  }
  if (
    rules.requireSocial &&
    !snapshot.hasTwitter &&
    !snapshot.hasTelegram &&
    !snapshot.hasWebsite
  ) {
    return { passed: false, reason: 'no socials', score };
  }
  if (rules.maxDrawdownFromAthPct > 0 && snapshot.athMarketCapSol > 0) {
    const drawdown = (1 - snapshot.marketCapSol / snapshot.athMarketCapSol) * 100;
    if (drawdown > rules.maxDrawdownFromAthPct) {
      return { passed: false, reason: `${drawdown.toFixed(0)}% below its peak`, score };
    }
  }
  if (score < rules.minScore) {
    return { passed: false, reason: `hype score ${score} below ${rules.minScore}`, score };
  }
  return { passed: true, score };
}
