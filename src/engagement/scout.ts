import { z } from "zod";
import { getControls } from "../config/controls.js";
import { setting } from "../config/settings.js";
import { influencerId } from "../context.js";
import { many, one } from "../db/pool.js";
import { PermanentError, TransientError, errorMessage } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { llm } from "../llm/llm.js";
import { persona } from "../persona/loader.js";
import { personaSystemBlock } from "../persona/prompt.js";
import { namesBrand } from "../persona/pronouns.js";
import type { Persona } from "../persona/schema.js";
import { assessText } from "../safety/safety.js";

/**
 * Engagement scout (v1.0.29). The influencer "hanging out" on Instagram, the
 * compliant way: Instagram's API lets an app read public posts for a hashtag
 * (Facebook Login + Instagram Public Content Access) but never lets it like or
 * comment on another account's post. So the scout reads posts the influencer
 * would care about, drafts one comment each in their voice, and queues them for
 * a person to open the post and post the comment (and like it) by hand.
 * Links a person pastes work the same way and need no token at all.
 *
 * Meta allows 30 different hashtags per 7 days per searching account; every
 * lookup is recorded and the budget is checked before a new hashtag is used.
 */

export const HASHTAG_WEEKLY_LIMIT = 30;
const GRAPH = "https://graph.facebook.com/v25.0";
const MAX_COMMENT = 150;

export interface ScoutPost {
  source: "hashtag" | "link";
  permalink: string;
  caption: string;
  mediaId?: string;
  hashtag?: string;
  author?: string;
  likes?: number;
  comments?: number;
}

let scoutFetch: typeof fetch = fetch;
/** Tests swap the network. */
export function setScoutFetch(f?: typeof fetch): void {
  scoutFetch = f ?? fetch;
}

