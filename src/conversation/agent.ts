import { createHash } from "node:crypto";
import { deferKeywords } from "../config/env.js";
import { getControls, type Controls } from "../config/controls.js";
import { one } from "../db/pool.js";
import { instagramClient } from "../instagram/accounts.js";
import { recordDecision } from "../lib/decisions.js";
import { errorMessage } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { containsKeyword, isLowContent, truncate } from "../lib/text.js";
import { llm } from "../llm/llm.js";
import { persona } from "../persona/loader.js";
import { personaSystemBlock } from "../persona/prompt.js";
import { applyMemoryPolicy } from "../memory/policy.js";
import { upsertMemory } from "../memory/store.js";
import { notify } from "../notify/telegram.js";
import { JOBS, jobId, queue } from "../queue/queues.js";
import { evaluateRules, levelOf } from "../safety/rules.js";
import { assessText, gate, openReview } from "../safety/safety.js";
import {
  buildContext,
  recordInbound,
  renderContext,
  upsertConversation,
  upsertUser,
  type InteractionRow,
} from "./context.js";
import {
  decisionSchema,
  decisionSystem,
  PERCEPTION_SYSTEM,
  perceptionSchema,
  type Decision,
  type Perception,
} from "./prompts.js";
import { deliver, outboundCountLastHour, rearmIfRetryable, reserveOutbound, windowOpen, type ReplyChannel } from "./send.js";

export type ConversationOutcome =
  | "replied"
  | "dry_run"
  | "pending_review"
  | "ignored"
  | "escalated"
  | "blocked"
  | "hidden"
  | "throttled"
  | "failed"
  | "already_done";

const SPAM_PATTERNS = [
  /\b(dm|message) (us|me) (for|to) (collab|promo|promotion|feature)\b/i,
  /\bpromote (it|your page) on\b/i,
  /\b(follow ?4 ?follow|f4f|l4l|sub4sub)\b/i,
  /\b(bitcoin|crypto|forex) (profit|trading|signals?)\b/i,
  /https?:\/\/\S+/i,
];

/**
 * The conversation agent (brief §2, §4). Pipeline:
 *   event → perception → user/conversation lookup → memory + post + knowledge
 *   retrieval → intent classification → reasoning + action selection →
 *   safety validation → execute → memory update → log.
 */
