import { z } from "zod";
import { getControls, type Controls } from "../config/controls.js";
import { many, one, tx } from "../db/pool.js";
import { recordDecision } from "../lib/decisions.js";
import { recordEvent } from "../lib/events.js";
import { localParts, slotForHour, TIMES_OF_DAY } from "../lib/time.js";
import { llm } from "../llm/llm.js";
import { worldMemories } from "../memory/store.js";
import { persona } from "../persona/loader.js";
import { personaSystemBlock } from "../persona/prompt.js";
import type { Persona, Slot } from "../persona/schema.js";
import { SLOTS } from "../persona/schema.js";
import { learningsForPrompt } from "../analytics/learnings.js";
import { hasAccount } from "../instagram/accounts.js";
import { JOBS, jobId, queue } from "../queue/queues.js";
import { ensureDayPlan, type ActivityRow } from "./activities.js";
import { enforceContinuity } from "./continuity.js";
import { recentContent, type RecentItem } from "./history.js";
import { repetitionScore } from "./repetition.js";
import { fitCaption } from "./caption.js";

export const COMPOSITIONS = ["close_up", "medium", "full_body", "detail", "flat_lay", "environment", "over_shoulder", "mirror"] as const;

export function ideaSchema(p: Persona) {
  const structures = [...new Set([...p.carousel.structures, "moment"])] as [string, ...string[]];
  const slide = z.object({
    role: z.enum(["cover", "slide", "cta"]),
    shot: z.string().describe("What the photo shows, concretely: action, framing, props, environment detail"),
    composition: z.enum(COMPOSITIONS),
    include_character: z.boolean().describe("false for product/detail/environment shots"),
    overlay_kind: z.enum(["none", "cover", "body", "cta"]),
    overlay_heading: z.string().describe("Short on-image heading; empty for none"),
    overlay_body: z.string().describe("On-image body text (educational/listicle slides); empty otherwise"),
    alt_text: z.string().describe("Plain description of the image for accessibility, max 200 chars"),
  });
  return z.object({
    decision: z.enum(["post", "wait"]),
    reason: z.string().describe("One short operational sentence"),
    idea: z
      .object({
        source: z.enum(["activity", "content_request", "evergreen"]),
        activity_id: z.number().int().nullable(),
        format: z.enum(["single", "carousel"]),
        structure: z.enum(structures),
        topic: z.string(),
        hook: z.string().describe("The first line a scroller reads; also the cover heading for carousels"),
        angle: z.string(),
        location_id: z.string().nullable(),
        time_of_day: z.enum(TIMES_OF_DAY),
        outfit: z.string(),
        sneakers: z.string().describe("The pair on foot, described generically (silhouette, colours). No invented releases."),
        slides: z.array(slide).min(1).max(p.carousel.max_slides),
        caption: z.string(),
        hashtags: z.array(z.string()).max(p.hashtags.max),
      })
      .nullable(),
  });
}
export type Idea = NonNullable<z.infer<ReturnType<typeof ideaSchema>>["idea"]>;

export type PlanOutcome =
  | { status: "skipped"; reason: string }
  | { status: "waited"; reason: string }
  | { status: "rejected_all"; attempts: number; reason: string }
  | { status: "accepted"; ideaId: number; postId: string; attempts: number };

/**
 * `content.plan` job (brief §6, §7, §19): the activity planner proposes, the
 * Content Director decides whether anything is worth posting right now, the
 * repetition check can veto, continuity is enforced, and an accepted idea
 * becomes a draft post handed to production.
 */
