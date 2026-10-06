import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getControls, type Controls } from "../config/controls.js";
import { currentInfluencer, influencerId } from "../context.js";
import type { Idea } from "../content/director.js";
import { failPost, finalizePost, generateValidatedSlide, pickStoryStyle, type PostRow, type ProduceOutcome } from "../content/produce.js";
import { many, one } from "../db/pool.js";
import { generate } from "../generation/service.js";
import { sha256 } from "../lib/crypto.js";
import { BudgetExceededError, PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { getLibraryItem } from "../library/library.js";
import { ffmpeg, frameAt, REEL, toReelMp4, withTemp } from "../media/video.js";
import { persona } from "../persona/loader.js";
import type { Persona } from "../persona/schema.js";
import { renderOverlayPng, STORY } from "../render/compose.js";
import { download, hostImage, mediaPrefix } from "../storage/host.js";
import { renderExplainer } from "./explainer.js";
import type { ReelClip, ReelPlan } from "./plan.js";

/**
 * Make a planned reel: each clip is a photo of the creator in their real
 * setting (same identity, wardrobe and local-realism rules as every post),
 * animated into a short video; the hook line goes on the opening seconds;
 * explainers add the recreated phone-screen steps; uploaded reel material is
 * cut in. One 1080x1920 MP4 plus its cover, then the usual checks and review.
 */
export async function produceReel(postId: string): Promise<ProduceOutcome> {
  const post = await one<PostRow & { content_idea_id: number }>("SELECT * FROM posts WHERE id = $1 AND influencer_id = $2", [postId, influencerId()]);
  if (!post || !["draft", "generating", "composing"].includes(post.status)) return "skipped";
  const idea = await one<{ plan: ReelPlan; structure: string }>("SELECT plan, structure FROM content_ideas WHERE id = $1", [post.content_idea_id]);
  if (!idea) throw new PermanentError(`reel plan for ${postId} missing`);
  const c = await getControls();
  const p = persona();
  if (!c.image_generation_enabled) {
    await failPost(postId, "failed", "image generation is disabled in controls");
    return "failed";
  }
  await one("UPDATE posts SET status = 'generating', updated_at = now() WHERE id = $1", [postId]);
  const reel = idea.plan;
  try {
    const segments: Buffer[] = [];
    let cover: Buffer | undefined;
    const clips = [reel.intro, ...reel.clips];
    for (const [i, clip] of clips.entries()) {
      const made = await makeClip(p, c, post, clip, i, reel);
      if (!made) {
        await failPost(postId, "qc_failed", `reel clip ${i + 1} failed the photo check`);
        return "qc_failed";
      }
      cover ??= made.keyframe;
      segments.push(i === 0 && reel.hook ? await withHook(made.mp4, reel.hook, postId) : made.mp4);
      // An explainer's steps come straight after the creator's introduction.
      if (i === 0 && reel.kind === "explainer" && reel.steps.length) {
        segments.push((await renderExplainer(reel.steps, { os: reel.os ?? "ios", bg: [p.carousel.brand_colors.primary, "#0B0B0F"] })).mp4);
      }
    }
    if (reel.material_id) {
      const m = await getLibraryItem(reel.material_id);
      if (m?.files[0]) segments.push((await toReelMp4(await download(m.files[0].url, 250 * 1024 * 1024, "video/"), { maxS: 8 })).mp4);
    }
    const { mp4, seconds } = await concatReel(segments, c.max_reel_seconds);
    const prefix = `${mediaPrefix(currentInfluencer().id)}/reels/${postId}`;
    const video = await hostImage(mp4, `${prefix}/reel-${sha256(mp4).slice(0, 10)}.mp4`, { contentType: "video/mp4", order: ["supabase", "local"] });
    const coverJpeg = cover ?? (await frameAt(mp4, 1));
    const coverHosted = await hostImage(coverJpeg, `${prefix}/cover-${sha256(coverJpeg).slice(0, 10)}.jpg`);
    await one("DELETE FROM post_assets WHERE post_id = $1", [postId]);
    await one(
      `INSERT INTO post_assets (post_id, position, role, prompt, overlay, generated_url, public_url, storage_provider, width, height, sha256, qc, media_kind, duration_s)
       VALUES ($1, 0, 'cover', $2, $3, $4, $4, $5, ${REEL.w}, ${REEL.h}, $6, $7, 'video', $8)`,
      [postId, `${reel.kind}: ${reel.topic}`, JSON.stringify({ kind: "none", alt_text: reel.topic }), video.url, video.provider, sha256(mp4), JSON.stringify({ bytes: mp4.length, seconds }), seconds],
    );
    await one(
      `INSERT INTO post_assets (post_id, position, role, prompt, overlay, generated_url, public_url, storage_provider, width, height, sha256, qc, media_kind)
       VALUES ($1, 1, 'slide', 'reel cover', $2, $3, $3, $4, ${REEL.w}, ${REEL.h}, $5, $6, 'image')`,
      [postId, JSON.stringify({ kind: "none", alt_text: reel.topic }), coverHosted.url, coverHosted.provider, sha256(coverJpeg), JSON.stringify({ bytes: coverJpeg.length })],
    );
    await recordEvent("info", "content", `Reel made: ${reel.kind}, ${Math.round(seconds)}s`, { postId, segments: segments.length });
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      await failPost(postId, "failed", e.message);
      return "failed";
    }
    throw e;
  }
  return finalizePost(postId, c, p);
}

