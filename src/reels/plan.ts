import { z } from "zod";
import { getControls, type Controls } from "../config/controls.js";
import { influencerId } from "../context.js";
import { knowledge } from "../conversation/knowledge.js";
import { brandPullBlock } from "../content/brandpull.js";
import { COMPOSITIONS, directionBlock, operatorGate } from "../content/director.js";
import { many, one, tx } from "../db/pool.js";
import { recordDecision } from "../lib/decisions.js";
import { recordEvent } from "../lib/events.js";
import { localParts, slotForHour, TIMES_OF_DAY } from "../lib/time.js";
import { accountBlocker } from "../instagram/accounts.js";
import { reelMaterial, type LibraryItem } from "../library/library.js";
import { llm } from "../llm/llm.js";
import { persona } from "../persona/loader.js";
import { personaSystemBlock } from "../persona/prompt.js";
import { pronouns } from "../persona/pronouns.js";
import type { Persona } from "../persona/schema.js";
import { JOBS, jobId, queue } from "../queue/queues.js";
import { trendsForPrompt } from "../trends/trends.js";
import { stepSchema, stepSeconds } from "./explainer.js";
import { OS_STYLES } from "./screens.js";

/**
 * Reel planning. Two kinds:
 *  - moment: 1-3 short AI clips of the creator's life (5-20 s), a hook line on the first.
 *  - explainer: the creator introduces a tip in a short clip, then the steps play on a
 *    recreated phone screen (where to tap, what to switch). Only for creators whose
 *    niche is tips/how-to; the steps get a second, sceptical research pass, and an
 *    explainer always waits for human review.
 */

const clipSchema = z.object({
  shot: z.string().describe("What the vertical video shows, concretely (the opening frame)"),
  motion: z.string().describe("What moves in the clip: action and camera, e.g. 'she turns to camera and holds up the phone, slight handheld drift'"),
  composition: z.enum(COMPOSITIONS),
  include_character: z.boolean(),
  location_id: z.string().nullable(),
  time_of_day: z.enum(TIMES_OF_DAY),
  seconds: z.number().int().min(3).max(8),
});
export type ReelClip = z.infer<typeof clipSchema>;

export const reelSchema = z.object({
  decision: z.enum(["post", "wait"]),
  reason: z.string(),
  reel: z
    .object({
      kind: z.enum(["moment", "explainer"]),
      topic: z.string(),
      hook: z.string().describe("On-screen opening line, max 40 characters, plain words"),
      caption: z.string().describe("1-2 short lines in the creator's voice; for explainers say what the tip does"),
      hashtags: z.array(z.string()).max(5),
      os: z.enum(OS_STYLES).nullable().describe("Phone system the explainer shows; null for moments"),
      intro: clipSchema.describe("The creator's opening clip (introduces the tip for explainers)"),
      clips: z.array(clipSchema).max(2).describe("Moments only: up to 2 more clips after the intro; [] for explainers"),
      steps: z.array(stepSchema).max(6).describe("Explainers only: 2-6 steps, each a screen and the row to tap; [] for moments"),
      material_id: z.string().nullable().describe("Id of an uploaded REEL MATERIAL clip to cut in (e.g. a real screen recording of the same steps), or null"),
      featured_item: z.string().describe("One item from the brand's category naturally in shot, or empty"),
    })
    .nullable(),
});
export type ReelPlan = NonNullable<z.infer<typeof reelSchema>["reel"]>;

const verifySchema = z.object({
  accurate: z.boolean().describe("true only if every step matches how the named phone system really works today"),
  os_version: z.string().describe("The OS version the steps are checked against, e.g. 'iOS 18'"),
  problems: z.array(z.string()).describe("Each wrong or uncertain step, briefly; [] when accurate"),
  steps: z.array(stepSchema).describe("The corrected steps (same as given when accurate)"),
});