export async function planContent(now = new Date()): Promise<PlanOutcome> {
  const c = await getControls();
  const p = persona();
  const gateReason = await postingGate(c, p, now);
  if (gateReason) return { status: "skipped", reason: gateReason };

  const { day, hour } = localParts(now, p.identity.timezone);
  const slot = slotForHour(hour);
  const plan = await ensureDayPlan(p, now);
  const candidates = plan.filter((a) => a.decision === "planned" && SLOTS.indexOf(a.slot as Slot) <= SLOTS.indexOf(slot));
  const recent = await recentContent(15);
  const requests = await worldMemories(["content_request"], 5);
  const learnings = await learningsForPrompt();
  const schema = ideaSchema(p);

  const feedback: string[] = [];
  for (let attempt = 1; attempt <= c.max_concept_attempts; attempt++) {
    const started = Date.now();
    const out = await llm().structured(schema, {
      operation: "content.plan",
      tier: "smart",
      maxTokens: 2500,
      temperature: 0.9,
      system: directorSystem(p, c),
      prompt: directorPrompt({ p, day, slot, candidates, recent, requests: requests.map((r) => r.content), learnings, feedback }),
    });

    if (out.decision === "wait" || !out.idea) {
      await recordDecision({ agent: "content_director", subjectType: "system", subjectId: `plan-${day}-${slot}`, action: "wait", reason: out.reason, latencyMs: Date.now() - started });
      for (const a of candidates) {
        await one("UPDATE activities SET decision = 'skip', reason = $2 WHERE id = $1 AND decision = 'planned'", [a.id, `director: ${out.reason}`.slice(0, 300)]);
      }
      return { status: "waited", reason: out.reason };
    }

    const idea = normalizeIdea(out.idea, p, c);
    const activity = idea.activity_id ? candidates.find((a) => a.id === idea.activity_id) : undefined;
    if (idea.activity_id && !activity) idea.activity_id = null;

    const { state, adjustments } = enforceContinuity(
      {
        location_id: idea.location_id,
        time_of_day: idea.time_of_day,
        outfit: idea.outfit,
        sneakers: idea.sneakers,
        compositions: idea.slides.map((s) => s.composition),
        activity: activity?.activity ?? null,
      },
      { localDay: day, slot, activity: activity?.activity, hairstyle: p.visual.character.hairstyle },
      recent,
    );

    const rep = repetitionScore(
      { topic: idea.topic, hook: idea.hook, caption: idea.caption, structure: idea.structure, format: idea.format, visual: state },
      recent,
    );

    const ideaRow = await one<{ id: number }>(
      `INSERT INTO content_ideas (activity_id, format, structure, topic, hook, angle, plan, caption, visual_state, repetition_score, repetition_detail, status, reject_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        idea.activity_id,
        idea.format,
        idea.structure,
        idea.topic,
        idea.hook,
        idea.angle,
        JSON.stringify({ source: idea.source, slides: idea.slides, hashtags: idea.hashtags }),
        idea.caption,
        JSON.stringify(state),
        rep.score,
        JSON.stringify(rep),
        rep.score >= c.repetition_threshold ? "rejected" : "accepted",
        rep.score >= c.repetition_threshold ? `too similar (${rep.score}): ${rep.reasons.join("; ")}` : null,
      ],
    );

    await recordDecision({
      agent: "content_director",
      subjectType: "content_idea",
      subjectId: ideaRow!.id,
      intent: idea.structure,
      action: rep.score >= c.repetition_threshold ? "reject_repetitive" : "accept",
      confidence: 1 - rep.score,
      contextUsed: ["recent_content", "activity_plan", ...(learnings ? ["learnings"] : []), ...(requests.length ? ["content_requests"] : [])],
      reason: rep.score >= c.repetition_threshold ? rep.reasons.join("; ") : out.reason,
      output: { repetition: rep, continuity_adjustments: adjustments },
      latencyMs: Date.now() - started,
    });

    if (rep.score >= c.repetition_threshold) {
      feedback.push(`Attempt ${attempt} was REJECTED as repetitive (score ${rep.score}): ${rep.reasons.join("; ")}. Propose a clearly different concept.`);
      continue;
    }

    const postId = await tx(async (client) => {
      const post = await client.query<{ id: string }>(
        `INSERT INTO posts (content_idea_id, media_type, caption, status, visual_state)
         VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
        [ideaRow!.id, idea.format === "carousel" ? "CAROUSEL" : "IMAGE", fitCaption(idea.caption, idea.hashtags, p), JSON.stringify(state)],
      );
      if (activity) {
        await client.query("UPDATE activities SET decision = 'post', reason = $2 WHERE id = $1", [activity.id, `idea ${ideaRow!.id}`]);
      }
      return post.rows[0].id;
    });
    await queue("content").add(JOBS.contentProduce, { postId }, { jobId: jobId("produce", postId) });
    await recordEvent("info", "content", "Content idea accepted; production queued", { ideaId: ideaRow!.id, postId, topic: idea.topic, attempt });
    return { status: "accepted", ideaId: ideaRow!.id, postId, attempts: attempt };
  }
  await recordEvent("warn", "content", "All content concepts rejected as repetitive", { attempts: c.max_concept_attempts });
  return { status: "rejected_all", attempts: c.max_concept_attempts, reason: feedback.at(-1) ?? "" };
}

