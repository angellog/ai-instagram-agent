import { z } from "zod";
import { influencerId, maybeInfluencer } from "../context.js";
import { many, one } from "../db/pool.js";
import { errorMessage } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { llm } from "../llm/llm.js";
import { persona } from "../persona/loader.js";
import { fetchFeed, googleNewsUrl, type Headline } from "./feeds.js";

/**
 * Trends and news awareness. Every 6 hours each influencer reads its own
 * news searches and feeds, and the model picks what this creator would
 * genuinely know about this week, skipping politics, tragedy and anything
 * divisive. The resulting brief feeds the content director and the
 * conversation agent, so posts and replies can nod to what's happening
 * without inventing details.
 */

const MAX_AGE_DAYS = 4;
export const BLOCKED = /\b(election|elections|president|parliament|minister|mp\b|opposition|protest|riot|police|arrest|murder|killed|dead|death|dies|died|shooting|attack|war|bomb|accident|crash|disaster|flood|fire|outbreak|ebola|covid|cholera|court|trial|charged|charges|guilty|jail|prison|sentenced|scandal|corruption|robbery|theft|fraud|funeral|burial|mourn\w*|body returns|troops|army|military|gaza|missile|hostage|refugee\w*)\b/i;

export const briefSchema = z.object({
  items: z
    .array(
      z.object({
        index: z.number().int().describe("the headline's number from the list"),
        note: z.string().describe("max 90 chars: what it is and why this creator would care, in plain words"),
        use: z.enum(["post", "conversation", "context"]),
      }),
    )
    .max(12),
});

export interface BriefItem {
  title: string;
  link: string;
  source: string;
  note: string;
  use: "post" | "conversation" | "context";
}

export interface TrendSource {
  kind: "search" | "feed";
  label: string;
  url: string;
  detail: string;
}

/** The persona's sources, normalised (strings or {query|url, label}). */
export function trendSources(p = persona()): TrendSource[] {
  const t = p.trends;
  return [
    ...t.queries.map((q) => {
      const query = typeof q === "string" ? q : q.query;
      const label = (typeof q === "string" ? undefined : q.label) ?? query.replace(/\s*when:\d+[hd]\b/, "");
      return { kind: "search" as const, label, url: googleNewsUrl(query, t.region, t.language), detail: query };
    }),
    ...t.feeds.map((f) => {
      const url = typeof f === "string" ? f : f.url;
      return { kind: "feed" as const, label: (typeof f === "string" ? undefined : f.label) ?? new URL(url).hostname, url, detail: url };
    }),
  ];
}

/** Fetch every configured source; store new headlines; returns the fresh ones (deduped by link). */
export async function collectHeadlines(): Promise<{ fresh: Headline[]; errors: string[] }> {
  const p = persona();
  const t = p.trends;
  const sources = trendSources(p);
  const errors: string[] = [];
  const all: Headline[] = [];
  for (const s of sources) {
    try {
      // The label (platform/topic) travels with each headline so the brief can balance them.
      all.push(...(await fetchFeed(s.url, s.label)).slice(0, 25).map((h) => ({ ...h, source: `${s.label} · ${h.source}` })));
    } catch (e) {
      errors.push(errorMessage(e));
    }
  }
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const fresh: Headline[] = [];
  const seen = new Set<string>();
  for (const h of all) {
    if (h.publishedAt && h.publishedAt.getTime() < cutoff) continue;
    const key = h.title.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 80);
    if (seen.has(h.link) || seen.has(key)) continue;
    seen.add(h.link);
    seen.add(key);
    fresh.push(h);
    await one(
      `INSERT INTO trend_items (influencer_id, source, title, link, published_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (influencer_id, link) DO NOTHING`,
      [influencerId(), h.source.slice(0, 120), h.title.slice(0, 400), h.link.slice(0, 1000), h.publishedAt],
    );
  }
  return { fresh, errors };
}

