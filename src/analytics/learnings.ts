import { many, one } from "../db/pool.js";
import { hasAccount, instagramClient } from "../instagram/accounts.js";
import { recordEvent } from "../lib/events.js";
import { upsertMemory } from "../memory/store.js";
import { applyMemoryPolicy } from "../memory/policy.js";
import { errorMessage } from "../lib/errors.js";

/**
 * Engagement engine (brief §10): POST → ENGAGEMENT → ANALYTICS → PATTERN
 * DETECTION → CONTENT MEMORY → FUTURE CONTENT DECISION.
 * Multiple signals, weighted toward intent (saves, shares, follows) rather
 * than likes, normalized by reach so a small account's posts compare fairly.
 */

export const MEDIA_METRICS = ["reach", "views", "likes", "comments", "saved", "shares", "total_interactions", "profile_visits", "follows"];

export const CHECKPOINTS = [
  { name: "24h", delayMs: 24 * 3600_000 },
  { name: "72h", delayMs: 72 * 3600_000 },
  { name: "7d", delayMs: 7 * 24 * 3600_000 },
] as const;

export interface Metrics {
  reach?: number;
  views?: number;
  likes?: number;
  comments?: number;
  saves?: number;
  shares?: number;
  profile_visits?: number;
  follows?: number;
  total_interactions?: number;
}

/** 0-100ish engagement quality score. Pure; unit-tested. */
export function engagementScore(m: Metrics): number {
  const reach = Math.max(m.reach ?? 0, 1);
  const weighted =
    (m.likes ?? 0) * 1 +
    (m.comments ?? 0) * 3 +
    (m.saves ?? 0) * 4 +
    (m.shares ?? 0) * 4 +
    (m.profile_visits ?? 0) * 1.5 +
    (m.follows ?? 0) * 8;
  // Rate per reached account, scaled; mild reach bonus (log) so a post that
  // travelled far is not punished for a lower rate.
  const rate = (weighted / reach) * 100;
  const reachBonus = Math.log10(reach + 1) * 2;
  return Math.round((rate + reachBonus) * 100) / 100;
}

/** `engagement.collect`: pull insights for one post at one checkpoint. */
export async function collectEngagement(postId: string, checkpoint: string): Promise<Metrics | undefined> {
  const post = await one<{ ig_media_id: string | null; status: string }>("SELECT ig_media_id, status FROM posts WHERE id = $1", [postId]);
  if (!post?.ig_media_id || post.status !== "published") return undefined;
  const ig = await instagramClient();
  const raw = await ig.getMediaInsights(post.ig_media_id, MEDIA_METRICS);
  let media: { like_count?: number; comments_count?: number } = {};
  try {
    media = await ig.getMedia(post.ig_media_id);
  } catch {
    // insights are the primary source; counts are a fallback only
  }
  const m: Metrics = {
    reach: raw.reach,
    views: raw.views,
    likes: raw.likes ?? media.like_count,
    comments: raw.comments ?? media.comments_count,
    saves: raw.saved,
    shares: raw.shares,
    profile_visits: raw.profile_visits,
    follows: raw.follows,
    total_interactions: raw.total_interactions,
  };
  const score = engagementScore(m);
  await one(
    `INSERT INTO engagement_metrics (post_id, ig_media_id, checkpoint, reach, views, likes, comments, saves, shares, profile_visits, follows, total_interactions, score, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (post_id, checkpoint) DO UPDATE SET reach = EXCLUDED.reach, views = EXCLUDED.views, likes = EXCLUDED.likes,
       comments = EXCLUDED.comments, saves = EXCLUDED.saves, shares = EXCLUDED.shares, profile_visits = EXCLUDED.profile_visits,
       follows = EXCLUDED.follows, total_interactions = EXCLUDED.total_interactions, score = EXCLUDED.score, raw = EXCLUDED.raw, collected_at = now()`,
    [postId, post.ig_media_id, checkpoint, m.reach ?? null, m.views ?? null, m.likes ?? null, m.comments ?? null, m.saves ?? null, m.shares ?? null, m.profile_visits ?? null, m.follows ?? null, m.total_interactions ?? null, score, JSON.stringify(raw)],
  );
  return m;
}

