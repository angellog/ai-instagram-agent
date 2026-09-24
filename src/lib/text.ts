/**
 * Small, dependency-free text utilities for repetition scoring and keyword
 * retrieval. Lexical on purpose: deterministic, free, fast and testable. An
 * embedding provider can be layered on later without changing callers.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have i i'm im in is it it's its just me my of on or so " +
    "that the their them then there these this to too was we were what when where which who why will " +
    "with you your yours our us they he she his her not no yes do does did done can could would should " +
    "about into out up down over again very really more most some any all am been being if than also get got"
  ).split(" "),
);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#]/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(text: string, { keepStopwords = false } = {}): string[] {
  const out = normalize(text).split(" ").filter(Boolean);
  return keepStopwords ? out : out.filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

export function shingles(text: string, n = 3): Set<string> {
  const t = tokens(text, { keepStopwords: true });
  const out = new Set<string>();
  if (t.length < n) {
    if (t.length) out.add(t.join(" "));
    return out;
  }
  for (let i = 0; i <= t.length - n; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Cosine similarity of term-frequency vectors over content words. */
export function cosine(a: string, b: string): number {
  const va = termFreq(tokens(a));
  const vb = termFreq(tokens(b));
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of va) {
    na += v * v;
    const w = vb.get(k);
    if (w) dot += v * w;
  }
  for (const v of vb.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function termFreq(ts: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/**
 * Blended lexical similarity in [0,1]: max of word-cosine and 3-gram jaccard,
 * so both reworded-same-topic and copy-pasted-phrase repetition score high.
 */
export function similarity(a: string, b: string): number {
  if (!a.trim() || !b.trim()) return 0;
  return Math.max(cosine(a, b), jaccard(shingles(a), shingles(b)));
}

/** Whole-word (or whole-phrase) keyword containment, script-agnostic. */
export function containsKeyword(text: string, keyword: string): boolean {
  const t = ` ${normalize(text)} `;
  const k = normalize(keyword);
  return k.length > 0 && t.includes(` ${k} `);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** True when a message carries no words at all (emoji, punctuation, tags). */
export function isLowContent(text: string): boolean {
  const withoutTags = text.replace(/[@#][\p{L}\p{N}_.]+/gu, " ");
  return tokens(withoutTags, { keepStopwords: true }).filter((t) => /\p{L}/u.test(t)).length === 0;
}
