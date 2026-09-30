import { env } from "../config/env.js";
import { many } from "../db/pool.js";
import { recordEvent } from "../lib/events.js";
import { logger } from "../lib/logger.js";
import { notify } from "../notify/telegram.js";
import { JOBS, jobId, queue, redis } from "../queue/queues.js";

/**
 * Out-of-credit state per brain ("claude" | "openai"), shared by web and worker
 * through Redis. Set by the first call the provider refuses for billing; cleared
 * by the first call that succeeds again, which also re-queues the comments and
 * DMs that failed while the account was empty (last 24 hours).
 */
export type Brain = "claude" | "openai";
export interface BillingBlock {
  brain: Brain;
  since: string;
  message: string;
}

const key = () => `${env().QUEUE_PREFIX}:llm-billing`;
/** Marker the worker writes into a failed interaction's last_error, and legacy raw Anthropic text. */
const HELD = ["%LLM out of credit%", "%credit balance is too low%", "%insufficient_quota%"];

export async function markBillingBlocked(brain: Brain, message: string): Promise<void> {
  try {
    const fresh = await redis().hsetnx(key(), brain, JSON.stringify({ brain, since: new Date().toISOString(), message } satisfies BillingBlock));
    if (fresh) {
      await recordEvent("error", "llm", message, { brain });
      await notify(`🚫 ${message} Posts, stories and replies on ${brain === "openai" ? "OpenAI" : "Claude"} are stopped until then.`, "/admin/events").catch(() => undefined);
    }
  } catch (e) {
    logger.warn({ err: e }, "could not record LLM billing block");
  }
}

/** Clear a block after a successful call; returns how many held conversations were re-queued. */
export async function clearBillingBlock(brain: Brain): Promise<number> {
  let removed = 0;
  try {
    removed = await redis().hdel(key(), brain);
  } catch {
    return 0;
  }
  if (!removed) return 0;
  const held = await many<{ id: number; influencer_id: number }>(
    `UPDATE interactions SET status = 'pending', last_error = NULL, updated_at = now()
     WHERE status = 'failed' AND created_at > now() - interval '24 hours' AND (last_error LIKE $1 OR last_error LIKE $2 OR last_error LIKE $3)
     RETURNING id, influencer_id`,
    HELD,
  );
  for (const h of held) {
    await queue("conversation").add(JOBS.conversationProcess, { influencerId: h.influencer_id, interactionId: h.id }, { jobId: jobId("interaction", h.id, "credit", Date.now()) });
  }
  await recordEvent("info", "llm", `${brain === "openai" ? "OpenAI" : "Claude"} is answering again${held.length ? `: ${held.length} held conversation(s) re-queued` : ""}`, { brain, requeued: held.map((h) => h.id) });
  return held.length;
}

export async function billingBlocks(): Promise<BillingBlock[]> {
  try {
    const all = await redis().hgetall(key());
    return Object.values(all).map((v) => JSON.parse(v) as BillingBlock);
  } catch {
    return [];
  }
}
