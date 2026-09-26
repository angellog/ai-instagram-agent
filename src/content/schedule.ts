import { getControls } from "../config/controls.js";
import { currentInfluencer, influencerId } from "../context.js";
import { one } from "../db/pool.js";
import { recordDecision } from "../lib/decisions.js";
import { JOBS, jobId, queue } from "../queue/queues.js";

/**
 * Operator publishing: "Post now" and "Schedule for …". Both are explicit
 * human approvals, so they ignore the posting window and publish even in
 * dry_run (recorded as publish_override = 'operator'). They never override a
 * RED safety verdict, a pause, or development mode (no external writes).
 */

export const PUBLISHABLE = ["awaiting_review", "dry_run", "approved", "failed", "qc_failed"];
const MAX_AHEAD_DAYS = 60;

/** Local wall-clock time in an IANA timezone ("2026-09-27T18:30") → UTC Date. */
export function zonedToUtc(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local.trim());
  if (!m) throw new Error("use a date and time like 2026-09-27T18:30");
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t); // second pass settles DST edges
  return new Date(t);
}

/** "Sat 27 Sep, 18:30" in the influencer's timezone. */
export function localLabel(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** Remove any queued/delayed publish job for this post so a reschedule never double-posts. */
async function clearPublishJobs(postId: string): Promise<void> {
  const q = queue("publish");
  for (const j of await q.getJobs(["delayed", "waiting", "prioritized"])) {
    if (j.data?.postId === postId) await j.remove().catch(() => undefined);
  }
}

export async function operatorPublish(postId: string, when: "now" | Date, reviewer: string): Promise<{ ok: boolean; message: string; at?: Date }> {
  const tz = currentInfluencer().persona.identity.timezone;
  const post = await one<{ status: string; safety_level: string | null; ig_media_id: string | null }>(
    "SELECT status, safety_level, ig_media_id FROM posts WHERE id = $1 AND influencer_id = $2",
    [postId, influencerId()],
  );
  if (!post) return { ok: false, message: "Post not found" };
  if (post.ig_media_id || post.status === "published") return { ok: false, message: "Already published" };
  if (post.status === "publishing") return { ok: false, message: "Publishing is already in progress" };
  if (!PUBLISHABLE.includes(post.status)) return { ok: false, message: `A ${post.status} post can't be published` };
  if (post.safety_level === "red") return { ok: false, message: "RED posts are never published" };
  const slides = await one<{ n: number; missing: number }>(
    "SELECT count(*)::int AS n, count(*) FILTER (WHERE public_url IS NULL)::int AS missing FROM post_assets WHERE post_id = $1",
    [postId],
  );
  if (!slides?.n || slides.missing) return { ok: false, message: "This post has no finished images yet: use Retry production first" };
  const c = await getControls();
  if (c.mode === "development") return { ok: false, message: "Development mode makes no external writes; switch mode in Controls" };

  const now = new Date();
  if (when !== "now" && when.getTime() < now.getTime() - 60_000) return { ok: false, message: "That time has already passed: pick a future time, or use Post now" };
  const at = when === "now" || when.getTime() <= now.getTime() + 60_000 ? now : when;
  if (at.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86_400_000) return { ok: false, message: `Schedule within ${MAX_AHEAD_DAYS} days` };

  await one("UPDATE safety_reviews SET status = 'approved', reviewer = $2, reviewed_at = now() WHERE subject_type = 'post' AND subject_id = $1 AND status = 'pending'", [postId, reviewer]);
  await one(
    `UPDATE posts SET status = 'approved', reviewed_by = $2, reviewed_at = now(), scheduled_for = $3, publish_override = 'operator', last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [postId, reviewer, at],
  );
  await clearPublishJobs(postId);
  await queue("publish").add(
    JOBS.postPublish,
    { influencerId: influencerId(), postId },
    { jobId: jobId("publish", postId, "op", at.getTime()), delay: Math.max(0, at.getTime() - now.getTime()) },
  );
  const label = at === now ? "now" : localLabel(at, tz);
  await recordDecision({ agent: "human_reviewer", subjectType: "post", subjectId: postId, action: at === now ? "post_now" : "schedule", reason: `${reviewer}; ${label}` });
  const paused = c.paused ? " (the influencer is paused: it goes out when you resume)" : "";
  return { ok: true, message: at === now ? `Posting now${paused}` : `Scheduled for ${label} (${tz})${paused}`, at };
}

export async function cancelSchedule(postId: string, reviewer: string): Promise<{ ok: boolean; message: string }> {
  const r = await one<{ id: string }>(
    `UPDATE posts SET status = 'awaiting_review', scheduled_for = NULL, publish_override = NULL, updated_at = now()
     WHERE id = $1 AND influencer_id = $2 AND status = 'approved' AND ig_media_id IS NULL RETURNING id`,
    [postId, influencerId()],
  );
  if (!r) return { ok: false, message: "Only a scheduled post can be unscheduled" };
  await clearPublishJobs(postId);
  await recordDecision({ agent: "human_reviewer", subjectType: "post", subjectId: postId, action: "unschedule", reason: reviewer });
  return { ok: true, message: "Unscheduled; the post is back in review" };
}
