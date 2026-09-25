import { getControls, isSendingDisabled } from "../config/controls.js";
import { influencerId } from "../context.js";
import { db, many, one } from "../db/pool.js";
import { instagramClient } from "../instagram/accounts.js";
import type { InstagramClient } from "../instagram/client.js";
import { recordDecision } from "../lib/decisions.js";
import { errorMessage, PermanentError, TransientError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { applyMemoryPolicy } from "../memory/policy.js";
import { upsertMemory } from "../memory/store.js";
import { notify } from "../notify/telegram.js";
import { CHECKPOINTS } from "../analytics/learnings.js";
import { JOBS, jobId, queue } from "../queue/queues.js";

interface PublishRow {
  id: string;
  status: string;
  media_type: "IMAGE" | "CAROUSEL";
  caption: string;
  ig_container_id: string | null;
  ig_child_container_ids: string[];
  ig_media_id: string | null;
  publish_attempts: number;
  content_idea_id: number | null;
  publish_override: "operator" | null;
  updated_at: Date;
}

export type PublishOutcome = "published" | "already_published" | "dry_run" | "skipped" | "deferred";

const LOCK_NS = 0x49_47; // "IG"

/**
 * `post.publish` job (brief §15: "Do not allow duplicate Instagram posts
 * because of retries"). Duplicate protection is layered:
 *   1. BullMQ jobId publish-<postId>: one queued job per post.
 *   2. A Postgres advisory lock per post: one publisher at a time, even across
 *      worker replicas.
 *   3. A persisted state machine: container ids are saved before the next
 *      step, so a retry resumes instead of creating new containers.
 *   4. Before calling media_publish again, the container's status is read; if
 *      Meta says PUBLISHED, the media is recovered from the account feed
 *      instead of publishing a second time.
 */
export async function publishPost(postId: string): Promise<PublishOutcome> {
  const client = await db().connect();
  try {
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok", [LOCK_NS, postId]);
    if (!lock.rows[0].ok) throw new TransientError(`post ${postId} is being published by another worker`);
    try {
      return await publishLocked(postId);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [LOCK_NS, postId]);
    }
  } finally {
    client.release();
  }
}

async function publishLocked(postId: string): Promise<PublishOutcome> {
  const post = await one<PublishRow>("SELECT * FROM posts WHERE id = $1 AND influencer_id = $2", [postId, influencerId()]);
  if (!post) return "skipped";
  if (post.status === "published" || post.ig_media_id) return "already_published";
  if (!["approved", "publishing"].includes(post.status)) return "skipped";

  const c = await getControls();
  if (c.paused) {
    // Paused is temporary: leave the post approved; the sweeper re-queues it.
    await recordEvent("info", "publish", "Publishing deferred while paused", { postId });
    return "deferred";
  }
  // An operator's explicit "Post now"/"Schedule" beats dry_run (never pause or development).
  const operator = post.publish_override === "operator" && c.mode === "dry_run";
  if (isSendingDisabled(c) && !operator) {
    await one("UPDATE posts SET status = 'dry_run', updated_at = now() WHERE id = $1", [postId]);
    await recordEvent("info", "publish", "Dry run: would publish now", { postId });
    return "dry_run";
  }

  const assets = await many<{ position: number; public_url: string; overlay: { alt_text?: string } | null }>(
    "SELECT position, public_url, overlay FROM post_assets WHERE post_id = $1 ORDER BY position",
    [postId],
  );
  if (!assets.length || assets.some((a) => !a.public_url)) throw new PermanentError(`post ${postId} has missing assets`);

  await one("UPDATE posts SET status = 'publishing', publish_attempts = publish_attempts + 1, updated_at = now() WHERE id = $1", [postId]);
  const ig = await instagramClient();
  const startedAt = new Date();

  try {
    const quota = await ig.getPublishingLimit().catch(() => undefined);
    if (quota && quota.quota_usage >= quota.quota_total) throw new TransientError(`publishing quota used (${quota.quota_usage}/${quota.quota_total})`);

    // ---- resume: a container from an earlier attempt
    if (post.ig_container_id) {
      const s = await ig.getContainerStatus(post.ig_container_id).catch((e) => {
        if (e instanceof PermanentError) return { status_code: "EXPIRED" as const };
        throw e;
      });
      if (s.status_code === "PUBLISHED") {
        const recovered = await recoverPublishedMedia(ig, post.caption, new Date(post.updated_at.getTime() - 3600_000));
        if (recovered) return markPublished(post, recovered.id, recovered.permalink);
        throw new TransientError("container reports PUBLISHED but the media is not in the feed yet");
      }
      if (s.status_code === "FINISHED" || s.status_code === "IN_PROGRESS") {
        await ig.waitForContainer(post.ig_container_id);
        const published = await ig.publishContainer(post.ig_container_id);
        return markPublished(post, published.id);
      }
      // ERROR / EXPIRED: rebuild from scratch.
      await one("UPDATE posts SET ig_container_id = NULL, ig_child_container_ids = '{}' WHERE id = $1", [postId]);
      post.ig_child_container_ids = [];
    }

    // ---- build containers
    let containerId: string;
    if (post.media_type === "IMAGE") {
      const r = await ig.createImageContainer({ imageUrl: assets[0].public_url, caption: post.caption, altText: assets[0].overlay?.alt_text, isAiGenerated: true });
      containerId = r.id;
    } else {
      const children = [...post.ig_child_container_ids];
      for (const a of assets.slice(children.length)) {
        // Meta: the AI label goes on the carousel container only; setting it on
        // a carousel item is rejected (code 100, subcode 2207100).
        const child = await ig.createImageContainer({ imageUrl: a.public_url, isCarouselItem: true, altText: a.overlay?.alt_text });
        children.push(child.id);
        await one("UPDATE posts SET ig_child_container_ids = $2 WHERE id = $1", [postId, children]);
      }
      for (const ch of children) await ig.waitForContainer(ch);
      containerId = (await ig.createCarouselContainer({ children, caption: post.caption, isAiGenerated: true })).id;
    }
    // Persist BEFORE publishing: this is what makes the next attempt safe.
    await one("UPDATE posts SET ig_container_id = $2 WHERE id = $1", [postId, containerId]);
    await ig.waitForContainer(containerId);
    const published = await ig.publishContainer(containerId);
    return markPublished(post, published.id, undefined, startedAt);
  } catch (e) {
    await one("UPDATE posts SET last_error = $2, updated_at = now() WHERE id = $1", [postId, errorMessage(e).slice(0, 1000)]);
    if (e instanceof PermanentError) {
      await one("UPDATE posts SET status = 'failed' WHERE id = $1", [postId]);
      await recordEvent("error", "publish", "Publishing failed permanently", { postId, error: errorMessage(e) });
      await notify(`❌ Publishing failed for post ${postId.slice(0, 8)}: ${errorMessage(e).slice(0, 200)}`, `/admin/posts/${postId}`);
    } else {
      await recordEvent("warn", "publish", "Publishing attempt failed; will retry", { postId, error: errorMessage(e) });
    }
    throw e;
  }
}

