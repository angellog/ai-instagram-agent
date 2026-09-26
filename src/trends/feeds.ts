import type { FetchLike } from "../lib/async.js";

/** Headline from any RSS 2.0 / Atom feed. */
export interface Headline {
  title: string;
  link: string;
  source: string;
  publishedAt: Date | null;
}

let fetchImpl: FetchLike = fetch;
/** Test hook. */
export function setTrendsFetch(f: FetchLike | undefined): void {
  fetchImpl = f ?? fetch;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

const tag = (block: string, name: string) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block)?.[1];

/** Minimal, dependency-free RSS/Atom reader (titles, links, dates only). */
export function parseFeed(xml: string, fallbackSource: string): Headline[] {
  const out: Headline[] = [];
  const channel = decode(tag(xml, "title") ?? fallbackSource);
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const title = decode(tag(b, "title") ?? "");
    const link = decode(tag(b, "link") ?? "");
    const date = tag(b, "pubDate") ?? tag(b, "dc:date");
    const source = decode(tag(b, "source") ?? channel);
    if (title && /^https?:\/\//.test(link)) out.push({ title, link, source, publishedAt: date ? new Date(decode(date)) : null });
  }
  for (const m of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const b = m[0];
    const title = decode(tag(b, "title") ?? "");
    const link = /<link\b[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? "";
    const date = tag(b, "published") ?? tag(b, "updated");
    if (title && /^https?:\/\//.test(link)) out.push({ title, link, source: channel, publishedAt: date ? new Date(decode(date)) : null });
  }
  return out.map((h) => ({ ...h, publishedAt: h.publishedAt && !Number.isNaN(h.publishedAt.getTime()) ? h.publishedAt : null }));
}

/** Google News search feed for a query in a region (free, no key). */
export function googleNewsUrl(query: string, region: string, language: string): string {
  const r = region.toUpperCase();
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:3d`)}&hl=${language}-${r}&gl=${r}&ceid=${r}:${language}`;
}

export async function fetchFeed(url: string, label: string): Promise<Headline[]> {
  const r = await fetchImpl(url, { headers: { "user-agent": "InfluencerOS/1.0 (+trends)", accept: "application/rss+xml, application/atom+xml, text/xml" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
  return parseFeed(await r.text(), label);
}
