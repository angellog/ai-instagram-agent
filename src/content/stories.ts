import { z } from "zod";
import { getControls, type Controls } from "../config/controls.js";
import { currentInfluencer, influencerId } from "../context.js";
import { checkFacts } from "../conversation/facts.js";
import { knowledge } from "../conversation/knowledge.js";
import { many, one, tx } from "../db/pool.js";
import { accountBlocker } from "../instagram/accounts.js";
import { recordDecision } from "../lib/decisions.js";
import { recordEvent } from "../lib/events.js";
import { localParts, slotForHour, TIMES_OF_DAY } from "../lib/time.js";
import { llm } from "../llm/llm.js";
import { persona } from "../persona/loader.js";
import { personaSystemBlock } from "../persona/prompt.js";
import type { Persona, Slot } from "../persona/schema.js";
import { SLOTS } from "../persona/schema.js";
import { JOBS, jobId, queue } from "../queue/queues.js";
import { trendsForPrompt } from "../trends/trends.js";
import { ensureDayPlan } from "./activities.js";
import { COMPOSITIONS, operatorGate, type Idea } from "./director.js";
import { recentContent } from "./history.js";
import type { VisualState } from "./history.js";
import { planOutfits } from "./wardrobe.js";

/**
 * Story updates: 1-3 light, in-the-moment frames a day from the influencer's
 * virtual life, separate from the feed. A story is a post with media_type
 * STORY (one 1080x1920 image, no caption), so it reuses production, QC,
 * safety, review, "Post now"/schedule and the duplicate-proof publisher.
 *
 * House rules enforced in code, whatever the model says:
 *  - never text on a photo of the influencer;
 *  - a shop story's address line comes verbatim from the business knowledge;
 *  - on-image text may not carry numbers the knowledge or headlines don't.
 */

export const STORY_KINDS = ["moment", "outfit", "shop", "trend", "question"] as const;
export type StoryKind = (typeof STORY_KINDS)[number];

const MAX_STORY_TEXT = 70;

export const storySchema = z.object({
  decision: z.enum(["post", "wait"]),
  reason: z.string().describe("One short operational sentence"),
  story: z
    .object({
      kind: z.enum(STORY_KINDS),
      activity_id: z.number().int().nullable().describe("The activity this moment comes from, or null"),
      shot: z.string().describe("What the vertical phone photo shows, concretely"),
      composition: z.enum(COMPOSITIONS),
      include_character: z.boolean().describe("true when she is in the photo"),
      location_id: z.string().nullable(),
      time_of_day: z.enum(TIMES_OF_DAY),
      sneakers: z.string().describe("The pair in the shot or on her feet, described generically; empty if none"),
      text: z.string().describe(`On-image line, plain words, max ${MAX_STORY_TEXT} characters, no emoji, no hashtags. MUST be empty when include_character is true.`),
      alt_text: z.string().describe("Plain description of the image, max 200 chars"),
    })
    .nullable(),
});
export type StoryPlan = NonNullable<z.infer<typeof storySchema>["story"]>;

export type StoryOutcome =
  | { status: "skipped"; reason: string }
  | { status: "waited"; reason: string }
  | { status: "accepted"; ideaId: number; postId: string };

const ACTIVE = "('draft','generating','composing','awaiting_review','approved','publishing')";