/** Whether this creator makes step-by-step explainers (tips, how-to, tech). */
export function makesExplainers(p: Persona): boolean {
  // What they're known for, not a hobby: "technology" among Zuri's interests doesn't make her a tips creator.
  return /\btips?\b|explain|how[- ]?to|tutorial|iphone|android|smartphone|phone shop|gadget/i.test([p.identity.occupation, ...p.content_style, p.brand?.category ?? ""].join(" "));
}

type Outcome = { status: "skipped" | "waited"; reason: string } | { status: "accepted"; postId: string; ideaId: number };

/** Gates checked before any spend. */
export async function reelGate(c: Controls, p: Persona, now: Date, operator: boolean): Promise<string | undefined> {
  if (operator) return operatorGate(c) ?? (c.reels_enabled ? undefined : "reels are turned off in Controls");
  if (c.paused) return "paused";
  if (!c.reels_enabled || c.reels_per_week <= 0) return "reels disabled";
  if (!c.content_enabled || !c.image_generation_enabled) return "content or image generation disabled";
  if (!["dry_run", "development"].includes(c.mode)) {
    const blocked = await accountBlocker();
    if (blocked) return blocked;
  }
  const { hour } = localParts(now, p.identity.timezone);
  if (hour < c.posting_window_start_hour || hour >= c.posting_window_end_hour) return `outside posting window (${hour}h local)`;
  const inFlight = await one<{ n: number }>(
    "SELECT count(*)::int AS n FROM posts WHERE influencer_id = $1 AND media_type = 'REEL' AND origin <> 'library' AND status IN ('draft','generating','composing') AND created_at > now() - interval '6 hours'",
    [influencerId()],
  );
  if ((inFlight?.n ?? 0) > 0) return "a reel is already being made";
  const week = await one<{ n: number; last: Date | null }>(
    "SELECT count(*)::int AS n, max(created_at) AS last FROM posts WHERE influencer_id = $1 AND media_type = 'REEL' AND origin <> 'library' AND status NOT IN ('rejected','failed','qc_failed') AND created_at > now() - interval '7 days'",
    [influencerId()],
  );
  if ((week?.n ?? 0) >= c.reels_per_week) return `reels_per_week (${c.reels_per_week}) reached`;
  if (week?.last && now.getTime() - new Date(week.last).getTime() < c.min_days_between_reels * 86_400_000) return `last reel was less than ${c.min_days_between_reels} days ago`;
  return undefined;
}

function reelSystem(p: Persona, explainers: boolean, c: Controls): string {
  const pr = pronouns(p);
  return `${personaSystemBlock(p)}

---
You plan ONE Instagram Reel for this creator: a short vertical video (${5}-${c.max_reel_seconds} seconds in total) that feels like real creator content, not an ad.
Kinds:
- moment: 1-3 short clips of ${pr.poss} life right now (the intro plus up to 2 more), each 3-8 s, with a hook line on the first. Calm, real, phone-shot.${
    explainers
      ? `
- explainer: ${pr.subj} introduce${pr.is === "is" ? "s" : ""} a useful phone tip in the intro clip (3-6 s, talking to camera or holding the phone), then 2-6 steps play on a recreated phone screen. Each step is ONE screen exactly as it looks on the phone (title, back button, the visible rows in order, switches with their current state) and the ONE row to tap. The last step may show the result with tap null.
  - Only tips you are certain about on current iOS/Android. Use exact menu names. Prefer genuinely useful, specific tips (battery, storage, camera, privacy, shortcuts, hidden settings, Focus, keyboard, Wi-Fi sharing).
  - Rows: use realistic settings icon colours; include the neighbouring rows people really see so the screen is recognisable; at most 9 rows per screen.`
      : ""
  }
Rules:
- "wait" is fine if nothing is worth a reel now or it would repeat a recent one.
- The hook is plain words, max 40 characters, no emoji, no hashtags. The caption is 1-2 short lines in ${pr.poss} voice; never describe the video.
- Never state prices, stock, dates or numbers that aren't in the knowledge you were given.
- Clips must be physically simple to animate: one action, gentle camera. No crowds dancing, no fast sports, no text on screens.
Return JSON only.`;
}