async function markPublished(post: PublishRow, mediaId: string, permalink?: string, startedAt?: Date): Promise<PublishOutcome> {
  let link = permalink;
  if (!link) {
    try {
      link = (await (await instagramClient()).getMedia(mediaId)).permalink;
    } catch {
      link = undefined;
    }
  }
  await one(
    `UPDATE posts SET status = 'published', ig_media_id = $2, permalink = $3, published_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
    [post.id, mediaId, link ?? null],
  );
  const idea = post.content_idea_id
    ? await one<{ topic: string; activity_id: number | null; format: string; structure: string }>(
        "SELECT topic, activity_id, format, structure FROM content_ideas WHERE id = $1",
        [post.content_idea_id],
      )
    : undefined;
  if (idea?.activity_id) await one("UPDATE activities SET decision = 'posted' WHERE id = $1", [idea.activity_id]);
  if (idea) {
    const v = applyMemoryPolicy({ kind: "published", content: `${idea.topic} (${idea.format}/${idea.structure})`, confidence: 1, importance: 0.6 });
    if (v.store) await upsertMemory("world", null, v, { type: "post", id: post.id });
  }
  for (const cp of CHECKPOINTS) {
    await queue("analytics").add(JOBS.engagementCollect, { influencerId: influencerId(), postId: post.id, checkpoint: cp.name }, { jobId: jobId("engagement", post.id, cp.name), delay: cp.delayMs });
  }
  await recordDecision({
    agent: "publisher",
    subjectType: "post",
    subjectId: post.id,
    action: "published",
    reason: `media ${mediaId}`,
    latencyMs: startedAt ? Date.now() - startedAt.getTime() : undefined,
  });
  await recordEvent("info", "publish", "Post published", { postId: post.id, mediaId, permalink: link });
  await notify(`✅ Published: ${link ?? mediaId}`);
  return "published";
}

/** Find the media a lost media_publish response created, by caption and time. */
export async function recoverPublishedMedia(ig: InstagramClient, caption: string, notBefore: Date): Promise<{ id: string; permalink?: string } | undefined> {
  const recent = await ig.listRecentMedia(10);
  const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const hit = recent.find((m) => norm(m.caption) === norm(caption) && (!m.timestamp || new Date(m.timestamp) >= notBefore));
  return hit ? { id: hit.id, permalink: hit.permalink } : undefined;
}
