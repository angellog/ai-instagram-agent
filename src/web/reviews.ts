import { getControls } from "../config/controls.js";
import { many, one } from "../db/pool.js";
import { sendApprovedReply } from "../conversation/agent.js";
import { schedulePublish } from "../content/produce.js";
import { recordDecision } from "../lib/decisions.js";
import { recordEvent } from "../lib/events.js";
import { persona } from "../persona/loader.js";
import { assessText } from "../safety/safety.js";

export interface ReviewRow {
  id: number;
  subject_type: "reply" | "post";
  subject_id: string;
  level: "green" | "yellow" | "red";
  categories: string[];
  reason: string | null;
  proposed: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "expired";
  reviewer: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}

export function listReviews(status: ReviewRow["status"] | "all" = "pending", limit = 100): Promise<ReviewRow[]> {
  return many<ReviewRow>(
    `SELECT * FROM safety_reviews WHERE ($1 = 'all' OR status = $1) ORDER BY created_at DESC LIMIT $2`,
    [status, limit],
  );
}

/**
 * Human approval (brief §12 YELLOW, §27 human-approval mode). Approving a
 * reply sends it through the same idempotent path the agent uses; approving a
 * post schedules it for the next posting window. RED items cannot be approved.
 */
export async function approveReview(id: number, reviewer: string, editedText?: string): Promise<{ ok: boolean; message: string }> {
  const r = await one<ReviewRow>("SELECT * FROM safety_reviews WHERE id = $1", [id]);
  if (!r) return { ok: false, message: "review not found" };
  if (r.status !== "pending") return { ok: false, message: `review is ${r.status}` };
  if (r.level === "red") return { ok: false, message: "RED items are never automated; handle them manually in Instagram" };

  if (r.subject_type === "reply") {
    const messageId = Number(r.subject_id.replace(/^message-/, ""));
    if (!Number.isFinite(messageId)) return { ok: false, message: "review has no message attached" };
    const res = await sendApprovedReply(messageId, editedText?.trim() || undefined);
    if (!["sent", "dry_run"].includes(res.status)) return { ok: false, message: `send ${res.status}${res.error ? `: ${res.error}` : ""}` };
    await one("UPDATE safety_reviews SET status = 'approved', reviewer = $2, reviewed_at = now() WHERE id = $1", [id, reviewer]);
    await recordDecision({ agent: "human_reviewer", subjectType: "interaction", subjectId: String(r.proposed.interactionId ?? r.subject_id), action: `approve_reply:${res.status}`, reason: reviewer });
    return { ok: true, message: res.status === "sent" ? "Reply sent" : "Recorded (dry run: nothing sent)" };
  }

  const post = await one<{ id: string; status: string; caption: string }>("SELECT id, status, caption FROM posts WHERE id = $1", [r.subject_id]);
  if (!post) return { ok: false, message: "post not found" };
  if (!["awaiting_review", "dry_run"].includes(post.status)) return { ok: false, message: `post is ${post.status}` };
  if (editedText?.trim()) {
    const a = await assessText(editedText, { direction: "outbound", skipLlm: true });
    if (a.level === "red") return { ok: false, message: `edited caption is red: ${a.categories.join(", ")}` };
    await one("UPDATE posts SET caption = $2 WHERE id = $1", [post.id, editedText.trim()]);
  }
  await one("UPDATE posts SET status = 'approved', reviewed_by = $2, reviewed_at = now(), updated_at = now() WHERE id = $1", [post.id, reviewer]);
  await one("UPDATE safety_reviews SET status = 'approved', reviewer = $2, reviewed_at = now() WHERE id = $1", [id, reviewer]);
  const at = await schedulePublish(post.id, await getControls(), persona());
  await recordDecision({ agent: "human_reviewer", subjectType: "post", subjectId: post.id, action: "approve_post", reason: `${reviewer}; publish at ${at.toISOString()}` });
  return { ok: true, message: `Approved; publishing ${at.getTime() <= Date.now() + 60_000 ? "now" : `at ${at.toISOString()}`}` };
}

export async function rejectReview(id: number, reviewer: string, note?: string): Promise<{ ok: boolean; message: string }> {
  const r = await one<ReviewRow>("SELECT * FROM safety_reviews WHERE id = $1", [id]);
  if (!r) return { ok: false, message: "review not found" };
  if (r.status !== "pending") return { ok: false, message: `review is ${r.status}` };
  await one("UPDATE safety_reviews SET status = 'rejected', reviewer = $2, reviewed_at = now(), reason = coalesce($3, reason) WHERE id = $1", [id, reviewer, note ?? null]);
  if (r.subject_type === "reply") {
    const messageId = Number(r.subject_id.replace(/^message-/, ""));
    if (Number.isFinite(messageId)) await one("UPDATE messages SET status = 'rejected' WHERE id = $1 AND status = 'pending_review'", [messageId]);
  } else {
    await one("UPDATE posts SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), last_error = $3, updated_at = now() WHERE id = $1", [
      r.subject_id,
      reviewer,
      note ?? "rejected by reviewer",
    ]);
  }
  await recordDecision({ agent: "human_reviewer", subjectType: r.subject_type === "post" ? "post" : "interaction", subjectId: r.subject_id, action: "reject", reason: note ?? reviewer });
  return { ok: true, message: "Rejected" };
}

/**
 * Reply drafts are only useful inside Meta's windows: a DM draft dies with the
 * 24h window, a stale public reply looks odd after a few days.
 */
export async function expireReviews(): Promise<number> {
  const rows = await many<{ id: number; message_id: number }>(
    `SELECT r.id, m.id AS message_id FROM safety_reviews r
     JOIN messages m ON r.subject_id = 'message-' || m.id
     JOIN interactions i ON i.id = m.interaction_id
     WHERE r.status = 'pending' AND r.subject_type = 'reply' AND (
       (m.channel = 'dm' AND i.occurred_at < now() - interval '23 hours') OR
       (m.channel = 'private_reply' AND i.occurred_at < now() - interval '6 days 20 hours') OR
       (m.channel = 'public_reply' AND i.occurred_at < now() - interval '3 days'))`,
  );
  for (const r of rows) {
    await one("UPDATE safety_reviews SET status = 'expired', reviewed_at = now(), reviewer = 'system' WHERE id = $1", [r.id]);
    await one("UPDATE messages SET status = 'rejected', error = 'review expired (messaging window closed)' WHERE id = $1 AND status = 'pending_review'", [r.message_id]);
  }
  if (rows.length) await recordEvent("info", "reviews", "Expired stale reply reviews", { count: rows.length });
  return rows.length;
}