/** `trends.refresh`: collect, filter (rules, then the model), store the brief. */
export async function refreshTrends(): Promise<{ headlines: number; kept: number; errors: string[] }> {
  const p = persona();
  if (!p.trends.queries.length && !p.trends.feeds.length) return { headlines: 0, kept: 0, errors: [] };
  const { fresh, errors } = await collectHeadlines();
  const avoid = p.trends.avoid.map((a) => a.toLowerCase());
  // Round-robin across labels so one busy feed (e.g. football) can't crowd out the rest.
  const allowed = fresh.filter((h) => !BLOCKED.test(h.title) && !avoid.some((a) => h.title.toLowerCase().includes(a)));
  const byLabel = new Map<string, Headline[]>();
  for (const h of allowed) {
    const label = h.source.split(" · ")[0];
    byLabel.set(label, [...(byLabel.get(label) ?? []), h]);
  }
  const candidates: Headline[] = [];
  for (let i = 0; candidates.length < 48 && [...byLabel.values()].some((l) => l.length > i); i++) {
    for (const l of byLabel.values()) if (l[i]) candidates.push(l[i]);
  }
  if (!candidates.length) {
    await one("INSERT INTO trend_briefs (influencer_id, items, skipped) VALUES ($1, '[]', $2)", [influencerId(), fresh.length]);
    if (errors.length) await recordEvent("warn", "trends", "Some trend sources failed", { errors });
    return { headlines: fresh.length, kept: 0, errors };
  }
  const out = await llm().structured(briefSchema, {
    operation: "trends.brief",
    tier: "fast",
    maxTokens: 900,
    system: `You keep an Instagram creator current. Each headline is tagged with the platform or topic it comes from (for example what's trending on TikTok or X in the country, the Instagram scene in the city, football, international culture). Pick at most ${p.trends.max_items} that ${p.identity.name} (${p.identity.occupation}, ${p.identity.location}; into ${p.interests.join(", ")}) would genuinely know or talk about this week, spread across the tags (at most 2 per tag). Skip politics, elections, crime, deaths, disasters, health scares, anything divisive or sad, and anything they couldn't naturally relate to. Never add facts that aren't in the headline. Return JSON.`,
    prompt: candidates.map((h, i) => `${i + 1}. [${h.source.split(" · ")[0]}] ${h.title} (${h.source.split(" · ").slice(1).join(" · ") || "news"})`).join("\n"),
  });
  const items: BriefItem[] = out.items
    .map((it) => ({ h: candidates[it.index - 1], it }))
    .filter((x): x is { h: Headline; it: (typeof out.items)[number] } => Boolean(x.h) && !BLOCKED.test(x.it.note))
    .map(({ h, it }) => ({ title: h.title, link: h.link, source: h.source, note: it.note.slice(0, 140), use: it.use }))
    // The model doesn't always respect "at most 2 per tag"; enforce it so every source gets a voice.
    .filter(
      (
        (count) => (i: BriefItem) =>
          (count[i.source.split(" · ")[0]] = (count[i.source.split(" · ")[0]] ?? 0) + 1) <= 2
      )({} as Record<string, number>),
    )
    .slice(0, p.trends.max_items);
  await one("INSERT INTO trend_briefs (influencer_id, items, skipped) VALUES ($1, $2, $3)", [influencerId(), JSON.stringify(items), fresh.length - items.length]);
  await recordEvent("info", "trends", `Trends refreshed: ${items.length} kept of ${fresh.length}`, { errors: errors.length ? errors : undefined });
  return { headlines: fresh.length, kept: items.length, errors };
}

export async function latestBrief(id = influencerId()): Promise<{ items: BriefItem[]; created_at: Date; skipped: number } | undefined> {
  return one("SELECT items, created_at, skipped FROM trend_briefs WHERE influencer_id = $1 ORDER BY id DESC LIMIT 1", [id]);
}

/** Compact block for prompts; empty when there's no brief from the last 36 hours. */
export async function trendsForPrompt(purpose: "content" | "conversation"): Promise<string> {
  if (!maybeInfluencer()) return "";
  const b = await latestBrief().catch(() => undefined);
  if (!b || Date.now() - new Date(b.created_at).getTime() > 36 * 3600_000) return "";
  // Replies get the shorter, conversational slice; the director sees everything.
  const items = purpose === "content" ? b.items.slice(0, 8) : b.items.filter((i) => i.use !== "post").concat(b.items.filter((i) => i.use === "post")).slice(0, 4);
  return items.map((i) => `- [${i.source.split(" · ")[0]}] ${i.title}: ${i.note}`).join("\n");
}

export async function recentHeadlines(limit = 40) {
  return many<{ id: number; source: string; title: string; link: string; published_at: Date | null; fetched_at: Date }>(
    "SELECT id, source, title, link, published_at, fetched_at FROM trend_items WHERE influencer_id = $1 ORDER BY coalesce(published_at, fetched_at) DESC LIMIT $2",
    [influencerId(), limit],
  );
}
