import { influencerId } from "../context.js";
import { one } from "../db/pool.js";
import { instagramClient } from "../instagram/accounts.js";
import { errorMessage, PermanentError, RateLimitedError, TransientError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import type { InteractionRow } from "./context.js";

export type ReplyChannel = "public_reply" | "private_reply" | "dm";

export const DM_WINDOW_MS = 24 * 3600 * 1000;
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;

/** Meta's messaging windows (docs/RESEARCH.md §2). */
export function windowOpen(it: Pick<InteractionRow, "kind" | "occurred_at">, channel: ReplyChannel, now = Date.now()): boolean {
  const age = now - new Date(it.occurred_at).getTime();
  if (channel === "dm") return age <= DM_WINDOW_MS - 60_000;
  if (channel === "private_reply") return age <= PRIVATE_REPLY_WINDOW_MS - 60_000;
  return true;
}

export async function outboundCountLastHour(kind: "comments" | "dms"): Promise<number> {
  const channels = kind === "dms" ? ["dm"] : ["public_reply", "private_reply"];
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE influencer_id = $2 AND direction = 'out' AND channel = ANY($1)
     AND status IN ('sent','sending') AND created_at > now() - interval '1 hour'`,
    [channels, influencerId()],
  );
  return r?.n ?? 0;
}

/**
 * Reserve the outbound slot for (interaction, channel). The unique index
 * `messages_one_reply_per_channel` makes this the idempotency point: a retried
 * job finds the existing row instead of sending twice.
 */
export async function reserveOutbound(o: {
  conversationId: number;
  interactionId: number;
  channel: ReplyChannel;
  text: string;
  status: "sending" | "pending_review" | "dry_run" | "blocked";
  decisionId?: number;
}): Promise<{ id: number; status: string; created: boolean }> {
  const inserted = await one<{ id: number; status: string }>(
    `INSERT INTO messages (influencer_id, conversation_id, interaction_id, direction, channel, text, status, decision_id)
     VALUES ($7,$1,$2,'out',$3,$4,$5,$6)
     ON CONFLICT (interaction_id, channel) WHERE direction = 'out' DO NOTHING
     RETURNING id, status`,
    [o.conversationId, o.interactionId, o.channel, o.text, o.status, o.decisionId ?? null, influencerId()],
  );
  if (inserted) return { ...inserted, created: true };
  const existing = await one<{ id: number; status: string }>(
    "SELECT id, status FROM messages WHERE interaction_id = $1 AND channel = $2 AND direction = 'out'",
    [o.interactionId, o.channel],
  );
  return { ...existing!, created: false };
}

/**
 * Actually deliver a reserved outbound message. Only rows in `sending` state
 * are delivered. A row still in `sending` from an earlier crashed attempt has
 * an unknown outcome; it is marked failed instead of re-sent, because a
 * duplicate public reply is worse than a missing one.
 */
export async function deliver(messageId: number, it: InteractionRow, opts: { freshReservation: boolean }): Promise<{ status: "sent" | "failed" | "skipped"; igId?: string; error?: string }> {
  const msg = await one<{ id: number; channel: ReplyChannel; text: string; status: string; conversation_id: number }>(
    "SELECT id, channel, text, status, conversation_id FROM messages WHERE id = $1",
    [messageId],
  );
  if (!msg) throw new PermanentError(`message ${messageId} not found`);
  if (msg.status === "sent") return { status: "skipped" };
  if (msg.status !== "sending") return { status: "skipped" };
  if (!opts.freshReservation) {
    await one("UPDATE messages SET status = 'failed', error = $2 WHERE id = $1", [messageId, "unknown outcome after a crashed attempt; not re-sent"]);
    await recordEvent("warn", "conversation", "Outbound message had unknown outcome; not re-sent", { messageId });
    return { status: "failed", error: "unknown outcome" };
  }
  if (!windowOpen(it, msg.channel)) {
    await one("UPDATE messages SET status = 'failed', error = 'messaging window closed' WHERE id = $1", [messageId]);
    return { status: "failed", error: "window closed" };
  }
  try {
    const ig = await instagramClient();
    let igId: string;
    if (msg.channel === "public_reply") igId = (await ig.replyToComment(it.ig_object_id, msg.text)).id;
    else if (msg.channel === "private_reply") igId = (await ig.sendPrivateReply(it.ig_object_id, msg.text)).message_id;
    else igId = (await ig.sendDirectMessage(it.sender_ig_id, msg.text)).message_id;
    await one("UPDATE messages SET status = 'sent', ig_object_id = $2, error = NULL WHERE id = $1", [messageId, igId]);
    await one("UPDATE conversations SET last_outbound_at = now(), message_count = message_count + 1 WHERE id = $1", [msg.conversation_id]);
    return { status: "sent", igId };
  } catch (e) {
    if (definitelyNotDelivered(e)) {
      // Meta answered with a rate-limit / server error: nothing was sent, so a
      // retry is safe. The marker lets the next attempt re-arm this row.
      await one("UPDATE messages SET status = 'failed', error = $2 WHERE id = $1", [messageId, `${RETRYABLE}${errorMessage(e)}`.slice(0, 500)]);
      throw e;
    }
    // Anything else (auth, validation, or a network error with unknown outcome)
    // is final for this message.
    await one("UPDATE messages SET status = 'failed', error = $2 WHERE id = $1", [messageId, errorMessage(e).slice(0, 500)]);
    await recordEvent("error", "conversation", "Instagram send failed", { messageId, channel: msg.channel, error: errorMessage(e) });
    return { status: "failed", error: errorMessage(e) };
  }
}

export const RETRYABLE = "retryable: ";

/** True when Meta responded with an error, i.e. the message cannot have gone out. */
export function definitelyNotDelivered(e: unknown): boolean {
  if (e instanceof RateLimitedError) return true;
  return e instanceof TransientError && /\[code=/.test(e.message);
}

/** Re-arm a row that failed with a retryable error so it can be delivered again. */
export async function rearmIfRetryable(messageId: number): Promise<boolean> {
  const r = await one<{ id: number }>(
    `UPDATE messages SET status = 'sending', error = NULL WHERE id = $1 AND status = 'failed' AND error LIKE '${RETRYABLE}%' RETURNING id`,
    [messageId],
  );
  return Boolean(r);
}
