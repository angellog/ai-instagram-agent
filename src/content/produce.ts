import { getControls, type Controls } from "../config/controls.js";
import { currentInfluencer, influencerId } from "../context.js";
import { many, one } from "../db/pool.js";
import { assetBytes, generate } from "../generation/service.js";
import { GenerationError } from "../generation/types.js";
import { activeSoul, soulContext } from "../souls/souls.js";
import { sha256 } from "../lib/crypto.js";
import { recordDecision } from "../lib/decisions.js";
import { BudgetExceededError, errorMessage, PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { localParts } from "../lib/time.js";
import { notify } from "../notify/telegram.js";
import { persona } from "../persona/loader.js";
import type { Persona } from "../persona/schema.js";
import { JOBS, jobId, queue } from "../queue/queues.js";
import { composeSlide, inspectImage, type Overlay } from "../render/compose.js";
import { assessText, gate, openReview } from "../safety/safety.js";
import { download, hostImage } from "../storage/host.js";
import type { Idea } from "./director.js";
import type { VisualState } from "./history.js";
import { structuralQc, visionQc, visionVerdict } from "./qc.js";
import { slidePrompt } from "./visual.js";

type Slide = Idea["slides"][number];

interface PostRow {
  id: string;
  content_idea_id: number;
  media_type: "IMAGE" | "CAROUSEL";
  caption: string;
  status: string;
  visual_state: VisualState;
}

interface AssetRow {
  position: number;
  public_url: string | null;
  generated_url: string | null;
  width: number | null;
  height: number | null;
  overlay: Overlay | null;
}

export type ProduceOutcome = "approved" | "awaiting_review" | "dry_run" | "rejected" | "qc_failed" | "failed" | "skipped";

/**
 * `content.produce` job: Visual Director → image generation → validation →
 * carousel composition → QC → safety → gate. Each slide is checkpointed in
 * post_assets / generation_jobs, so a retry resumes where it stopped and never
 * pays for an image twice.
 */
export async function producePost(postId: string): Promise<ProduceOutcome> {
  const post = await one<PostRow>("SELECT * FROM posts WHERE id = $1 AND influencer_id = $2", [postId, influencerId()]);
  if (!post || !["draft", "generating", "composing"].includes(post.status)) return "skipped";
  const idea = await one<{ plan: { slides: Slide[] }; format: string; topic: string }>("SELECT plan, format, topic FROM content_ideas WHERE id = $1", [
    post.content_idea_id,
  ]);
  if (!idea) throw new PermanentError(`content idea ${post.content_idea_id} missing`);
  const c = await getControls();
  const p = persona();

  if (!c.image_generation_enabled) {
    await failPost(postId, "failed", "image generation is disabled in controls");
    return "failed";
  }

  await one("UPDATE posts SET status = 'generating', updated_at = now() WHERE id = $1", [postId]);
  const slides = idea.plan.slides;
  const total = slides.length;
  const existing = new Map((await many<AssetRow>("SELECT position, public_url, generated_url, width, height, overlay FROM post_assets WHERE post_id = $1", [postId])).map((a) => [a.position, a]));
  let coverSource = existing.get(0)?.generated_url ?? undefined;

  for (let i = 0; i < total; i++) {
    if (existing.get(i)?.public_url) continue;
    const slide = slides[i];
    try {
      const generated = await generateValidatedSlide(p, c, post, slide, i, total, coverSource);
      if (!generated) {
        await failPost(postId, "qc_failed", `slide ${i + 1} failed validation after ${c.max_retries_per_image + 1} attempts`);
        await notify(`⚠️ Post ${postId.slice(0, 8)} failed image QC on slide ${i + 1}`, `/admin/posts/${postId}`);
        return "qc_failed";
      }
      await composeAndHost(p, post, slide, i, total, generated);
      if (i === 0) coverSource = generated.url;
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        await failPost(postId, "failed", e.message);
        await recordEvent("warn", "content", "Production stopped by budget", { postId, error: e.message });
        return "failed";
      }
      throw e;
    }
  }

  return finalizePost(postId, c, p);
}

interface SlideImage {
  bytes: Buffer;
  url: string; // durable, influencer-owned asset URL
  assetId: string;
  providerRequestId: string;
  provider: string;
  model: string;
}

/**
 * image.generate + image.validate for one slide, through the Generation
 * Engine. The engine picks the provider; this function owns the creative
 * intent (prompt, identity references, ratio) and quality. Each QC retry is a
 * new idempotency key; a crashed job replays the same key and gets the stored
 * result instead of paying again.
 */
