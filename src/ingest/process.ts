import { one } from "../db/pool.js";
import { influencerForIgAccount } from "../instagram/accounts.js";
import { recordEvent } from "../lib/events.js";
import { JOBS, jobId, queue } from "../queue/queues.js";
import { normalizeWebhook, type NormalizedInteraction } from "./webhook.js";

/**
 * `instagram.event` job: turn one stored webhook body into interaction rows
 * and one `conversation.process` job each, routed to the influencer that owns
 * the Instagram account the event belongs to. Events for accounts no
 * influencer owns are dropped (OpenReply may relay several accounts).
 *
 * Idempotent: interactions are unique on (kind, ig_object_id) and job ids are
 * derived from the interaction id, so duplicate webhooks cannot double-reply.
 */
export async function processWebhookEvent(webhookEventId: number): Promise<{ queued: number; skipped: number }> {
  const row = await one<{ payload: unknown }>("SELECT payload FROM webhook_events WHERE id = $1", [webhookEventId]);
  if (!row) return { queued: 0, skipped: 0 };
  const interactions = normalizeWebhook(row.payload);

  let queued = 0;
  let skipped = 0;
  const owners = new Set<number>();
  const cache = new Map<string, number | undefined>();
  for (const it of interactions) {
    if (!cache.has(it.igAccountId)) cache.set(it.igAccountId, await influencerForIgAccount(it.igAccountId));
    const influencerId = cache.get(it.igAccountId);
    if (influencerId === undefined) {
      skipped++;
      continue;
    }
    const status = await one<{ status: string }>("SELECT status FROM influencers WHERE id = $1", [influencerId]);
    if (status?.status === "archived") {
      skipped++;
      continue;
    }
    const id = await insertInteraction(webhookEventId, influencerId, it);
    if (id === undefined) {
      skipped++;
      continue;
    }
    owners.add(influencerId);
    await queue("conversation").add(JOBS.conversationProcess, { influencerId, interactionId: id }, { jobId: jobId("interaction", id) });
    queued++;
  }

  await one("UPDATE webhook_events SET status = $2, event_count = $3, influencer_ids = $4 WHERE id = $1", [
    webhookEventId,
    queued > 0 ? "queued" : "ignored",
    interactions.length,
    [...owners],
  ]);
  if (interactions.length && !queued) {
    await recordEvent("debug", "ingest", "Webhook produced no new interactions", { webhookEventId, skipped });
  }
  return { queued, skipped };
}

export async function insertInteraction(webhookEventId: number | null, influencerId: number, it: NormalizedInteraction): Promise<number | undefined> {
  const r = await one<{ id: number }>(
    `INSERT INTO interactions (webhook_event_id, influencer_id, kind, ig_object_id, ig_account_id, sender_ig_id, sender_username, text, media_id, parent_comment_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (kind, ig_object_id) DO NOTHING RETURNING id`,
    [
      webhookEventId,
      influencerId,
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