export async function processInteraction(interactionId: number): Promise<ConversationOutcome> {
  const started = Date.now();
  const it = await one<InteractionRow>("SELECT * FROM interactions WHERE id = $1", [interactionId]);
  if (!it) return "already_done";
  if (["done", "ignored", "escalated"].includes(it.status)) return "already_done";
  await one("UPDATE interactions SET status = 'processing', attempts = attempts + 1, updated_at = now() WHERE id = $1", [it.id]);

  const c = await getControls();
  const user = await upsertUserOnce(it);
  const conversationId = await upsertConversation(it, user.id);
  await recordInbound(conversationId, it);

  const finish = async (status: "done" | "ignored" | "escalated" | "failed", outcome: ConversationOutcome, extra: Record<string, unknown> = {}) => {
    await one("UPDATE interactions SET status = $2, last_error = $3, updated_at = now() WHERE id = $1", [
      it.id,
      status,
      (extra.error as string | undefined) ?? null,
    ]);
    return outcome;
  };

  // ---------------------------------------------------------- perception
  const pre = perceive(it, user.trust, c);
  if (pre.skip) {
    await recordDecision({
      agent: "conversation_agent",
      subjectType: "interaction",
      subjectId: it.id,
      action: "ignore",
      reason: pre.reason,
      contextUsed: [],
      latencyMs: Date.now() - started,
    });
    await enqueueMemory(it.id, pre.rememberAnyway);
    return finish("ignored", pre.outcome ?? "ignored");
  }

  // Inbound safety (rules only; cheap). Abuse is never engaged with.
  const inboundHits = evaluateRules(it.text, { direction: "inbound" });
  const inboundLevel = levelOf(inboundHits);
  if (inboundLevel === "red") {
    const hide = it.kind === "comment" && inboundHits.some((h) => ["harassment", "sexual", "violence"].includes(h.category));
    let hidden = false;
    if (hide && c.mode === "autonomous" && !c.paused) {
      try {
        await (await instagramClient()).hideComment(it.ig_object_id, true);
        hidden = true;
      } catch (e) {
        await recordEvent("warn", "conversation", "Failed to hide abusive comment", { interactionId: it.id, error: errorMessage(e) });
      }
    }
    await recordDecision({
      agent: "conversation_agent",
      subjectType: "interaction",
      subjectId: it.id,
      action: hidden ? "hide" : "ignore",
      safetyLevel: "red",
      reason: `inbound red: ${inboundHits.map((h) => h.category).join(", ")}`,
      latencyMs: Date.now() - started,
    });
    await openReview({
      subjectType: "reply",
      subjectId: `interaction-${it.id}`,
      assessment: { level: "red", categories: inboundHits.map((h) => h.category), reason: "abusive or unsafe inbound message" },
      proposed: { interactionId: it.id, text: "", note: hidden ? "comment hidden automatically" : "not engaged" },
      status: "rejected",
    });
    return finish("ignored", hidden ? "hidden" : "blocked");
  }

  // ---------------------------------------------------------- context
  const ctx = await buildContext(it, user, conversationId);
  const p = persona();

  // ---------------------------------------------------------- intent
  const perception: Perception = await llm().structured(perceptionSchema, {
    operation: "conversation.classify",
    tier: "fast",
    maxTokens: 250,
    ref: { type: "interaction", id: String(it.id) },
    system: PERCEPTION_SYSTEM,
    prompt: `Kind: ${it.kind}\nMessage: """${it.text}"""`,
  });

  if (perception.intent === "spam" && perception.confidence >= 0.7) {
    await recordDecision({
      agent: "conversation_agent",
      subjectType: "interaction",
      subjectId: it.id,
      intent: perception.intent,
      action: "ignore",
      confidence: perception.confidence,
      reason: "classified as spam",
      latencyMs: Date.now() - started,
    });
    return finish("ignored", "ignored");
  }

  // ---------------------------------------------------------- reasoning + action selection
  const decision: Decision = await llm().structured(decisionSchema, {
    operation: "conversation.decide",
    tier: "smart",
    maxTokens: 700,
    temperature: 0.7,
    ref: { type: "interaction", id: String(it.id) },
    system: decisionSystem(personaSystemBlock(p), p.communication_style.max_reply_chars),
    prompt: `${renderContext(it, ctx)}\n\nCLASSIFIER: intent=${perception.intent} sentiment=${perception.sentiment} question=${perception.is_question}`,
  });

  // Never trust ids the model cites: keep only memories/knowledge it was shown.
  const shownMemoryIds = new Set(ctx.memories.map((m) => m.id));
  const shownKnowledgeIds = new Set(ctx.knowledge.map((k) => k.id));
  const fabricatedRefs = decision.used_memory_ids.filter((id) => !shownMemoryIds.has(id));
  decision.used_memory_ids = decision.used_memory_ids.filter((id) => shownMemoryIds.has(id));
  decision.used_knowledge_ids = decision.used_knowledge_ids.filter((id) => shownKnowledgeIds.has(id));

  if (decision.workflow === "content_request" && decision.content_request_topic) {
    const v = applyMemoryPolicy({ kind: "content_request", content: decision.content_request_topic, confidence: 0.8, importance: 0.6 });
    if (v.store) await upsertMemory("world", null, v, { type: "message", id: String(it.id) });
  }

  const channel = resolveChannel(it, decision);
  let action = decision.action;
  let text = truncate(decision.response.trim(), p.communication_style.max_reply_chars);

  // Not every comment deserves a reply (brief §28).
  if ((action === "reply" || action === "ask_clarifying") && decision.reply_value === "low") action = "ignore";
  if (action === "reply" && decision.reply_value === "worthwhile" && !sampled(it.id, c.optional_reply_rate) && it.kind !== "dm") {
    action = "ignore";
  }
  if ((action === "reply" || action === "ask_clarifying" || action === "escalate") && !text) action = action === "escalate" ? "escalate" : "ignore";

  const decisionBase = {
    agent: "conversation_agent",
    subjectType: "interaction" as const,
    subjectId: it.id,
    intent: perception.intent,
    confidence: decision.confidence,
    contextUsed: [
      ...ctx.contextUsed.filter((x) => x !== "user_memory" || decision.used_memory_ids.length),
      ...(decision.used_knowledge_ids.length ? ["business_knowledge"] : []),
    ],
    output: {
      channel,
      reply_value: decision.reply_value,
      used_memory_ids: decision.used_memory_ids,
      used_knowledge_ids: decision.used_knowledge_ids,
      fabricated_memory_refs_dropped: fabricatedRefs,
      workflow: decision.workflow,
    },
  };

  if (action === "ignore") {
    await recordDecision({ ...decisionBase, action: "ignore", reason: decision.reason, latencyMs: Date.now() - started });
    await enqueueMemory(it.id, true);
    return finish("ignored", "ignored");
  }

  if (action === "hide") {
    let hidden = false;
    if (it.kind === "comment" && c.mode === "autonomous" && !c.paused) {
      try {
        await (await instagramClient()).hideComment(it.ig_object_id, true);
        hidden = true;
      } catch (e) {
        await recordEvent("warn", "conversation", "Failed to hide comment", { interactionId: it.id, error: errorMessage(e) });
      }
    }
    await recordDecision({ ...decisionBase, action: hidden ? "hide" : "ignore", reason: decision.reason, latencyMs: Date.now() - started });
    return finish("ignored", hidden ? "hidden" : "ignored");
  }

  // ---------------------------------------------------------- throttles & windows
  const kind = channel === "dm" ? "dms" : "comments";
  const limit = kind === "dms" ? c.max_dms_per_hour : c.max_comment_replies_per_hour;
  if ((await outboundCountLastHour(kind)) >= limit) {
    await recordDecision({ ...decisionBase, action: "throttled", reason: `hourly ${kind} limit ${limit} reached`, latencyMs: Date.now() - started });
    await recordEvent("warn", "conversation", "Hourly reply limit reached", { kind, limit });
    return finish("ignored", "throttled");
  }
  if (!windowOpen(it, channel)) {
    await recordDecision({ ...decisionBase, action: "ignore", reason: "messaging window closed", latencyMs: Date.now() - started });
    return finish("ignored", "ignored");
  }

  // ---------------------------------------------------------- safety validation
  const assessment = await assessText(text, {
    direction: "outbound",
    context: `Reply to ${it.kind}: "${truncate(it.text, 300)}"`,
    ref: { type: "interaction", id: String(it.id) },
  });
  // Escalations always go to a human, whatever the safety level of the draft.
  let outcome = action === "escalate" ? (assessment.level === "red" ? "block" : "review") : gate(assessment.level, c);
  // Simulated interactions (admin "simulate", e2e tests) never reach Instagram.
  if (outcome === "send" && isSimulated(it)) outcome = "dry_run";
  const decisionId = await recordDecision({
    ...decisionBase,
    action: `${action}:${outcome}`,
    safetyLevel: assessment.level,
    reason: decision.reason,
    output: { ...decisionBase.output, safety: { categories: assessment.categories, reason: assessment.reason } },
    latencyMs: Date.now() - started,
  });

  // ---------------------------------------------------------- execute
  if (outcome === "block") {
    await reserveOutbound({ conversationId, interactionId: it.id, channel, text, status: "blocked", decisionId });
    await openReview({ subjectType: "reply", subjectId: `interaction-${it.id}`, assessment, proposed: { interactionId: it.id, channel, text }, status: "rejected" });
    await enqueueMemory(it.id, true);
    return finish("ignored", "blocked");
  }

  if (outcome === "review") {
    const slot = await reserveOutbound({ conversationId, interactionId: it.id, channel, text, status: "pending_review", decisionId });
    await openReview({
      subjectType: "reply",
      subjectId: `message-${slot.id}`,
      assessment: action === "escalate" ? { ...assessment, categories: ["escalation", ...assessment.categories] } : assessment,
      proposed: { interactionId: it.id, messageId: slot.id, channel, text, inbound: it.text, username: user.username },
    });
    if (slot.created) {
      await notify(
        `${action === "escalate" ? "🙋 Escalation" : "📝 Reply awaiting review"} (${assessment.level})\n@${user.username ?? "someone"}: ${truncate(it.text, 200)}\nDraft: ${truncate(text, 280)}`,
        "/admin/reviews",
      );
    }
    await enqueueMemory(it.id, true);
    return finish(action === "escalate" ? "escalated" : "done", action === "escalate" ? "escalated" : "pending_review");
  }

  if (outcome === "dry_run") {
    await reserveOutbound({ conversationId, interactionId: it.id, channel, text, status: "dry_run", decisionId });
    await enqueueMemory(it.id, true);
    return finish("done", "dry_run");
  }

  const slot = await reserveOutbound({ conversationId, interactionId: it.id, channel, text, status: "sending", decisionId });
  let fresh = slot.created;
  if (!slot.created && slot.status === "failed") fresh = await rearmIfRetryable(slot.id);
  const sent = await deliver(slot.id, it, { freshReservation: fresh || slot.status === "sent" });
  await enqueueMemory(it.id, true);
  if (sent.status === "failed") return finish("failed", "failed", { error: sent.error });
  return finish("done", "replied");
}