/** Gates checked before any spend. Operator requests skip cadence and window, never the off switches. */
export async function storyGate(c: Controls, p: Persona, now: Date, operator: boolean): Promise<string | undefined> {
  if (operator) {
    const blocked = operatorGate(c);
    if (blocked) return blocked;
    if (!c.stories_enabled) return "stories are turned off in Controls";
    return undefined;
  }
  if (c.paused) return "paused";
  if (!c.content_enabled || !c.image_generation_enabled) return "content or image generation disabled";
  if (!c.stories_enabled || c.stories_per_day <= 0) return "stories disabled";
  if (!["dry_run", "development"].includes(c.mode)) {
    const blocked = await accountBlocker();
    if (blocked) return blocked;
  }
  const { hour } = localParts(now, p.identity.timezone);
  if (hour < c.posting_window_start_hour || hour >= c.posting_window_end_hour) return `outside posting window (${hour}h local)`;
  const inFlight = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM posts WHERE influencer_id = $1 AND media_type = 'STORY' AND status IN ${ACTIVE} AND created_at > now() - interval '24 hours'`,
    [influencerId()],
  );
  if ((inFlight?.n ?? 0) > 0) return "a story is already in the pipeline";
  const today = await one<{ n: number; last: Date | null }>(
    `SELECT count(*) FILTER (WHERE published_at > now() - interval '24 hours')::int AS n, max(published_at) AS last
     FROM posts WHERE influencer_id = $1 AND media_type = 'STORY' AND status = 'published'`,
    [influencerId()],
  );
  if ((today?.n ?? 0) >= c.stories_per_day) return `stories_per_day (${c.stories_per_day}) reached`;
  if (today?.last && now.getTime() - new Date(today.last).getTime() < c.min_hours_between_stories * 3600_000) {
    return `last story was less than ${c.min_hours_between_stories}h ago`;
  }
  return undefined;
}

/** The shop line a "shop" story must carry, taken verbatim from the knowledge base (never written by the model). */
export function shopLine(): string | undefined {
  const entry = knowledge().find((k) => /store|shop|location/i.test(k.id) && k.must_include?.length);
  return entry ? entry.must_include!.join(", ") : undefined;
}

export async function planStory(now = new Date(), opts: { operator?: boolean } = {}): Promise<StoryOutcome> {
  const c = await getControls();
  const p = persona();
  const gate = await storyGate(c, p, now, Boolean(opts.operator));
  if (gate) return { status: "skipped", reason: gate };

  const { day, hour, weekday } = localParts(now, p.identity.timezone);
  const slot = slotForHour(hour);
  const activities = (await ensureDayPlan(p, now)).filter((a) => SLOTS.indexOf(a.slot as Slot) <= SLOTS.indexOf(slot));
  const worn = await recentContent(15, { stories: true });
  const outfits = planOutfits(p, day, worn);
  const stories = await many<{ kind: string; text: string; shot: string; created_at: Date }>(
    `SELECT ci.structure AS kind, coalesce(ci.plan->'slides'->0->>'overlay_heading', '') AS text, coalesce(ci.plan->'slides'->0->>'shot', '') AS shot, ci.created_at
     FROM content_ideas ci JOIN posts po ON po.content_idea_id = ci.id
     WHERE ci.influencer_id = $1 AND ci.format = 'story' AND po.status NOT IN ('rejected','failed','qc_failed')
     ORDER BY ci.id DESC LIMIT 8`,
    [influencerId()],
  );
  const todaysPosts = worn.filter((r) => r.format !== "story" && localParts(new Date(r.createdAt), p.identity.timezone).day === day);
  const trends = await trendsForPrompt("content");
  const shop = shopLine();
  const weekend = weekday === 0 || weekday === 6;

  const started = Date.now();
  const out = await llm().structured(storySchema, {
    operation: "story.plan",
    tier: "smart",
    maxTokens: 900,
    temperature: 0.9,
    system: storySystem(p, shop),
    prompt: [
      `NOW: ${day}, ${slot.replace("_", " ")} in ${p.identity.location}${weekend ? " (weekend)" : ""}.`,
      `TODAY SO FAR (id | slot | activity | location):\n${activities.map((a) => `- ${a.id} | ${a.slot} | ${a.activity} | ${a.location ?? "-"}`).join("\n") || "- nothing planned yet"}`,
      `LOCATIONS:\n${p.visual.locations.map((l) => `${l.id}: ${l.description}`).join("\n")}`,
      `TODAY'S OUTFIT (she is wearing this all day; use it exactly): "${outfits.everyday}". Workout: "${outfits.sport}".`,
      todaysPosts.length ? `ALREADY ON THE FEED TODAY: ${todaysPosts.map((r) => `"${r.topic}"`).join("; ")}. A story can be a behind-the-scenes angle, never the same shot.` : "",
      `RECENT STORIES (newest first; don't repeat):\n${stories.map((s) => `- ${s.kind}: ${s.shot.slice(0, 90)}${s.text ? ` / text "${s.text}"` : ""}`).join("\n") || "- none yet"}`,
      trends ? `TRENDS AND NEWS (reference only if it fits; never add details beyond the headline):\n${trends}` : "",
      opts.operator ? "OPERATOR REQUEST: the operator wants a story right now. Do not wait: pick the best moment." : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  if (out.decision === "wait" || !out.story) {
    await recordDecision({ agent: "story_director", subjectType: "system", subjectId: `story-${day}-${slot}`, action: "wait", reason: out.reason, latencyMs: Date.now() - started });
    return { status: "waited", reason: out.reason };
  }

  const s = normalizeStory(out.story, p, shop, trends);
  const activity = s.activity_id ? activities.find((a) => a.id === s.activity_id) : undefined;
  if (s.activity_id && !activity) s.activity_id = null;
  const wearing = /gym|run|workout|training|football|match|sport/i.test(`${activity?.activity ?? ""} ${s.shot}`) ? outfits.sport : outfits.everyday;
  const state: VisualState = {
    location_id: s.location_id,
    time_of_day: s.time_of_day,
    outfit: wearing,
    sneakers: s.sneakers || undefined,
    hairstyle: p.visual.character.hairstyle,
    compositions: [s.composition],
    local_day: day,
    activity: activity?.activity ?? null,
  };
  const slide: Idea["slides"][number] = {
    role: "cover",
    shot: s.shot,
    composition: s.composition,
    include_character: s.include_character,
    overlay_kind: s.text || s.footer ? "body" : "none",
    overlay_heading: s.text,
    overlay_body: s.footer,
    alt_text: s.alt_text.slice(0, 200),
  };
  const topic = `${s.kind}: ${s.shot}`.slice(0, 120);

  const { ideaId, postId } = await tx(async (client) => {
    const idea = await client.query<{ id: number }>(
      `INSERT INTO content_ideas (activity_id, format, structure, topic, hook, angle, plan, caption, visual_state, status, influencer_id)
       VALUES ($1, 'story', $2, $3, $4, $5, $6, '', $7, 'accepted', $8) RETURNING id`,
      [s.activity_id, s.kind, topic, s.text || s.kind, out.reason, JSON.stringify({ source: "story", kind: s.kind, slides: [slide] }), JSON.stringify(state), influencerId()],
    );
    const post = await client.query<{ id: string }>(
      `INSERT INTO posts (influencer_id, content_idea_id, media_type, caption, status, visual_state, origin)
       VALUES ($1, $2, 'STORY', '', 'draft', $3, $4) RETURNING id`,
      [influencerId(), idea.rows[0].id, JSON.stringify(state), opts.operator ? "operator" : "scheduled"],
    );
    return { ideaId: idea.rows[0].id, postId: post.rows[0].id };
  });
  await recordDecision({
    agent: "story_director",
    subjectType: "content_idea",
    subjectId: ideaId,
    intent: s.kind,
    action: "accept",
    reason: out.reason,
    output: { adjustments: s.adjustments },
    latencyMs: Date.now() - started,
  });
  if (!opts.operator) await queue("content").add(JOBS.contentProduce, { influencerId: influencerId(), postId }, { jobId: jobId("produce", postId) });
  await recordEvent("info", "content", "Story accepted; production queued", { ideaId, postId, kind: s.kind });
  return { status: "accepted", ideaId, postId };
}

