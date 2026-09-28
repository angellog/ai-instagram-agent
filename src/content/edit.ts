import { currentInfluencer, influencerId } from "../context.js";
import { checkFacts } from "../conversation/facts.js";
import { knowledge } from "../conversation/knowledge.js";
import { many, one, tx } from "../db/pool.js";
import { sha256 } from "../lib/crypto.js";
import { recordDecision } from "../lib/decisions.js";
import { persona } from "../persona/loader.js";
import { composeSlide, sanitizeOverlayText, STORY, type Overlay } from "../render/compose.js";
import { assessText } from "../safety/safety.js";
import { download, hostImage } from "../storage/host.js";
import { MAX_CAPTION, MAX_HASHTAGS } from "./caption.js";
import { clearPublishJobs } from "./schedule.js";

/**
 * Operator edits before approval: caption, slide order, removing slides, a
 * story's on-image text, or deleting the draft. Every edit is recorded in the
 * decision trail and keeps the pending review in step with the post.
 */

/** Post states in which the operator may still change what goes out. */
export const EDITABLE = ["awaiting_review", "dry_run", "qc_failed"];

export type EditResult = { ok: boolean; message: string };
const fail = (message: string): EditResult => ({ ok: false, message });

interface EditRow {
  status: string;
  media_type: "IMAGE" | "CAROUSEL" | "STORY";
  ig_media_id: string | null;
}

async function editable(postId: string): Promise<EditRow | string> {
  const post = await one<EditRow>("SELECT status, media_type, ig_media_id FROM posts WHERE id = $1 AND influencer_id = $2", [postId, influencerId()]);
  if (!post) return "Post not found";
  if (post.ig_media_id || post.status === "published") return "It's already on Instagram; edit it there";
  if (post.status === "approved") return "It's approved and scheduled: unschedule it first, then edit";
  if (!EDITABLE.includes(post.status)) return `It can't be edited while it's ${post.status.replace("_", " ")}`;
  return post;
}

/** Keep a pending review's snapshot (caption, slide URLs) matching the post. */
async function syncReview(postId: string): Promise<void> {
  const post = await one<{ caption: string }>("SELECT caption FROM posts WHERE id = $1", [postId]);
  const slides = (await many<{ public_url: string }>("SELECT public_url FROM post_assets WHERE post_id = $1 ORDER BY position", [postId])).map((a) => a.public_url);
  await one(
    `UPDATE safety_reviews SET proposed = proposed || jsonb_build_object('caption', $2::text, 'slides', $3::jsonb)
     WHERE subject_type = 'post' AND subject_id = $1 AND status = 'pending'`,
    [postId, post?.caption ?? "", JSON.stringify(slides)],
  );
}

async function log(postId: string, action: string, reason: string, by: string): Promise<void> {
  await recordDecision({ agent: "human_reviewer", subjectType: "post", subjectId: postId, action, reason: `${by}: ${reason}`.slice(0, 400) });
}

export async function editCaption(postId: string, text: string, by: string): Promise<EditResult> {
  const post = await editable(postId);
  if (typeof post === "string") return fail(post);
  if (post.media_type === "STORY") return fail("Stories have no caption; edit the words on the image instead");
  const caption = text.replace(/\r\n/g, "\n").trim();
  if (!caption) return fail("The caption can't be empty");
  if (caption.length > MAX_CAPTION) return fail(`Instagram allows ${MAX_CAPTION} characters; this is ${caption.length}`);
  const tags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (tags.length > MAX_HASHTAGS) return fail(`Instagram allows ${MAX_HASHTAGS} hashtags; this has ${tags.length}`);
  const a = await assessText(caption, { direction: "outbound", skipLlm: true });
  if (a.level === "red") return fail(`Not saved: the safety rules mark this caption red (${a.categories.join(", ")})`);
  await one("UPDATE posts SET caption = $2, updated_at = now() WHERE id = $1", [postId, caption]);
  await syncReview(postId);
  await log(postId, "edit_caption", `${caption.length} chars`, by);
  return { ok: true, message: a.level === "yellow" ? `Caption saved (flagged ${a.categories.join(", ")}: check it before approving)` : "Caption saved" };
}