/** One clip: a validated photo of the moment, then image→video with the planned motion. */
async function makeClip(p: Persona, c: Controls, post: PostRow, clip: ReelClip, index: number, reel: ReelPlan): Promise<{ mp4: Buffer; keyframe: Buffer } | undefined> {
  const slide: Idea["slides"][number] = {
    role: "cover",
    shot: clip.shot,
    composition: clip.composition,
    include_character: clip.include_character,
    overlay_kind: "none",
    overlay_heading: "",
    overlay_body: "",
    alt_text: clip.shot.slice(0, 200),
  };
  const state = { ...post.visual_state, location_id: clip.location_id, time_of_day: clip.time_of_day, featured_item: reel.featured_item || undefined };
  const still = await generateValidatedSlide(p, c, { ...post, visual_state: state }, slide, index, 1, undefined);
  if (!still) return undefined;
  const video = await generate({
    influencerId: influencerId(),
    idempotencyKey: `reel:${post.id}:clip:${index}`,
    purpose: "post",
    postId: post.id,
    modality: "image_to_video",
    prompt: `${clip.motion}. Natural handheld phone video, realistic motion, the same person and place as the first frame, no text on screen, no cuts.`,
    references: [still.url],
    aspectRatio: "9:16",
    durationSeconds: clip.seconds,
    audio: true,
    quality: "standard",
    identityConsistency: clip.include_character ? "high" : "medium",
  });
  const bytes = video.assets[0]?.bytes;
  if (!bytes) throw new PermanentError("the video model returned nothing");
  const { mp4 } = await toReelMp4(bytes, { maxS: clip.seconds + 1 });
  return { mp4, keyframe: still.bytes };
}

/** Burn the hook line onto the first 2.8 seconds, in one of the story text styles. */
async function withHook(mp4: Buffer, hook: string, postId: string): Promise<Buffer> {
  const style = await pickStoryStyle(postId);
  const png = renderOverlayPng({ kind: "story", heading: hook, ...style }, persona().carousel.brand_colors, STORY);
  return withTemp(async (dir) => {
    await writeFile(join(dir, "in.mp4"), mp4);
    await writeFile(join(dir, "hook.png"), png);
    await ffmpeg(["-y", "-i", join(dir, "in.mp4"), "-i", join(dir, "hook.png"), "-filter_complex", "[0:v][1:v]overlay=0:0:enable='between(t,0,2.8)'[v]", "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "copy", "-movflags", "+faststart", join(dir, "out.mp4")]);
    return readFile(join(dir, "out.mp4"));
  });
}

/** Join the normalised segments (all 1080x1920, 30 fps, AAC) into one reel, capped in length. */
export async function concatReel(segments: Buffer[], maxS: number): Promise<{ mp4: Buffer; seconds: number }> {
  if (!segments.length) throw new PermanentError("a reel needs at least one clip");
  return withTemp(async (dir) => {
    const inputs: string[] = [];
    for (const [i, s] of segments.entries()) {
      const f = join(dir, `s${i}.mp4`);
      await writeFile(f, s);
      inputs.push("-i", f);
    }
    const n = segments.length;
    const norm = segments.map((_, i) => `[${i}:v]scale=${REEL.w}:${REEL.h},setsar=1,fps=${REEL.fps},format=yuv420p[v${i}];[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`).join(";");
    const chain = segments.map((_, i) => `[v${i}][a${i}]`).join("");
    const out = join(dir, "reel.mp4");
    await ffmpeg(["-y", ...inputs, "-filter_complex", `${norm};${chain}concat=n=${n}:v=1:a=1[v][a]`, "-map", "[v]", "-map", "[a]", "-t", String(maxS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-maxrate", "5M", "-bufsize", "10M", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]);
    const mp4 = await readFile(out);
    const { probeVideo } = await import("../media/video.js");
    return { mp4, seconds: (await probeVideo(out)).durationS };
  });
}

/** Reels waiting for production (dashboard). */
export async function reelsInProgress(): Promise<number> {
  return (await many("SELECT 1 FROM posts WHERE influencer_id = $1 AND media_type = 'REEL' AND status IN ('draft','generating','composing')", [influencerId()])).length;
}
