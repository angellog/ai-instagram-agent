import { many } from "../db/pool.js";
import { recordEvent } from "../lib/events.js";
import { JOBS, jobId, queue } from "./queues.js";

/**
 * Platform-wide (all influencers): every re-queued job carries its owner.
 * Recovery sweep (runs every 10 minutes). Anything whose job was lost (Redis
 * flushed, worker killed past its retries, publishing deferred while paused)
 * is re-queued. Safe to over-trigger: every handler is idempotent and the
 * job ids are bucketed so one sweep cannot enqueue the same thing twice.
 */
export async function sweep(now = new Date()): Promise<Record<string, number>> {
  const bucket = Math.floor(now.getTime() / (10 * 60_000));
  const out = { interactions: 0, production: 0, publishing: 0 };

  const stuckInteractions = await many<{ id: number; influencer_id: number }>(
    `SELECT id, influencer_id FROM interactions
     WHERE status IN ('pending', 'processing') AND updated_at < now() - interval '15 minutes' AND attempts < 6
       AND occurred_at > now() - interval '7 days'
     ORDER BY id LIMIT 100`,
  );
  for (const r of stuckInteractions) {
    await queue("conversation").add(JOBS.conversationProcess, { influencerId: Number(r.influencer_id), interactionId: r.id }, { jobId: jobId("interaction", r.id, "sweep", bucket) });
    out.interactions++;
  }

  const stuckProduction = await many<{ id: string; influencer_id: number }>(
    `SELECT id, influencer_id FROM posts WHERE status IN ('draft', 'generating', 'composing') AND updated_at < now() - interval '45 minutes' LIMIT 20`,
  );
  for (const r of stuckProduction) {
    await queue("content").add(JOBS.contentProduce, { influencerId: Number(r.influencer_id), postId: r.id }, { jobId: jobId("produce", r.id, "sweep", bucket) });
    out.production++;
  }

  const duePublish = await many<{ id: string; influencer_id: number }>(
    `SELECT id, influencer_id FROM posts
     WHERE (status = 'approved' AND coalesce(scheduled_for, updated_at) < now() - interval '5 minutes')
        OR (status = 'publishing' AND updated_at < now() - interval '30 minutes')
     LIMIT 20`,
  );
  for (const r of duePublish) {
    await queue("publish").add(JOBS.postPublish, { influencerId: Number(r.influencer_id), postId: r.id }, { jobId: jobId("publish", r.id, "sweep", bucket) });
    out.publishing++;
  }

  if (out.interactions + out.production + out.publishing > 0) await recordEvent("info", "sweeper", "Re-queued stalled work", out);
  return out;
}
