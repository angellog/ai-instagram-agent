import { influencerId } from "../context.js";
import { many } from "../db/pool.js";
import type { Persona } from "../persona/schema.js";
import { rng } from "./activities.js";

/**
 * The influencer's life as a timeline (v1.0.29). Storylines (arcs) run for
 * weeks and move one small beat per post; a library of specific, local,
 * slightly imperfect moments keeps posts from reading like stock AI captions;
 * callbacks let a post quietly continue an earlier one; a circle of recurring
 * people gets named the way real friends do. What each post used is stored on
 * its idea (content_ideas.life), so progress and reuse are read from history
 * and a rejected or failed post gives its beat back.
 */

export type Arc = Persona["life"]["arcs"][number];

/** What a post or story took from the life timeline. */
export interface LifeUse {
  arc_id?: string;
  beat_index?: number;
  beat?: string;
  moment?: string;
  callback_post_id?: string;
}

export interface ArcProgress {
  arc: Arc;
  /** Beats already posted. */
  done: number;
  /** The next beat, or null when the storyline is finished. */
  next: string | null;
  lastBeat: string | null;
  lastAt: Date | null;
  /** The next beat may be posted now (pace: one beat per `every_days`). */
  due: boolean;
  /** Days until it's due (0 when due or finished). */
  waitDays: number;
}

export interface Callback {
  postId: string;
  topic: string;
  caption: string;
  daysAgo: number;
}

const LIVE = "ci.status IN ('accepted','produced') AND (p.id IS NULL OR p.status NOT IN ('rejected','failed','qc_failed'))";
const DAY = 86_400_000;

/** Where each storyline stands, read from what was actually posted. */
export async function arcProgress(p: Persona, now = new Date()): Promise<ArcProgress[]> {
  if (!p.life.arcs.length) return [];
  const rows = await many<{ arc_id: string; n: number; last_at: Date | null; last_beat: string | null }>(
    `SELECT ci.life->>'arc_id' AS arc_id, count(DISTINCT ci.life->>'beat_index')::int AS n, max(ci.created_at) AS last_at,
            (array_agg(ci.life->>'beat' ORDER BY ci.created_at DESC))[1] AS last_beat
     FROM content_ideas ci LEFT JOIN posts p ON p.content_idea_id = ci.id
     WHERE ci.influencer_id = $1 AND ci.life->>'arc_id' IS NOT NULL AND ${LIVE}
     GROUP BY 1`,
    [influencerId()],
  );
  const by = new Map(rows.map((r) => [r.arc_id, r]));
  return p.life.arcs.map((arc) => progressOf(arc, by.get(arc.id), now));
}

/** Pure: an arc's progress from its posted-beat count and last post time. */
export function progressOf(arc: Arc, row: { n: number; last_at: Date | null; last_beat: string | null } | undefined, now = new Date()): ArcProgress {
  const done = Math.min(row?.n ?? 0, arc.beats.length);
  const next = done < arc.beats.length ? arc.beats[done] : null;
  const lastAt = row?.last_at ? new Date(row.last_at) : null;
  const ready = lastAt ? lastAt.getTime() + arc.every_days * DAY : 0;
  const due = Boolean(next) && now.getTime() >= ready;
  return { arc, done, next, lastBeat: row?.last_beat ?? null, lastAt, due, waitDays: next && !due ? Math.ceil((ready - now.getTime()) / DAY) : 0 };
}

const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Moments used in the last `days` days (posts and stories). */
export async function usedMoments(days = 45): Promise<string[]> {
  const rows = await many<{ moment: string }>(
    `SELECT ci.life->>'moment' AS moment FROM content_ideas ci LEFT JOIN posts p ON p.content_idea_id = ci.id
     WHERE ci.influencer_id = $1 AND ci.life->>'moment' IS NOT NULL AND ci.created_at > now() - make_interval(days => $2) AND ${LIVE}`,
    [influencerId(), days],
  );
  return rows.map((r) => r.moment);
}

