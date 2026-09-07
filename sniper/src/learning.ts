import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface KeywordStat {
  count: number;
  meanPct: number;
}

interface Memory {
  version: 1;
  trades: number;
  globalMeanPct: number;
  keywords: Record<string, KeywordStat>;
}

/**
 * How strongly a keyword is pulled back toward the overall average. With k=8, a keyword
 * seen three times carries about a quarter of its own evidence and three quarters of the
 * baseline. Without this a single lucky +200% would make its keyword look like a rule.
 */
const SHRINKAGE = 8;

/** Words too generic to carry signal, plus the ubiquitous ticker noise. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'this', 'that', 'with', 'coin', 'token',
  'official', 'pump', 'sol', 'solana', 'inu', 'meme',
]);

export function keywordsOf(name: string, symbol: string): string[] {
  const words = `${name} ${symbol}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // Two letters are kept on purpose: "ai" is among the strongest memecoin narratives
    // and a three-character minimum silently threw it away.
    .filter((w) => w.length >= 2 && w.length <= 20 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * Learns which words in a token's name have historically preceded good trades, and
 * scores new candidates by them.
 *
 * The honest caveat, kept in code because it governs how the numbers should be read:
 * with tens of trades and hundreds of distinct words, almost every keyword is seen once
 * or twice. Shrinkage keeps those from dominating, and scoring is withheld entirely
 * until enough trades exist to mean anything — but this needs hundreds of trades before
 * its output is worth acting on, not dozens.
 */
export class KeywordMemory {
  private memory: Memory = { version: 1, trades: 0, globalMeanPct: 0, keywords: {} };

  constructor(private readonly path: string) {
    this.load();
  }

  private load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Memory;
      if (parsed.version === 1) this.memory = parsed;
    } catch {
      // No memory yet, or it is unreadable; starting empty is correct either way.
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.memory, null, 2));
    } catch {
      // Losing the memory file is not worth interrupting trading over.
    }
  }

  record(name: string, symbol: string, pnlPct: number) {
    const m = this.memory;
    m.trades++;
    m.globalMeanPct += (pnlPct - m.globalMeanPct) / m.trades;

    for (const word of keywordsOf(name, symbol)) {
      const stat = m.keywords[word] ?? { count: 0, meanPct: 0 };
      stat.count++;
      stat.meanPct += (pnlPct - stat.meanPct) / stat.count;
      m.keywords[word] = stat;
    }
    this.save();
  }

  /** Null until there is enough history for a score to mean anything. */
  score(name: string, symbol: string, minTrades: number): number | null {
    const m = this.memory;
    if (m.trades < minTrades) return null;

    const seen = keywordsOf(name, symbol)
      .map((w) => m.keywords[w])
      .filter((s): s is KeywordStat => s !== undefined);
    if (seen.length === 0) return m.globalMeanPct;

    // Each keyword is pulled toward the baseline in proportion to how little it has
    // been seen, then averaged.
    const scores = seen.map(
      (s) => (s.count * s.meanPct + SHRINKAGE * m.globalMeanPct) / (s.count + SHRINKAGE),
    );
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  stats() {
    const entries = Object.entries(this.memory.keywords);
    const ranked = entries
      .filter(([, s]) => s.count >= 3)
      .map(([word, s]) => ({
        word,
        count: s.count,
        meanPct: s.meanPct,
        shrunk: (s.count * s.meanPct + SHRINKAGE * this.memory.globalMeanPct) / (s.count + SHRINKAGE),
      }))
      .sort((a, b) => b.shrunk - a.shrunk);

    return {
      trades: this.memory.trades,
      globalMeanPct: this.memory.globalMeanPct,
      distinctKeywords: entries.length,
      best: ranked.slice(0, 8),
      worst: ranked.slice(-8).reverse(),
    };
  }
}