/** Put the slide at `from` at position `to`; the others shift to make room. */
export async function moveSlide(postId: string, from: number, to: number, by: string): Promise<EditResult> {
  const post = await editable(postId);
  if (typeof post === "string") return fail(post);
  return tx(async (c) => {
    const rows = (await c.query<{ id: number; position: number }>("SELECT id, position FROM post_assets WHERE post_id = $1 ORDER BY position FOR UPDATE", [postId])).rows;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= rows.length) return fail("No such slide");
    const target = Math.max(0, Math.min(rows.length - 1, to));
    if (target === from) return { ok: true, message: "Nothing to move" };
    const order = rows.map((r) => r.id);
    const [moved] = order.splice(from, 1);
    order.splice(target, 0, moved);
    // Two passes through negative positions so the unique (post_id, position) index never trips.
    for (const [i, id] of order.entries()) await c.query("UPDATE post_assets SET position = $2 WHERE id = $1", [id, -1 - i]);
    await c.query("UPDATE post_assets SET position = -position - 1, updated_at = now() WHERE post_id = $1", [postId]);
    await c.query("UPDATE posts SET updated_at = now() WHERE id = $1", [postId]);
    await log(postId, "reorder_slides", `slide ${from + 1} → ${target + 1}`, by);
    return { ok: true, message: target === 0 ? `Slide ${from + 1} is now the cover` : `Moved slide ${from + 1} to position ${target + 1}` };
  }).then(async (r) => {
    if (r.ok) await syncReview(postId);
    return r;
  });
}

export async function removeSlide(postId: string, position: number, by = "operator"): Promise<EditResult> {
  const post = await editable(postId);
  if (typeof post === "string") return fail(post);
  const r = await tx(async (c) => {
    const n = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM post_assets WHERE post_id = $1", [postId])).rows[0].n;
    if (n <= 1) return fail("A post needs at least one image; delete the post instead");
    const del = await c.query("DELETE FROM post_assets WHERE post_id = $1 AND position = $2", [postId, position]);
    if (!del.rowCount) return fail("No such slide");
    // Shift later slides down (via negative positions to respect the unique index).
    await c.query("UPDATE post_assets SET position = -position - 1 WHERE post_id = $1 AND position > $2", [postId, position]);
    await c.query("UPDATE post_assets SET position = -position - 2 WHERE post_id = $1 AND position < 0", [postId]);
    if (n - 1 === 1) await c.query("UPDATE posts SET media_type = 'IMAGE', updated_at = now() WHERE id = $1 AND media_type = 'CAROUSEL'", [postId]);
    return { ok: true, message: `Removed slide ${position + 1}; ${n - 1} left${n - 1 === 1 ? " (it's a single photo now)" : ""}` };
  });
  if (r.ok) {
    await syncReview(postId);
    await log(postId, "remove_slide", `slide ${position + 1}`, by);
  }
  return r;
}

/**
 * Change the words on a story. The image is re-rendered from the original
 * photo, so edits never stack text on text. Never on a photo of her; numbers
 * must come from the business knowledge.
 */