/** Deterministic pre-LLM filters: things that never need a model call. */
export function perceive(
  it: Pick<InteractionRow, "text" | "kind">,
  trust: string,
  c: Controls,
): { skip: false } | { skip: true; reason: string; outcome?: ConversationOutcome; rememberAnyway: boolean } {
  if (!c.conversation_enabled || c.paused) return { skip: true, reason: "conversation disabled or paused", rememberAnyway: false };
  if (trust === "blocked" || trust === "muted") return { skip: true, reason: `user is ${trust}`, rememberAnyway: false };
  if (it.kind === "story_mention") return { skip: true, reason: "story mention (no reply API for mentions)", rememberAnyway: false };
  const defer = deferKeywords();
  if (defer.some((k) => containsKeyword(it.text, k))) {
    return { skip: true, reason: "keyword handled by an OpenReply campaign", rememberAnyway: false };
  }
  if (!it.text.trim() || isLowContent(it.text)) {
    return { skip: true, reason: "no words (emoji/tag/attachment only)", rememberAnyway: false };
  }
  if (SPAM_PATTERNS.some((re) => re.test(it.text))) return { skip: true, reason: "spam pattern", rememberAnyway: false };
  return { skip: false };
}

function resolveChannel(it: InteractionRow, d: Decision): ReplyChannel {
  if (it.kind === "dm" || it.kind === "story_reply") return "dm";
  return d.channel === "private" ? "private_reply" : "public_reply";
}