/** A few unused moments for today, the same set all day (seeded), fresh ones first. */
export function pickMoments(p: Persona, used: string[], day: string, n = 4): string[] {
  const seen = new Set(used.map(key));
  const fresh = p.life.moments.filter((m) => !seen.has(key(m)));
  const pool = fresh.length >= n ? fresh : [...fresh, ...p.life.moments.filter((m) => seen.has(key(m)))];
  const rand = rng(`${p.identity.name}:${day}:moments`);
  return pool
    .map((m) => ({ m, r: rand() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map((x) => x.m);
}

/** Published feed posts 4-30 days old that haven't been followed up yet: material for "update:" posts. */
export async function callbackCandidates(now = new Date(), limit = 4): Promise<Callback[]> {
  const rows = await many<{ id: string; topic: string; caption: string | null; published_at: Date }>(
    `SELECT p.id, ci.topic, p.caption, p.published_at FROM posts p JOIN content_ideas ci ON ci.id = p.content_idea_id
     WHERE p.influencer_id = $1 AND p.status = 'published' AND p.media_type <> 'STORY'
       AND p.published_at BETWEEN $2::timestamptz - interval '30 days' AND $2::timestamptz - interval '4 days'
       AND NOT EXISTS (SELECT 1 FROM content_ideas c2 WHERE c2.influencer_id = p.influencer_id AND c2.life->>'callback_post_id' = p.id::text)
     ORDER BY p.published_at DESC LIMIT $3`,
    [influencerId(), now, limit],
  );
  return rows.map((r) => ({ postId: r.id, topic: r.topic, caption: (r.caption ?? "").replace(/\s+/g, " ").replace(/#[\p{L}\p{N}_]+/gu, "").trim().slice(0, 100), daysAgo: Math.round((now.getTime() - new Date(r.published_at).getTime()) / DAY) }));
}

export interface LifeContext {
  arcs: ArcProgress[];
  moments: string[];
  callbacks: Callback[];
}

/** Everything the director needs from the timeline, for one moment in the day. */
export async function lifeContext(p: Persona, day: string, now = new Date(), o: { callbacks?: boolean } = {}): Promise<LifeContext> {
  const [arcs, used, callbacks] = await Promise.all([arcProgress(p, now), usedMoments(), o.callbacks === false ? Promise.resolve([]) : callbackCandidates(now)]);
  return { arcs, moments: pickMoments(p, used, day), callbacks };
}

const circleLine = (p: Persona) => p.life.circle.map((c) => `${c.name} (${c.who})`).join("; ");

/** The prompt block: storylines, people, moments and callbacks. */
export function lifeBlock(p: Persona, ctx: LifeContext, kind: "post" | "story"): string {
  if (!p.life.arcs.length && !p.life.moments.length && !p.life.circle.length) return "";
  const arcs = ctx.arcs
    .filter((a) => a.next)
    .map(
      (a) =>
        `- [${a.arc.id}] ${a.arc.title}: ${a.arc.story} Beat ${a.done + 1} of ${a.arc.beats.length}${a.lastBeat ? ` (last: "${a.lastBeat}")` : ""}. NEXT BEAT: "${a.next}". ${
          a.due ? "DUE: fits today if the moment is right." : `Not due for ${a.waitDays} more day${a.waitDays === 1 ? "" : "s"}; leave it.`
        }`,
    );
  const finished = ctx.arcs.filter((a) => !a.next).map((a) => a.arc.title);
  return [
    `YOUR LIFE RIGHT NOW (a timeline people follow, not a stock photo library). Build this ${kind} on ONE real, specific thing from here or from today's plan:`,
    arcs.length
      ? `STORYLINES (they run for weeks; one small beat per ${kind}, never the whole story at once; set "arc_id" when this ${kind} moves one forward):\n${arcs.join("\n")}`
      : "",
    finished.length ? `FINISHED STORYLINES (a look-back is fine, rarely): ${finished.join("; ")}` : "",
    p.life.circle.length
      ? `PEOPLE IN YOUR LIFE (name one sometimes, the way real people mention friends; never their faces in a photo: at most a hand, a back or a blurred shoulder): ${circleLine(p)}`
      : "",
    ctx.moments.length
      ? `SMALL MOMENTS YOU COULD USE (at most one; keep it specific and a little imperfect, the detail is the point; put it in "moment"):\n${ctx.moments.map((m) => `- ${m}`).join("\n")}`
      : "",
    kind === "post" && ctx.callbacks.length
      ? `CALLBACKS (earlier posts you could quietly continue: an update, how it turned out, a running joke; set "callback_post_id"):\n${ctx.callbacks.map((c) => `- [${c.postId}] ${c.daysAgo} days ago: "${c.topic}"${c.caption ? `, caption "${c.caption}"` : ""}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** For chats: what's going on lately, so small talk matches the feed. */
export async function lifeForChat(p: Persona, now = new Date()): Promise<string> {
  if (!p.life.arcs.length && !p.life.circle.length) return "";
  try {
    const arcs = await arcProgress(p, now);
    const lines = arcs.filter((a) => a.done > 0).map((a) => `${a.arc.title}: lately "${a.lastBeat ?? a.arc.beats[a.done - 1]}"${a.next ? `, coming up "${a.next}"` : " (done)"}`);
    return [lines.length ? `Storylines: ${lines.join("; ")}` : "", p.life.circle.length ? `People in your life: ${circleLine(p)}` : ""].filter(Boolean).join(". ");
  } catch {
    return "";
  }
}

/**
 * Validate what the director says it used: a real arc (its next beat), a moment
 * from the list (or its own specific one), a callback that was offered.
 */
export function resolveLife(p: Persona, ctx: LifeContext, picked: { arc_id?: string | null; moment?: string | null; callback_post_id?: string | null }): LifeUse | undefined {
  const out: LifeUse = {};
  const arc = picked.arc_id ? ctx.arcs.find((a) => a.arc.id === picked.arc_id && a.next) : undefined;
  if (arc) {
    out.arc_id = arc.arc.id;
    out.beat_index = arc.done;
    out.beat = arc.next!;
  }
  const moment = (picked.moment ?? "").trim();
  if (moment.length >= 12) out.moment = moment.slice(0, 300);
  if (picked.callback_post_id && ctx.callbacks.some((c) => c.postId === picked.callback_post_id)) out.callback_post_id = picked.callback_post_id;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- anti-generic

/** Stock lines that make a feed read as AI: a caption built on one gets sent back. */
export const GENERIC: Array<[RegExp, string]> = [
  [/\bliving (my|our|the) best li(fe|ves)\b/i, "living my best life"],
  [/\bgood vibes\b|\bvibes only\b/i, "good vibes"],
  [/\bgolden hour\b/i, "golden hour"],
  [/\bembrac(e|ing) (the|every|it)\b/i, "embrace the…"],
  [/\b(the|my|this) journey\b/i, "the journey"],
  [/(^|\s)#?blessed\b/i, "blessed"],
  [/\bself[- ]care (sunday|day|mode)\b/i, "self-care Sunday"],
  [/\bnew (week|month|day),? new\b/i, "new week, new…"],
  [/\bmaking memories\b/i, "making memories"],
  [/\bchasing (dreams|goals|sunsets)\b/i, "chasing dreams"],
  [/\belevat(e|ed|ing)\b/i, "elevate"],
  [/\bunlock(ed|ing)?\b/i, "unlock"],
  [/\blevel(ing|led)? up\b/i, "level up"],
  [/\bmain character\b/i, "main character"],
  [/\b(it'?s|its) the little things\b/i, "it's the little things"],
  [/\bhits? different\b/i, "hits different"],
  [/\bbig mood\b/i, "big mood"],
  [/\bsmall (moments|wins)\b/i, "small moments/wins"],
  [/\bmood:?$/i, "\"mood\""],
  [/\bcheers to\b/i, "cheers to…"],
  [/\bmanifest(ing)?\b/i, "manifesting"],
  [/\bsunday reset\b/i, "Sunday reset"],
];

/** Words that tie a post to this person's real world: places, people, the city. */
export function anchorWords(p: Persona): string[] {
  const words = new Set<string>();
  const add = (s: string) => {
    for (const w of s.match(/\b[A-Z][\p{L}'-]{3,}/gu) ?? []) words.add(w.toLowerCase());
  };
  add(p.identity.location);
  for (const l of p.visual.locations) add(l.description);
  for (const c of p.life.circle) words.add(c.name.toLowerCase());
  // Sentence starters and generic capitalised words are not anchors.
  for (const w of ["this", "that", "with", "inside", "near", "the", "near", "small", "busy", "bright", "clean", "outdoor", "modern"]) words.delete(w);
  return [...words];
}

/**
 * Why an idea reads generic, as feedback the director can act on. Empty = fine.
 * A post must stand on something specific: a storyline beat, a moment, a
 * callback, the operator's direction, or a real place, person or number.
 */
export function genericProblems(idea: { topic: string; hook: string; caption: string }, p: Persona, used: LifeUse | undefined, direction?: string): string[] {
  const out: string[] = [];
  const words = `${idea.hook}\n${idea.caption}`.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " ");
  for (const [re, label] of GENERIC) if (re.test(words)) out.push(`stock phrase: ${label}`);
  const anchored = Boolean(used?.beat || used?.moment || used?.callback_post_id || direction?.trim());
  if (!anchored && (p.life.moments.length || p.life.arcs.length)) {
    const text = `${idea.topic} ${idea.hook} ${idea.caption}`.toLowerCase();
    const real = /\d/.test(text) || anchorWords(p).some((w) => text.includes(w));
    if (!real) out.push("too generic: build it on one specific thing (a storyline beat, a small moment, a callback, a real place or person) and say what made it that day");
  }
  return out;
}