async function graph<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const res = await scoutFetch(url, { signal: AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
  if (!res.ok || body.error) {
    const msg = `Instagram hashtag search: ${body.error?.message ?? res.status}`;
    if (res.status === 429 || res.status >= 500 || body.error?.code === 4 || body.error?.code === 32) throw new TransientError(msg);
    throw new PermanentError(msg);
  }
  return body;
}

/** The scout's Facebook Login credentials, or why the scout can't search. */
export async function scoutCredentials(): Promise<{ token: string; userId: string } | { missing: string }> {
  const [token, userId] = await Promise.all([setting("META_SCOUT_TOKEN"), setting("META_SCOUT_IG_USER_ID")]);
  if (!token || !userId) return { missing: "hashtag search needs a Facebook Login scout token and account ID (Config & keys → Instagram); paste links instead until then" };
  return { token, userId };
}

/** Hashtags this searching account used in the last 7 days (each counts once). */
export async function hashtagsThisWeek(userId: string): Promise<Map<string, string | null>> {
  const rows = await many<{ hashtag: string; hashtag_id: string | null }>(
    "SELECT DISTINCT ON (hashtag) hashtag, hashtag_id FROM hashtag_queries WHERE scout_user_id = $1 AND queried_at > now() - interval '7 days' ORDER BY hashtag, queried_at DESC",
    [userId],
  );
  return new Map(rows.map((r) => [r.hashtag, r.hashtag_id]));
}

/** Which of the persona's hashtags to read now: already-used ones are free, new ones only while the weekly budget lasts. */
export function chooseHashtags(wanted: string[], used: Map<string, unknown>, n: number, seed = Date.now()): string[] {
  const clean = [...new Set(wanted.map((h) => h.replace(/^#+/, "").toLowerCase().trim()).filter(Boolean))];
  // Rotate through the list day by day (the same tags all day), then keep within the weekly budget.
  const start = clean.length ? Math.floor(seed / 86_400_000) % clean.length : 0;
  let left = Math.max(0, HASHTAG_WEEKLY_LIMIT - used.size);
  const out: string[] = [];
  for (const h of [...clean.slice(start), ...clean.slice(0, start)]) {
    if (out.length >= n) break;
    if (used.has(h)) out.push(h);
    else if (left > 0) {
      out.push(h);
      left--;
    }
  }
  return out;
}

/** Recent public posts for one hashtag (Meta returns the last 24 hours). */
export async function searchHashtag(tag: string, cred: { token: string; userId: string }): Promise<ScoutPost[]> {
  const used = await hashtagsThisWeek(cred.userId);
  let id = used.get(tag) ?? null;
  if (!id) {
    if (used.size >= HASHTAG_WEEKLY_LIMIT) throw new PermanentError(`weekly hashtag limit (${HASHTAG_WEEKLY_LIMIT}) reached`);
    const r = await graph<{ data?: Array<{ id: string }> }>("ig_hashtag_search", { user_id: cred.userId, q: tag }, cred.token);
    id = r.data?.[0]?.id ?? null;
  }
  await one("INSERT INTO hashtag_queries (scout_user_id, hashtag, hashtag_id, influencer_id) VALUES ($1, $2, $3, $4)", [cred.userId, tag, id, influencerId()]);
  if (!id) return [];
  const media = await graph<{ data?: Array<{ id: string; caption?: string; permalink?: string; like_count?: number; comments_count?: number }> }>(
    `${id}/recent_media`,
    { user_id: cred.userId, fields: "id,caption,permalink,media_type,timestamp,like_count,comments_count", limit: "30" },
    cred.token,
  );
  return (media.data ?? []).filter((m) => m.permalink).map((m) => ({ source: "hashtag" as const, permalink: m.permalink!, caption: m.caption ?? "", mediaId: m.id, hashtag: tag, likes: m.like_count, comments: m.comments_count }));
}

const IG_POST = /^https:\/\/(www\.)?instagram\.com\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)/i;

/**
 * Links a person pasted: one post per line, the link and then what it shows
 * (its caption, or a few words). "link | what it shows" or the text on the next line.
 */
export function parseLinks(text: string): { posts: ScoutPost[]; problems: string[] } {
  const posts: ScoutPost[] = [];
  const problems: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = IG_POST.exec(lines[i]);
    if (!m) {
      if (!posts.length || posts.at(-1)!.caption) problems.push(`not an Instagram post link: "${lines[i].slice(0, 60)}"`);
      else posts.at(-1)!.caption = lines[i].slice(0, 1500);
      continue;
    }
    const permalink = `https://www.instagram.com/${m[2].toLowerCase().startsWith("reel") ? "reel" : m[2].toLowerCase()}/${m[3]}/`;
    const rest = lines[i].slice(m[0].length).replace(/^[/?#][^\s|]*/, "").replace(/^\s*[|:–-]\s*/, "").trim();
    posts.push({ source: "link", permalink, caption: rest.slice(0, 1500) });
  }
  for (const p of posts) if (!p.caption) problems.push(`${p.permalink}: add what the post shows or its caption, so the comment can be about it`);
  return { posts: posts.filter((p) => p.caption), problems };
}

const draftSchema = z.object({
  drafts: z.array(
    z.object({
      index: z.number().int(),
      comment: z.string().describe(`One line, max ${MAX_COMMENT} characters; empty when skipping`),
      skip: z.string().nullable().describe("Why this post shouldn't get a comment, or null"),
    }),
  ),
});

function draftSystem(p: Persona): string {
  const e = p.engagement;
  return `${personaSystemBlock(p)}

---
You are scrolling Instagram as yourself and leaving a comment on other people's posts, the way a real person does: because something in the post caught your eye.
How you comment: ${e.comment_style || "short, specific and warm"}.
Rules for every comment:
- One line, under ${MAX_COMMENT} characters, about something SPECIFIC in that post's caption (the pair, the place, the moment, the joke). Never generic ("nice pic", "love this", "🔥🔥").
- Playful and kind. You may tease about football clubs or ask a light question. Never romantic or sexual, never flirt with the person, never comment on anyone's body or looks.
- Never sell: no brand names, no links, no hashtags, no @mentions, no "check out my page", no prices.
- Don't pretend you were there or bought something. Don't ask for personal details.
- Skip (comment "" and say why) posts that are ads or giveaways, about grief, illness, accidents, politics or religion debates, posts by or about children, anything you'd feel weird commenting on as a stranger, or captions you can't understand.
Return JSON only.`;
}

/** Draft comments in the influencer's voice for a batch of posts; unsafe or off-brief drafts are dropped. */
export async function draftComments(posts: ScoutPost[]): Promise<Array<{ post: ScoutPost; comment: string } | { post: ScoutPost; skipped: string }>> {
  if (!posts.length) return [];
  const p = persona();
  const out = await llm().structured(draftSchema, {
    operation: "engagement.draft",
    tier: "smart",
    maxTokens: 2500,
    temperature: 0.8,
    system: draftSystem(p),
    prompt: `POSTS (index | hashtag | caption):\n${posts.map((x, i) => `${i} | ${x.hashtag ? `#${x.hashtag}` : "pasted"} | ${x.caption.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}\n\nOne entry per post, by index.`,
  });
  const results: Array<{ post: ScoutPost; comment: string } | { post: ScoutPost; skipped: string }> = [];
  for (const [i, post] of posts.entries()) {
    const d = out.drafts.find((x) => x.index === i);
    const comment = (d?.comment ?? "").replace(/\s+/g, " ").trim();
    if (!d || d.skip || !comment) {
      results.push({ post, skipped: d?.skip || "no comment drafted" });
      continue;
    }
    const why = commentProblems(comment, p);
    if (why) {
      results.push({ post, skipped: why });
      continue;
    }
    const a = await assessText(comment, { direction: "outbound", context: "comment on another account's post" });
    if (a.level !== "green") {
      results.push({ post, skipped: `safety: ${a.categories.join(", ") || a.level}` });
      continue;
    }
    results.push({ post, comment });
  }
  return results;
}

/** House rules for a drafted comment, checked in code whatever the model wrote. */
export function commentProblems(comment: string, p: Persona): string | undefined {
  if ([...comment].length > MAX_COMMENT) return "too long";
  if (/https?:\/\/|www\./i.test(comment)) return "has a link";
  if (/(^|\s)[@#][\w.]/.test(comment)) return "has a tag or hashtag";
  if (p.brand && namesBrand(comment, p.brand.name)) return "names the brand";
  if (/^(nice|great|cool|beautiful|amazing|love (this|it))[!. ]*[\p{Emoji}\s]*$/iu.test(comment)) return "generic";
  return undefined;
}

/** Store drafts (a post already in the queue is never drafted twice). */
async function saveDrafts(items: Array<{ post: ScoutPost; comment: string }>): Promise<number> {
  let saved = 0;
  for (const { post, comment } of items) {
    const r = await one<{ id: number }>(
      `INSERT INTO engagement_drafts (influencer_id, source, hashtag, ig_media_id, permalink, author, caption, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (influencer_id, permalink) DO NOTHING RETURNING id`,
      [influencerId(), post.source, post.hashtag ?? null, post.mediaId ?? null, post.permalink, post.author ?? null, post.caption.slice(0, 2000), comment],
    );
    if (r) saved++;
  }
  return saved;
}

/** Posts worth a comment: has words, isn't ours, isn't queued already, isn't huge or dead. */
async function shortlist(posts: ScoutPost[], need: number): Promise<ScoutPost[]> {
  const known = new Set(
    (await many<{ permalink: string }>("SELECT permalink FROM engagement_drafts WHERE influencer_id = $1", [influencerId()])).map((r) => r.permalink),
  );
  const ours = new Set((await many<{ ig_media_id: string }>("SELECT ig_media_id FROM posts WHERE influencer_id = $1 AND ig_media_id IS NOT NULL", [influencerId()])).map((r) => r.ig_media_id));
  const seen = new Set<string>();
  return posts
    .filter((x) => {
      if (seen.has(x.permalink) || known.has(x.permalink) || (x.mediaId && ours.has(x.mediaId))) return false;
      seen.add(x.permalink);
      const words = x.caption.replace(/#[\p{L}\p{N}_]+/gu, "").trim();
      return words.length >= 15 && !/giveaway|promo code|link in bio|dm (us|to order)|whatsapp|\bsale\b|discount/i.test(x.caption);
    })
    .sort((a, b) => (b.comments ?? 0) + (b.likes ?? 0) / 10 - ((a.comments ?? 0) + (a.likes ?? 0) / 10))
    .slice(0, need);
}

export type ScoutOutcome = { status: "skipped"; reason: string } | { status: "done"; drafted: number; skipped: number; hashtags: string[] };

/** Today's drafts still allowed by the influencer's daily cap. */
async function roomToday(cap: number): Promise<number> {
  const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM engagement_drafts WHERE influencer_id = $1 AND created_at > now() - interval '24 hours'", [influencerId()]);
  return Math.max(0, cap - (n?.n ?? 0));
}

/** The daily scout run: read a couple of the persona's hashtags and queue drafted comments. */
export async function runScout(now = new Date()): Promise<ScoutOutcome> {
  const c = await getControls();
  if (c.paused || !c.scout_enabled) return { status: "skipped", reason: "the engagement scout is off or the influencer is paused" };
  const p = persona();
  if (!p.engagement.scout_hashtags.length) return { status: "skipped", reason: "no scout hashtags in the persona (Standard → Engagement scout set up)" };
  const room = await roomToday(c.scout_daily_drafts);
  if (!room) return { status: "skipped", reason: `scout_daily_drafts (${c.scout_daily_drafts}) reached` };
  const cred = await scoutCredentials();
  if ("missing" in cred) return { status: "skipped", reason: cred.missing };
  const tags = chooseHashtags(p.engagement.scout_hashtags, await hashtagsThisWeek(cred.userId), 2, now.getTime());
  if (!tags.length) return { status: "skipped", reason: `weekly hashtag limit (${HASHTAG_WEEKLY_LIMIT}) reached` };
  const found: ScoutPost[] = [];
  for (const t of tags) {
    try {
      found.push(...(await searchHashtag(t, cred)));
    } catch (e) {
      if (e instanceof TransientError) throw e;
      await recordEvent("warn", "engagement", `Scout couldn't read #${t}`, { error: errorMessage(e) });
    }
  }
  const results = await draftComments(await shortlist(found, room));
  const drafted = await saveDrafts(results.filter((r): r is { post: ScoutPost; comment: string } => "comment" in r));
  await recordEvent("info", "engagement", "Scout drafted comments", { hashtags: tags, found: found.length, drafted });
  return { status: "done", drafted, skipped: results.length - drafted, hashtags: tags };
}

/** Pasted links: drafted right away, no token needed. */
export async function scoutLinks(text: string): Promise<{ drafted: number; skipped: string[]; problems: string[] }> {
  const { posts, problems } = parseLinks(text);
  const results = await draftComments(await shortlist(posts, 20));
  const ok = results.filter((r): r is { post: ScoutPost; comment: string } => "comment" in r);
  const drafted = await saveDrafts(ok);
  const skipped = results.filter((r): r is { post: ScoutPost; skipped: string } => "skipped" in r).map((r) => `${r.post.permalink}: ${r.skipped}`);
  const dropped = posts.length - results.length;
  return { drafted, skipped, problems: dropped ? [...problems, `${dropped} already in the queue or too short to comment on`] : problems };
}

export interface Draft {
  id: number;
  source: string;
  hashtag: string | null;
  permalink: string;
  caption: string;
  comment: string;
  status: string;
  created_at: Date;
  acted_at: Date | null;
}

export async function listDrafts(status: "new" | "done" | "skipped", limit = 40): Promise<Draft[]> {
  return many<Draft>(
    "SELECT id, source, hashtag, permalink, caption, comment, status, created_at, acted_at FROM engagement_drafts WHERE influencer_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3",
    [influencerId(), status, limit],
  );
}

export async function markDraft(id: number, status: "done" | "skipped", by: string, comment?: string): Promise<void> {
  const r = await one(
    "UPDATE engagement_drafts SET status = $3, acted_at = now(), acted_by = $4, comment = coalesce($5, comment) WHERE id = $1 AND influencer_id = $2 RETURNING id",
    [id, influencerId(), status, by, comment?.trim() ? comment.trim().slice(0, 300) : null],
  );
  if (!r) throw new PermanentError("draft not found");
}