export function isSimulated(it: Pick<InteractionRow, "sender_ig_id">): boolean {
  return it.sender_ig_id.startsWith("sim_");
}

/** Deterministic sampling so a retried job makes the same choice. */
export function sampled(id: number, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const h = createHash("sha256").update(`reply-sample-${id}`).digest().readUInt32BE(0) / 0xffffffff;
  return h < rate;
}

async function upsertUserOnce(it: InteractionRow) {
  // A retried job must not count the same interaction twice.
  if (it.attempts > 0) {
    const existing = await one<Awaited<ReturnType<typeof upsertUser>>>("SELECT * FROM ig_users WHERE ig_scoped_id = $1", [it.sender_ig_id]);
    if (existing) return existing;
  }
  return upsertUser(it);
}

async function enqueueMemory(interactionId: number, worthIt: boolean): Promise<void> {
  if (!worthIt) return;
  await queue("conversation").add(JOBS.memoryExtract, { interactionId }, { jobId: jobId("memory", interactionId), delay: 5_000 });
}

/**
 * Send an approved review item. Used by the admin API; the same idempotent
 * reserve/deliver path as the autonomous route.
 */
export async function sendApprovedReply(messageId: number, editedText?: string): Promise<{ status: string; error?: string }> {
  const msg = await one<{ id: number; interaction_id: number; status: string }>(
    "SELECT id, interaction_id, status FROM messages WHERE id = $1 AND direction = 'out'",
    [messageId],
  );
  if (!msg) return { status: "not_found" };
  if (msg.status !== "pending_review") return { status: `not_pending (${msg.status})` };
  const it = await one<InteractionRow>("SELECT * FROM interactions WHERE id = $1", [msg.interaction_id]);
  if (!it) return { status: "not_found" };
  const c = await getControls();
  if (c.paused || c.mode === "development" || c.mode === "dry_run" || isSimulated(it)) {
    await one("UPDATE messages SET status = 'dry_run', text = coalesce($2, text) WHERE id = $1", [messageId, editedText ?? null]);
    return { status: "dry_run" };
  }
  if (editedText) {
    const a = await assessText(editedText, { direction: "outbound", skipLlm: true });
    if (a.level === "red") return { status: "blocked", error: `edited text is red: ${a.categories.join(", ")}` };
  }
  await one("UPDATE messages SET status = 'sending', text = coalesce($2, text) WHERE id = $1 AND status = 'pending_review'", [
    messageId,
    editedText ?? null,
  ]);
  const r = await deliver(messageId, it, { freshReservation: true });
  return { status: r.status, error: r.error };
}