/** Plan a reel and queue its production. Explainers are fact-checked before anything is spent. */
export async function planReel(now = new Date(), opts: { operator?: boolean; direction?: string } = {}): Promise<Outcome> {
  const c = await getControls();
  const p = persona();
  const gate = await reelGate(c, p, now, Boolean(opts.operator));
  if (gate) return { status: "skipped", reason: gate };
  const { day, hour } = localParts(now, p.identity.timezone);
  const slot = slotForHour(hour);
  const explainers = makesExplainers(p);
  const recent = await many<{ topic: string; kind: string }>(
    "SELECT ci.topic, ci.structure AS kind FROM content_ideas ci JOIN posts po ON po.content_idea_id = ci.id WHERE ci.influencer_id = $1 AND ci.format = 'reel' ORDER BY ci.id DESC LIMIT 10",
    [influencerId()],
  );
  const material = await reelMaterial(8);
  const trends = await trendsForPrompt("content");
  const recentCaptions = (await many<{ caption: string }>("SELECT caption FROM posts WHERE influencer_id = $1 AND media_type <> 'STORY' ORDER BY created_at DESC LIMIT 10", [influencerId()])).map((r) => r.caption);
  const started = Date.now();
  const out = await llm().structured(reelSchema, {
    operation: "reel.plan",
    tier: "smart",
    maxTokens: 4000,
    system: reelSystem(p, explainers, c),
    prompt: [
      `NOW: ${day}, ${slot.replace("_", " ")} in ${p.identity.location}.`,
      `LOCATIONS:\n${p.visual.locations.map((l) => `${l.id}: ${l.description}`).join("\n")}`,
      `RECENT REELS (don't repeat):\n${recent.map((r) => `- ${r.kind}: ${r.topic}`).join("\n") || "- none yet (make a strong first one)"}`,
      material.length ? `REEL MATERIAL (real clips the business uploaded; cut one in when it shows the same thing):\n${materialList(material)}` : "",
      trends ? `TRENDS AND NEWS (only if it fits):\n${trends}` : "",
      brandPullBlock(p, recentCaptions, knowledge(), "post"),
      explainers ? "This creator makes tips/explainers: prefer an explainer, with a moment now and then." : "This creator makes moment reels only.",
      opts.operator ? "OPERATOR REQUEST: make a reel right now. Do not wait." : "",
      directionBlock(opts.direction, "post").replace(/post/g, "reel"),
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  if (out.decision === "wait" || !out.reel) {
    await recordDecision({ agent: "reel_director", subjectType: "system", subjectId: `reel-${day}-${slot}`, action: "wait", reason: out.reason, latencyMs: Date.now() - started });
    return { status: "waited", reason: out.reason };
  }
  const reel = normalizeReel(out.reel, p, explainers, material, c);
  if (reel.kind === "explainer") {
    const v = await verifySteps(p, reel);
    if (!v.accurate && v.problems.length > 2) {
      await recordEvent("warn", "content", "Explainer reel dropped: steps could not be verified", { topic: reel.topic, problems: v.problems });
      return { status: "waited", reason: `steps not verified: ${v.problems.slice(0, 2).join("; ")}` };
    }
    reel.steps = v.steps.slice(0, 6);
    (reel as ReelPlan & { verified?: string }).verified = `${v.os_version}${v.problems.length ? `; corrected: ${v.problems.join("; ")}` : ""}`;
  }
  const { postId, ideaId } = await tx(async (client) => {
    const idea = await client.query<{ id: number }>(
      `INSERT INTO content_ideas (format, structure, topic, hook, angle, plan, caption, visual_state, status, influencer_id)
       VALUES ('reel', $1, $2, $3, $4, $5, $6, $7, 'accepted', $8) RETURNING id`,
      [reel.kind, reel.topic, reel.hook, reel.kind === "explainer" ? "how-to" : "moment", JSON.stringify(reel), reel.caption, JSON.stringify({ local_day: day, featured_item: reel.featured_item || undefined }), influencerId()],
    );
    const post = await client.query<{ id: string }>(
      `INSERT INTO posts (influencer_id, content_idea_id, media_type, caption, status, visual_state, origin)
       VALUES ($1, $2, 'REEL', $3, 'draft', $4, $5) RETURNING id`,
      [influencerId(), idea.rows[0].id, reelCaption(reel, p), JSON.stringify({ local_day: day, hairstyle: p.visual.character.hairstyle, featured_item: reel.featured_item || undefined }), opts.operator ? "operator" : "scheduled"],
    );
    return { postId: post.rows[0].id, ideaId: idea.rows[0].id };
  });
  await recordDecision({ agent: "reel_director", subjectType: "post", subjectId: postId, action: `plan_${reel.kind}`, reason: out.reason, latencyMs: Date.now() - started });
  if (!opts.operator) await queue("content").add(JOBS.contentProduce, { influencerId: influencerId(), postId }, { jobId: jobId("produce", postId) });
  return { status: "accepted", postId, ideaId };
}

function materialList(items: LibraryItem[]): string {
  return items.map((m) => `- id ${m.id} | ${m.files[0].duration_s ?? "?"}s | ${m.title}${m.notes ? ` | ${m.notes.replace(/\s+/g, " ").slice(0, 160)}` : ""}`).join("\n");
}

function reelCaption(r: ReelPlan, p: Persona): string {
  const tags = r.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).slice(0, p.hashtags.max);
  return [r.caption.trim(), tags.join(" ")].filter(Boolean).join("\n\n");
}

/** House rules: valid places, explainers only for tips creators, total length within the cap. */
export function normalizeReel(r: ReelPlan, p: Persona, explainers: boolean, material: LibraryItem[], c: Pick<Controls, "max_reel_seconds">): ReelPlan {
  const out: ReelPlan = { ...r, clips: [...r.clips], steps: [...r.steps] };
  const fixLoc = (k: ReelClip) => ({ ...k, location_id: k.location_id && p.visual.locations.some((l) => l.id === k.location_id) ? k.location_id : null });
  out.intro = fixLoc(out.intro);
  out.clips = out.clips.map(fixLoc);
  if (out.kind === "explainer" && (!explainers || out.steps.length < 1)) out.kind = "moment";
  if (out.kind === "explainer") out.clips = [];
  else out.steps = [];
  if (!material.some((m) => m.id === out.material_id)) out.material_id = null;
  out.hook = out.hook.replace(/\s+/g, " ").trim().slice(0, 40);
  // Fit the cap: drop trailing steps/clips until it's short enough.
  const matS = out.material_id ? Math.min(8, material.find((m) => m.id === out.material_id)?.files[0].duration_s ?? 8) : 0;
  const total = () => out.intro.seconds + out.clips.reduce((a, k) => a + k.seconds, 0) + out.steps.reduce((a, s, i) => a + stepSeconds(s, i === out.steps.length - 1), 0) + matS;
  while (total() > c.max_reel_seconds && (out.steps.length > 2 || out.clips.length > 0)) {
    if (out.clips.length) out.clips.pop();
    else out.steps.pop();
  }
  return out;
}

/** The research pass: a second, sceptical look at every step before any money is spent. */
async function verifySteps(p: Persona, r: ReelPlan): Promise<z.infer<typeof verifySchema>> {
  return llm().structured(verifySchema, {
    operation: "reel.verify",
    tier: "smart",
    maxTokens: 4000,
    system: `You are a meticulous phone-settings fact checker. You check step-by-step phone tips before they are published to thousands of people.
For each step, check against how ${r.os === "android" ? "current stock Android (Pixel) and the most common Samsung One UI" : "the current version of iOS"} really works: the exact menu names, their order, which screen they are on, and what each switch is called. Fix names and paths that are wrong; drop steps you cannot confirm. Mark accurate only if you would bet on every step.
Return JSON only.`,
    prompt: `TIP: ${r.topic}\nCREATOR: ${p.identity.name}, ${p.identity.occupation}\nSTEPS:\n${JSON.stringify(r.steps, null, 1)}`,
  });
}