export async function editStoryText(postId: string, headingRaw: string, by: string): Promise<EditResult> {
  const post = await editable(postId);
  if (typeof post === "string") return fail(post);
  if (post.media_type !== "STORY") return fail("Only stories have editable on-image text");
  const heading = sanitizeOverlayText(headingRaw).slice(0, 90);
  const row = await one<{ include_character: boolean | null; generated_url: string | null; overlay: (Overlay & { alt_text?: string }) | null }>(
    `SELECT (ci.plan->'slides'->0->>'include_character')::boolean AS include_character, pa.generated_url, pa.overlay
     FROM posts p JOIN post_assets pa ON pa.post_id = p.id AND pa.position = 0 LEFT JOIN content_ideas ci ON ci.id = p.content_idea_id
     WHERE p.id = $1`,
    [postId],
  );
  if (!row?.generated_url) return fail("The original photo for this story isn't available; make a new story instead");
  if (row.include_character && heading) return fail("No text on photos of her (house rule): this story stays text-free");
  if (heading) {
    const a = await assessText(heading, { direction: "outbound", skipLlm: true });
    if (a.level === "red") return fail(`Not saved: the safety rules mark this text red (${a.categories.join(", ")})`);
    const facts = checkFacts(heading, { used: [], shown: knowledge(), inbound: "" });
    if (facts.unverified.length) return fail(`Not saved: ${facts.unverified.join(", ")} isn't in the business knowledge. Only use numbers you can stand behind`);
  }
  const body = row.overlay?.body;
  const overlay: Overlay = heading || body ? { kind: "story", heading: heading || undefined, body } : { kind: "none" };
  const p = persona();
  const { jpeg, width, height } = await composeSlide(await download(row.generated_url), overlay, p.carousel.brand_colors, STORY);
  const digest = sha256(jpeg);
  const hosted = await hostImage(jpeg, `influencers/${currentInfluencer().slug}/stories/${postId}/1-${digest.slice(0, 10)}.jpg`);
  await one(
    `UPDATE post_assets SET overlay = $2, public_url = $3, storage_provider = $4, width = $5, height = $6, sha256 = $7,
       qc = qc || jsonb_build_object('bytes', $8::int), updated_at = now() WHERE post_id = $1 AND position = 0`,
    [postId, JSON.stringify({ ...overlay, alt_text: row.overlay?.alt_text }), hosted.url, hosted.provider, width, height, digest, jpeg.length],
  );
  await one(
    `UPDATE content_ideas SET plan = jsonb_set(plan, '{slides,0,overlay_heading}', to_jsonb($2::text)), hook = coalesce(nullif($2, ''), hook)
     WHERE id = (SELECT content_idea_id FROM posts WHERE id = $1)`,
    [postId, heading],
  );
  await one("UPDATE posts SET updated_at = now() WHERE id = $1", [postId]);
  await syncReview(postId);
  await log(postId, "edit_story_text", heading ? `"${heading}"` : "removed the text", by);
  return { ok: true, message: heading ? "Story text updated" : "Text removed from the story" };
}

/**
 * Delete a draft for good (its images stay in storage, the decision trail
 * keeps a record). Anything already on Instagram stays; delete it there.
 */
export async function deletePost(postId: string, by: string): Promise<EditResult> {
  const post = await one<EditRow & { content_idea_id: number | null }>(
    "SELECT status, media_type, ig_media_id, content_idea_id FROM posts WHERE id = $1 AND influencer_id = $2",
    [postId, influencerId()],
  );
  if (!post) return fail("Post not found");
  if (post.ig_media_id || post.status === "published") return fail("It's already on Instagram; delete it in the app");
  if (post.status === "publishing") return fail("It's being published right now; try again in a minute");
  const noun = post.media_type === "STORY" ? "Story" : "Post";
  await clearPublishJobs(postId);
  await tx(async (c) => {
    await c.query("UPDATE safety_reviews SET status = 'rejected', reviewer = $2, reviewed_at = now(), reason = 'deleted by operator' WHERE subject_type = 'post' AND subject_id = $1 AND status = 'pending'", [postId, by]);
    if (post.content_idea_id) await c.query("UPDATE content_ideas SET status = 'rejected', reject_reason = 'deleted by operator', updated_at = now() WHERE id = $1", [post.content_idea_id]);
    await c.query("UPDATE create_runs SET post_id = NULL WHERE post_id = $1", [postId]);
    await c.query("DELETE FROM posts WHERE id = $1", [postId]);
  });
  await recordDecision({ agent: "human_reviewer", subjectType: "system", subjectId: `post-${postId}`, action: "delete_post", reason: `${by}: ${noun.toLowerCase()} deleted (was ${post.status})` });
  return { ok: true, message: `${noun} deleted` };
}