async function generateValidatedSlide(
  p: Persona,
  c: Controls,
  post: PostRow,
  slide: Slide,
  index: number,
  total: number,
  coverUrl: string | undefined,
): Promise<SlideImage | undefined> {
  const soul = await activeSoul();
  const prompt = slidePrompt(p, { format: post.media_type === "CAROUSEL" ? "carousel" : "single" }, slide, post.visual_state, index, total);
  const identity = slide.include_character ? (soul?.identityRefs ?? []) : [];
  const refs = [...identity, ...(index > 0 && coverUrl ? [coverUrl] : [])];
  let reference: Buffer | undefined;

  for (let attempt = 1; attempt <= c.max_retries_per_image + 1; attempt++) {
    let result;
    try {
      result = await generate({
        influencerId: influencerId(),
        idempotencyKey: `post:${post.id}:slide:${index}:try:${attempt}`,
        purpose: "post",
        postId: post.id,
        modality: refs.length ? "reference_image" : "text_to_image",
        prompt,
        negativePrompt: p.visual.photography.negative || undefined,
        references: refs,
        soul: slide.include_character ? soulContext(soul) : undefined,
        aspectRatio: "4:5",
        resolution: "2K",
        quality: "high",
        identityConsistency: slide.include_character ? "high" : "medium",
        metadata: { position: index, retry: attempt - 1 },
      });
    } catch (e) {
      if (e instanceof GenerationError && e.errorClass === "budget") throw new BudgetExceededError(e.message);
      if (e instanceof GenerationError && !["unsupported", "validation", "auth"].includes(e.errorClass) && attempt <= c.max_retries_per_image) {
        await recordEvent("warn", "image", "Slide generation failed on every eligible model; retrying with a fresh request (content filters are stochastic)", { postId: post.id, index, attempt, error: errorMessage(e) });
        continue;
      }
      if (e instanceof GenerationError) throw new PermanentError(`Generation failed: ${e.message}`);
      throw e;
    }
    const asset = result.assets[0];
    const bytes = await assetBytes(asset);
    const pixels = await inspectImage(bytes);
    let problems = pixels.problems;
    if (pixels.ok && result.provider !== "mock") {
      if (slide.include_character && soul?.primaryRef && !reference) reference = await download(soul.primaryRef).catch(() => undefined);
      const v = await visionQc({ image: bytes, reference, shotBrief: slide.shot, includeCharacter: slide.include_character, ref: { type: "post", id: post.id } });
      const verdict = visionVerdict(v, slide.include_character);
      problems = verdict.ok ? [] : verdict.problems;
    }
    if (!problems.length) {
      return { bytes, url: asset.url, assetId: asset.assetId, providerRequestId: result.providerRequestId, provider: result.provider, model: result.model };
    }
    await recordEvent("warn", "image", "Generated image rejected by QC", { postId: post.id, index, attempt, problems, provider: result.provider, model: result.model });
    await recordDecision({
      agent: "quality_control",
      subjectType: "post",
      subjectId: post.id,
      action: "reject_image",
      reason: problems.join("; ").slice(0, 400),
      output: { index, attempt, provider: result.provider, model: result.model, requestId: result.requestId },
    });
  }
  return undefined;
}

async function composeAndHost(p: Persona, post: PostRow, slide: Slide, index: number, total: number, img: SlideImage): Promise<void> {
  // No handle or slide counter ever (Instagram shows its own dots); text only
  // when the persona opts in, and never on a photo of her.
  const textAllowed = p.carousel.text_overlays && !slide.include_character;
  const overlay: Overlay = textAllowed
    ? { kind: slide.overlay_kind, heading: slide.overlay_heading || undefined, body: slide.overlay_body || undefined }
    : { kind: "none" };
  const { jpeg, width, height } = await composeSlide(img.bytes, overlay, p.carousel.brand_colors);
  const digest = sha256(jpeg);
  const hosted = await hostImage(jpeg, `influencers/${currentInfluencer().slug}/posts/${post.id}/${index + 1}-${digest.slice(0, 10)}.jpg`);
  await one(
    `INSERT INTO post_assets (post_id, position, role, prompt, overlay, generated_url, public_url, storage_provider, width, height, sha256, qc, asset_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (post_id, position) DO UPDATE SET prompt = EXCLUDED.prompt, overlay = EXCLUDED.overlay, generated_url = EXCLUDED.generated_url,
       public_url = EXCLUDED.public_url, storage_provider = EXCLUDED.storage_provider, width = EXCLUDED.width, height = EXCLUDED.height,
       sha256 = EXCLUDED.sha256, qc = EXCLUDED.qc, asset_id = EXCLUDED.asset_id, updated_at = now()`,
    [
      post.id,
      index,
      slide.role,
      slidePrompt(p, { format: total > 1 ? "carousel" : "single" }, slide, post.visual_state, index, total),
      JSON.stringify({ ...overlay, alt_text: slide.alt_text }),
      img.url,
      hosted.url,
      hosted.provider,
      width,
      height,
      digest,
      JSON.stringify({ bytes: jpeg.length, providerRequestId: img.providerRequestId, provider: img.provider, model: img.model }),
      img.assetId,
    ],
  );
}