/** Apply the house rules to the model's story. Every change is recorded. */
export function normalizeStory(s: StoryPlan, p: Persona, shop: string | undefined, trends = ""): StoryPlan & { footer: string; adjustments: string[] } {
  const out = { ...s, text: s.text.replace(/\s+/g, " ").trim(), footer: "", adjustments: [] as string[] };
  if (out.location_id && !p.visual.locations.some((l) => l.id === out.location_id)) out.location_id = null;
  if (out.kind === "shop") {
    if (!shop) {
      out.kind = "moment";
      out.adjustments.push("no shop in the business knowledge: made it a moment");
    } else {
      out.include_character = false;
      out.footer = shop;
    }
  }
  if (out.include_character && out.text) {
    out.text = "";
    out.adjustments.push("removed text: never text on a photo of her");
  }
  if (out.text.length > MAX_STORY_TEXT) {
    out.text = `${out.text.slice(0, MAX_STORY_TEXT - 1).replace(/\s+\S*$/, "")}...`;
    out.adjustments.push("shortened the text");
  }
  // Numbers on the image must come from the knowledge or the headlines.
  if (out.text) {
    const facts = checkFacts(out.text, { used: [], shown: knowledge(), inbound: trends });
    if (facts.unverified.length) {
      out.adjustments.push(`removed text with unverified numbers (${facts.unverified.join(", ")})`);
      out.text = "";
    }
  }
  return out;
}

function storySystem(p: Persona, shop: string | undefined): string {
  return `${personaSystemBlock(p)}

---
You plan ONE Instagram Story for this creator right now: a light, in-the-moment vertical phone photo, the kind real people post between feed posts.
Kinds:
- moment: a slice of what she's doing now (coffee on the table, the view on her run, laces being cleaned). Often no face: hands, feet, POV, the place.
- outfit: a quick mirror or full-length fit check of today's outfit.
${shop ? `- shop: a product or shop-floor shot at the store, no person in frame. Write a short line about the pair or the drop; the shop address is added underneath automatically (don't write it).` : ""}
- trend: a small reaction to one of the headlines, as a photo of her world plus a short line.
- question: a photo plus a short question followers can answer by replying to the story (e.g. "Which pair for Saturday?").
Rules:
- "wait" is fine if nothing is worth a story now or it would repeat a recent one.
- Text goes ONLY on photos without her in them, and at most ${MAX_STORY_TEXT} characters of plain words: no emoji, no hashtags, no @mentions, no links. When include_character is true, text is "".
- Never state prices, stock, dates or numbers unless they are in the headlines; never invent facts.
- Vary kinds; keep it casual. Return JSON only.`;
}

/** The influencer's recent stories, newest first (console). */
export async function recentStories(limit = 30) {
  return many<{ id: string; status: string; created_at: Date; published_at: Date | null; scheduled_for: Date | null; cover: string | null; kind: string | null; text: string | null }>(
    `SELECT p.id, p.status, p.created_at, p.published_at, p.scheduled_for,
       (SELECT public_url FROM post_assets pa WHERE pa.post_id = p.id ORDER BY position LIMIT 1) AS cover,
       ci.structure AS kind, ci.plan->'slides'->0->>'overlay_heading' AS text
     FROM posts p LEFT JOIN content_ideas ci ON ci.id = p.content_idea_id
     WHERE p.influencer_id = $1 AND p.media_type = 'STORY' ORDER BY p.created_at DESC LIMIT $2`,
    [currentInfluencer().id, limit],
  );
}