/** Hard gates checked before any LLM spend. Returns a reason to skip, or undefined. */
export async function postingGate(c: Controls, p: Persona, now: Date): Promise<string | undefined> {
  if (c.paused) return "paused";
  if (!c.content_enabled) return "content generation disabled";
  // Producing a post costs money; don't until there is an account to publish it to.
  if (!(await hasAccount())) return "no Instagram account connected";
  const { hour } = localParts(now, p.identity.timezone);
  if (hour < c.posting_window_start_hour || hour >= c.posting_window_end_hour) return `outside posting window (${hour}h local)`;
  const inFlight = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM posts WHERE status IN ('draft','generating','composing','awaiting_review','approved','publishing')`,
  );
  if ((inFlight?.n ?? 0) > 0) return "a post is already in the pipeline";
  const today = await one<{ n: number; last: Date | null }>(
    `SELECT count(*) FILTER (WHERE published_at > now() - interval '24 hours')::int AS n, max(published_at) AS last FROM posts WHERE status = 'published'`,
  );
  if ((today?.n ?? 0) >= c.max_posts_per_day) return `max_posts_per_day (${c.max_posts_per_day}) reached`;
  if (today?.last && now.getTime() - new Date(today.last).getTime() < c.min_hours_between_posts * 3600_000) {
    return `last post was less than ${c.min_hours_between_posts}h ago`;
  }
  return undefined;
}

function normalizeIdea(idea: Idea, p: Persona, c: Controls): Idea {
  const out = { ...idea, slides: [...idea.slides] };
  if (out.format === "carousel" && !c.carousel_generation_enabled) out.format = "single";
  if (out.format === "single") {
    out.slides = out.slides.slice(0, 1).map((s) => ({ ...s, role: "cover" as const }));
    if (out.structure !== "moment" && !p.carousel.structures.includes(out.structure)) out.structure = "moment";
  } else {
    if (out.slides.length < p.carousel.min_slides) {
      // Too short to be the carousel it claims to be: publish the strongest frame as a single image.
      out.format = "single";
      out.slides = out.slides.slice(0, 1).map((s) => ({ ...s, role: "cover" as const }));
    }
    out.slides = out.slides.slice(0, Math.min(p.carousel.max_slides, 10));
  }
  if (out.location_id && !p.visual.locations.some((l) => l.id === out.location_id)) out.location_id = null;
  return out;
}

function directorSystem(p: Persona, c: Controls): string {
  return `${personaSystemBlock(p)}

---
You are the Content Director for this Instagram account. You decide IF something is worth posting now, and if so, design it.
Principles:
- Do not post merely because a timer fired. "wait" is a good answer when nothing is interesting or it would repeat recent posts.
- Natural feed: mix formats and structures; vary locations, outfits and shot types; no identical compositions back to back.
- Carousels have ${p.carousel.min_slides}-${p.carousel.max_slides} slides: slide 1 is the cover (overlay_kind "cover", heading = the hook); educational/listicle slides use overlay_kind "body" with a short heading + 1-3 sentence body; lifestyle diary/storytelling slides often need no text (overlay_kind "none"). An optional last slide can be overlay_kind "cta" (e.g. "Save this for your next pair").
- Single images: one strong frame, overlay_kind "none" unless the concept needs words.
- Never claim experiences as real-world facts; the day is a storyline for an AI creator. Keep sneaker facts accurate or phrase them as opinion.
- Captions: conversational, ${c.max_posts_per_day > 1 ? "varied openings" : "a fresh opening"}, end with a light question or thought now and then (not always). No hashtags inside the caption text; put them in "hashtags" (max ${p.hashtags.max}, from: ${p.hashtags.pool.join(" ")}).
- Overlay text must be plain Latin text (no emoji).
Return JSON only.`;
}

function directorPrompt(o: {
  p: Persona;
  day: string;
  slot: Slot;
  candidates: ActivityRow[];
  recent: RecentItem[];
  requests: string[];
  learnings: string;
  feedback: string[];
}): string {
  const locs = o.p.visual.locations.map((l) => `${l.id}: ${l.description}`).join("\n");
  return [
    `NOW: ${o.day}, ${o.slot.replace("_", " ")} in ${o.p.identity.location}.`,
    `TODAY'S ACTIVITIES AVAILABLE TO POST (id, slot, activity, location):\n${
      o.candidates.map((a) => `- ${a.id} | ${a.slot} | ${a.activity} | ${a.location ?? "-"}`).join("\n") || "- none left today (evergreen or content requests only)"
    }`,
    `LOCATIONS:\n${locs}`,
    `RECENT POSTS (newest first):\n${
      o.recent
        .slice(0, 10)
        .map(
          (r) =>
            `- [${r.status}] ${r.format}/${r.structure} "${r.topic}" hook="${r.hook}" loc=${r.visual.location_id ?? "-"} outfit="${r.visual.outfit ?? "-"}" shots=${(r.visual.compositions ?? []).join(",")}`,
        )
        .join("\n") || "- none yet (this would be the first post: make it a strong introduction of who you are)"
    }`,
    o.requests.length ? `FOLLOWER REQUESTS WORTH CONSIDERING:\n${o.requests.map((r) => `- ${r}`).join("\n")}` : "",
    o.learnings ? `WHAT HAS PERFORMED (engagement learnings; explore sometimes, do not overfit):\n${o.learnings}` : "",
    `RECURRING OUTFITS: ${o.p.visual.character.recurring_clothing_preferences.join(" | ")}`,
    o.feedback.length ? `FEEDBACK ON PREVIOUS ATTEMPTS:\n${o.feedback.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Activities still planned for today (dashboard + CLI). */
export async function todayPlan(now = new Date()): Promise<ActivityRow[]> {
  const p = persona();
  return many<ActivityRow>("SELECT * FROM activities WHERE day = $1 ORDER BY id", [localParts(now, p.identity.timezone).day]);
}