/** carousel.compose tail: structural QC → safety → gate → schedule. */
export async function finalizePost(postId: string, c: Controls, p: Persona): Promise<ProduceOutcome> {
  await one("UPDATE posts SET status = 'composing', updated_at = now() WHERE id = $1", [postId]);
  const post = (await one<PostRow>("SELECT * FROM posts WHERE id = $1", [postId]))!;
  const assets = await many<AssetRow & { qc: { bytes?: number } }>(
    "SELECT position, public_url, generated_url, width, height, overlay, qc FROM post_assets WHERE post_id = $1 ORDER BY position",
    [postId],
  );
  const overlayText = (a: AssetRow) => [a.overlay?.heading, a.overlay?.body].filter(Boolean).join(" ");
  const problems = structuralQc(
    {
      mediaType: post.media_type,
      caption: post.caption,
      slides: assets.map((a) => ({ position: a.position, publicUrl: a.public_url, width: a.width, height: a.height, bytes: a.qc?.bytes, overlayText: overlayText(a) })),
    },
    p,
  );
  if (problems.length) {
    await failPost(postId, "qc_failed", problems.join("; "));
    await notify(`⚠️ Post ${postId.slice(0, 8)} failed QC: ${problems.join("; ")}`, `/admin/posts/${postId}`);
    return "qc_failed";
  }

  const allText = [post.caption, ...assets.map(overlayText)].filter(Boolean).join("\n");
  const assessment = await assessText(allText, { direction: "outbound", context: "Instagram post caption and on-image text", ref: { type: "post", id: postId } });
  const outcome = gate(assessment.level, c);
  await one("UPDATE posts SET safety_level = $2, qc = $3, updated_at = now() WHERE id = $1", [
    postId,
    assessment.level,
    JSON.stringify({ structural: "pass", safety: { categories: assessment.categories, reason: assessment.reason } }),
  ]);
  await one("UPDATE content_ideas SET status = 'produced', updated_at = now() WHERE id = $1", [post.content_idea_id]);
  await recordDecision({
    agent: "safety",
    subjectType: "post",
    subjectId: postId,
    action: outcome,
    safetyLevel: assessment.level,
    reason: assessment.reason,
    output: { categories: assessment.categories },
  });

  if (outcome === "block") {
    await openReview({ subjectType: "post", subjectId: postId, assessment, proposed: { caption: post.caption }, status: "rejected" });
    await failPost(postId, "rejected", `safety red: ${assessment.categories.join(", ")}`);
    return "rejected";
  }
  if (outcome === "review") {
    await openReview({ subjectType: "post", subjectId: postId, assessment, proposed: { caption: post.caption, slides: assets.map((a) => a.public_url) } });
    await one("UPDATE posts SET status = 'awaiting_review', updated_at = now() WHERE id = $1", [postId]);
    await notify(`🖼 Post ready for review (${assessment.level}): ${post.caption.slice(0, 140)}`, `/admin/posts/${postId}`);
    return "awaiting_review";
  }
  if (outcome === "dry_run") {
    await one("UPDATE posts SET status = 'dry_run', updated_at = now() WHERE id = $1", [postId]);
    await recordEvent("info", "content", "Dry run: post produced but not published", { postId });
    return "dry_run";
  }
  await one("UPDATE posts SET status = 'approved', reviewed_by = 'auto', reviewed_at = now(), updated_at = now() WHERE id = $1", [postId]);
  await schedulePublish(postId, c, p);
  return "approved";
}

/** Queue publishing now, or at the start of the next posting window. */
export async function schedulePublish(postId: string, c: Controls, p: Persona, now = new Date()): Promise<Date> {
  const at = nextPublishTime(now, c, p.identity.timezone);
  await one("UPDATE posts SET scheduled_for = $2, updated_at = now() WHERE id = $1", [postId, at]);
  await queue("publish").add(JOBS.postPublish, { influencerId: influencerId(), postId }, { jobId: jobId("publish", postId), delay: Math.max(0, at.getTime() - now.getTime()) });
  return at;
}

export function nextPublishTime(now: Date, c: Pick<Controls, "posting_window_start_hour" | "posting_window_end_hour">, timeZone: string): Date {
  const { hour } = localParts(now, timeZone);
  if (hour >= c.posting_window_start_hour && hour < c.posting_window_end_hour) return now;
  // Step forward hour by hour (at most a day) until inside the window.
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 25; i++) {
    t.setUTCHours(t.getUTCHours() + 1);
    const h = localParts(t, timeZone).hour;
    if (h >= c.posting_window_start_hour && h < c.posting_window_end_hour) return new Date(t.getTime() + 5 * 60_000);
  }
  return now;
}

export async function failPost(postId: string, status: "failed" | "qc_failed" | "rejected", reason: string): Promise<void> {
  await one("UPDATE posts SET status = $2, last_error = $3, updated_at = now() WHERE id = $1", [postId, status, reason.slice(0, 1000)]);
  await one("UPDATE content_ideas SET status = 'failed', updated_at = now() WHERE id = (SELECT content_idea_id FROM posts WHERE id = $1) AND status <> 'produced'", [postId]);
  await recordEvent(status === "rejected" ? "warn" : "error", "content", `Post ${status}`, { postId, reason });
}