/** `account.collect`: daily account snapshot. */
export async function collectAccount(now = new Date()): Promise<void> {
  if (!(await hasAccount())) return; // nothing to measure before an account is connected
  const ig = await instagramClient();
  const profile = await ig.getProfile();
  let insights: Record<string, number> = {};
  try {
    insights = await ig.getAccountInsights(["reach", "views", "accounts_engaged", "total_interactions"], new Date(now.getTime() - 86_400_000), now);
  } catch (e) {
    await recordEvent("warn", "analytics", "Account insights unavailable", { error: errorMessage(e) });
  }
  await one(
    `INSERT INTO account_metrics (day, followers, reach, profile_views, accounts_engaged, raw)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (day) DO UPDATE SET followers = EXCLUDED.followers, reach = EXCLUDED.reach, profile_views = EXCLUDED.profile_views,
       accounts_engaged = EXCLUDED.accounts_engaged, raw = EXCLUDED.raw, collected_at = now()`,
    [now.toISOString().slice(0, 10), profile.followers_count ?? null, insights.reach ?? null, insights.views ?? null, insights.accounts_engaged ?? null, JSON.stringify({ profile, insights })],
  );
}

const PRIOR_N = 3;

/**
 * `analytics.process`: recompute learnings from each post's latest checkpoint.
 * Bayesian shrinkage toward the global mean (prior weight 3 posts) keeps one
 * lucky post from dominating what the director believes.
 */
export async function processAnalytics(): Promise<{ posts: number; dimensions: number }> {
  const rows = await many<{
    post_id: string;
    score: number;
    format: string;
    structure: string;
    activity: string | null;
    slot: string | null;
    location: string | null;
    topic: string;
  }>(
    `SELECT DISTINCT ON (p.id) p.id AS post_id, em.score, ci.format, ci.structure, a.activity, a.slot,
            coalesce(p.visual_state->>'location_id', a.location) AS location, ci.topic
     FROM posts p
     JOIN engagement_metrics em ON em.post_id = p.id
     JOIN content_ideas ci ON ci.id = p.content_idea_id
     LEFT JOIN activities a ON a.id = ci.activity_id
     WHERE p.status = 'published' AND em.score IS NOT NULL
     ORDER BY p.id, em.collected_at DESC`,
  );
  if (!rows.length) return { posts: 0, dimensions: 0 };
  const global = rows.reduce((s, r) => s + r.score, 0) / rows.length;
  const groups = new Map<string, { dimension: string; value: string; scores: number[] }>();
  const add = (dimension: string, value: string | null) => {
    if (!value) return;
    const k = `${dimension}\u0000${value}`;
    if (!groups.has(k)) groups.set(k, { dimension, value, scores: [] });
    return groups.get(k)!;
  };
  for (const r of rows) {
    for (const [d, v] of [
      ["format", r.format],
      ["structure", r.structure],
      ["activity", r.activity],
      ["slot", r.slot],
      ["location", r.location],
    ] as const) {
      add(d, v)?.scores.push(r.score);
    }
  }
  for (const g of groups.values()) {
    const n = g.scores.length;
    const mean = (g.scores.reduce((s, x) => s + x, 0) + PRIOR_N * global) / (n + PRIOR_N);
    await one(
      `INSERT INTO learnings (dimension, value, samples, mean_score, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (dimension, value) DO UPDATE SET samples = EXCLUDED.samples, mean_score = EXCLUDED.mean_score, updated_at = now()`,
      [g.dimension, g.value, n, Math.round(mean * 100) / 100],
    );
  }

  // Content memory: remember the best recent performers as world memory.
  const best = [...rows].sort((a, b) => b.score - a.score).slice(0, 3);
  for (const b of best) {
    const v = applyMemoryPolicy({ kind: "theme", content: `Performed well: ${b.topic} (${b.format}/${b.structure})`, confidence: 0.9, importance: 0.7 });
    if (v.store) await upsertMemory("world", null, v, { type: "post", id: b.post_id });
  }
  return { posts: rows.length, dimensions: groups.size };
}

/** Compact learnings block for the director prompt; empty until there is data. */
export async function learningsForPrompt(): Promise<string> {
  const rows = await many<{ dimension: string; value: string; samples: number; mean_score: number }>(
    "SELECT dimension, value, samples, mean_score FROM learnings WHERE samples >= 1 ORDER BY dimension, mean_score DESC",
  );
  if (!rows.length) return "";
  const byDim = new Map<string, typeof rows>();
  for (const r of rows) byDim.set(r.dimension, [...(byDim.get(r.dimension) ?? []), r]);
  return [...byDim.entries()]
    .map(([d, rs]) => `${d}: ${rs.slice(0, 5).map((r) => `${r.value}=${r.mean_score} (n=${r.samples})`).join(", ")}`)
    .join("\n");
}
