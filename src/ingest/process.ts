import { one } from "../db/pool.js";
import { primaryAccount } from "../instagram/accounts.js";
import { recordEvent } from "../lib/events.js";
import { JOBS, jobId, queue } from "../queue/queues.js";
import { normalizeWebhook, type NormalizedInteraction } from "./webhook.js";

/**
 * `instagram.event` job: turn one stored webhook body into interaction rows
 * and one `conversation.process` job each. Both steps are idempotent: the
 * interaction has a unique (kind, ig_object_id) and the job id is derived from
 * the interaction id, so duplicate webhooks and job retries cannot double-reply.
 */
export async function processWebhookEvent(webhookEventId: number): Promise<{ queued: number; skipped: number }> {
  const row = await one<{ payload: unknown }>("SELECT payload FROM webhook_events WHERE id = $1", [webhookEventId]);
  if (!row) return { queued: 0, skipped: 0 };
  const interactions = normalizeWebhook(row.payload);
  const acct = await primaryAccount();

  let queued = 0;
  let skipped = 0;
  for (const it of interactions) {
    // Only the persona's own account. OpenReply may serve several accounts.
    if (acct && it.igAccountId !== acct.ig_user_id) {
      skipped++;
      continue;
    }
    const id = await insertInteraction(webhookEventId, it);
    if (id === undefined) {
      skipped++;
      continue;
    }
    await queue("conversation").add(JOBS.conversationProcess, { interactionId: id }, { jobId: jobId("interaction", id) });
    queued++;
  }

  await one("UPDATE webhook_events SET status = $2, event_count = $3 WHERE id = $1", [
    webhookEventId,
    queued > 0 ? "queued" : "ignored",
    interactions.length,
  ]);
  if (interactions.length && !queued) {
    await recordEvent("debug", "ingest", "Webhook produced no new interactions", { webhookEventId, skipped });
  }
  return { queued, skipped };
}

export async function insertInteraction(webhookEventId: number | null, it: NormalizedInteraction): Promise<number | undefined> {
  const r = await one<{ id: number }>(
    `INSERT INTO interactions (webhook_event_id, kind, ig_object_id, ig_account_id, sender_ig_id, sender_username, text, media_id, parent_comment_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (kind, ig_object_id) DO NOTHING RETURNING id`,
    [
      webhookEventId,
      it.kind,
      it.igObjectId,
      it.igAccountId,
      it.senderIgId,
      it.senderUsername ?? null,
      it.text,
      it.mediaId ?? null,
      it.parentCommentId ?? null,
      it.occurredAt,
    ],
  );
  return r?.id;
}
