import { env } from "../config/env.js";
import { getControls, type Controls } from "../config/controls.js";
import { assertBudget, recordCost } from "../cost/ledger.js";
import { many, one } from "../db/pool.js";
import { imageGenerator, type GeneratedImage } from "../kie/generator.js";
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
import { slidePrompt, slideReferences } from "./visual.js";

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
  const post = await one<PostRow>("SELECT * FROM posts WHERE id = $1", [postId]);
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
      if (i === 0) coverSource = generated.sourceUrl;
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

/** image.generate + image.validate for one slide, with bounded retries. */
async function generateValidatedSlide(
  p: Persona,
  c: Controls,
  post: PostRow,
  slide: Slide,
  index: number,
  total: number,
  coverSource: string | undefined,
): Promise<GeneratedImage | undefined> {
  const gen = imageGenerator();
  const prompt = slidePrompt(p, { format: post.media_type === "CAROUSEL" ? "carousel" : "single" }, slide, post.visual_state, index, total);
  const refs = slideReferences(p, slide, index > 0 ? coverSource : undefined);
  let reference: Buffer | undefined;

  for (let attempt = 1; attempt <= c.max_retries_per_image + 1; attempt++) {
    const usd = gen.estimateCredits() * env().KIE_USD_PER_CREDIT;
    if (usd > 0) await assertBudget("image", usd);

    // Resume a task a crashed attempt already paid for.
    const pending = await one<{ id: number; task_id: string; key_index: number | null }>(
      `SELECT id, task_id, key_index FROM generation_jobs WHERE post_id = $1 AND position = $2 AND status = 'submitted' AND task_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [post.id, index],
    );
    let jobRowId: number;
    let img: GeneratedImage;
    try {
      if (pending && gen.resume) {
        jobRowId = pending.id;
        img = await gen.resume(pending.task_id, pending.key_index ?? undefined);
      } else {
        const row = await one<{ id: number }>(
          `INSERT INTO generation_jobs (post_id, position, provider, model, prompt, input, attempt) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [post.id, index, gen.name, gen.model, prompt, JSON.stringify({ references: refs }), attempt],
        );
        jobRowId = row!.id;
        img = await gen.generate({ prompt, referenceUrls: refs, aspectRatio: "4:5" }, async (taskId, keyIndex) => {
          await one("UPDATE generation_jobs SET status = 'submitted', task_id = $2, key_index = $3, updated_at = now() WHERE id = $1", [jobRowId, taskId, keyIndex]);
        });
      }
    } catch (e) {
      // Transient errors (timeouts, network, 429) leave a submitted task as
      // `submitted` so the job retry resumes it instead of paying again.
      if (!(e instanceof PermanentError)) throw e;
      await one("UPDATE generation_jobs SET status = 'failed', error = $1, updated_at = now() WHERE post_id = $2 AND position = $3 AND status IN ('queued','submitted')", [
        errorMessage(e).slice(0, 500),
        post.id,
        index,
      ]);
      if (attempt <= c.max_retries_per_image && !(e instanceof BudgetExceededError)) {
        await recordEvent("warn", "image", "Image generation failed; retrying with a fresh task", { postId: post.id, index, attempt, error: errorMessage(e) });
        continue;
      }
      throw e;
    }

    const cost = img.credits * env().KIE_USD_PER_CREDIT;
    await one("UPDATE generation_jobs SET status = 'success', result_urls = $2, credits = $3, cost_usd = $4, latency_ms = $5, updated_at = now() WHERE id = $1", [
      jobRowId,
      [img.sourceUrl],
      img.credits,
      cost,
      img.latencyMs,
    ]);
    await recordCost({
      category: "image",
      provider: gen.name,
      model: img.model,
      operation: attempt > 1 ? "image_retry" : "image",
      units: { credits: img.credits },
      costUsd: cost,
      refType: "post",
      refId: post.id,
    });

    const pixels = await inspectImage(img.bytes);
    let problems = pixels.problems;
    if (pixels.ok && gen.name !== "mock") {
      if (slide.include_character && p.visual.character.reference_images[0] && !reference) {
        reference = await download(p.visual.character.reference_images[0]).catch(() => undefined);
      }
      const v = await visionQc({ image: img.bytes, reference, shotBrief: slide.shot, includeCharacter: slide.include_character, ref: { type: "post", id: post.id } });
      const verdict = visionVerdict(v, slide.include_character);
      problems = verdict.ok ? [] : verdict.problems;
    }
    if (!problems.length) return img;
    await recordEvent("warn", "image", "Generated image rejected by QC", { postId: post.id, index, attempt, problems });
    await recordDecision({
      agent: "quality_control",
      subjectType: "post",
      subjectId: post.id,
      action: "reject_image",
      reason: problems.join("; ").slice(0, 400),
      output: { index, attempt, taskId: img.taskId },
    });
  }
  return undefined;
}

async function composeAndHost(p: Persona, post: PostRow, slide: Slide, index: number, total: number, img: GeneratedImage): Promise<void> {
  const overlay: Overlay = {
    kind: slide.overlay_kind,
    heading: slide.overlay_heading || undefined,
    body: slide.overlay_body || undefined,
    counter: total > 1 ? `${index + 1}/${total}` : undefined,
    handle: total > 1 && index === 0 ? p.identity.handle : undefined,
  };
  const { jpeg, width, height } = await composeSlide(img.bytes, overlay, p.carousel.brand_colors);
  const digest = sha256(jpeg);
  const hosted = await hostImage(jpeg, `posts/${post.id}/${index + 1}-${digest.slice(0, 10)}.jpg`);
  await one(
    `INSERT INTO post_assets (post_id, position, role, prompt, overlay, generated_url, public_url, storage_provider, width, height, sha256, qc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (post_id, position) DO UPDATE SET prompt = EXCLUDED.prompt, overlay = EXCLUDED.overlay, generated_url = EXCLUDED.generated_url,
       public_url = EXCLUDED.public_url, storage_provider = EXCLUDED.storage_provider, width = EXCLUDED.width, height = EXCLUDED.height,
       sha256 = EXCLUDED.sha256, qc = EXCLUDED.qc, updated_at = now()`,
    [
      post.id,
      index,
      slide.role,
      slidePrompt(p, { format: total > 1 ? "carousel" : "single" }, slide, post.visual_state, index, total),
      JSON.stringify({ ...overlay, alt_text: slide.alt_text }),
      img.sourceUrl,
      hosted.url,
      hosted.provider,
      width,
      height,
      digest,
      JSON.stringify({ bytes: jpeg.length, taskId: img.taskId }),
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
  await queue("publish").add(JOBS.postPublish, { postId }, { jobId: jobId("publish", postId), delay: Math.max(0, at.getTime() - now.getTime()) });
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
