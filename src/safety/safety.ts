import { influencerId } from "../context.js";
import { isSendingDisabled, type Controls } from "../config/controls.js";
import { one } from "../db/pool.js";
import { llm, type Moderation } from "../llm/llm.js";
import { errorMessage } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { allowedContacts } from "../conversation/knowledge.js";
import { evaluateRules, levelOf, maxLevel, type RuleHit, type SafetyLevel } from "./rules.js";

export interface SafetyAssessment {
  level: SafetyLevel;
  categories: string[];
  reason: string;
  ruleHits: RuleHit[];
  moderation?: Moderation;
}

/**
 * Rules first, then the LLM moderator; the stricter verdict wins. If the
 * moderator is unavailable the assessment fails closed to yellow, so an outage
 * degrades to "ask a human" rather than "send unchecked".
 */
export async function assessText(
  text: string,
  o: { direction: "inbound" | "outbound"; context?: string; ref?: { type: string; id: string }; skipLlm?: boolean },
): Promise<SafetyAssessment> {
  const ruleHits = evaluateRules(text, { direction: o.direction, allowedContacts: allowedContacts() });
  const ruleLevel = levelOf(ruleHits);
  if (ruleLevel === "red" || o.skipLlm) {
    return {
      level: ruleLevel,
      categories: [...new Set(ruleHits.map((h) => h.category))],
      reason: ruleHits.length ? `rule: ${ruleHits.map((h) => h.category).join(", ")}` : "no rule matched",
      ruleHits,
    };
  }
  let moderation: Moderation | undefined;
  try {
    moderation = await llm().moderate(text, { operation: "safety.moderate", context: o.context, ref: o.ref });
  } catch (e) {
    logger.warn({ err: errorMessage(e) }, "moderation unavailable, failing closed to yellow");
    return {
      level: maxLevel(ruleLevel, "yellow"),
      categories: [...new Set([...ruleHits.map((h) => h.category), "moderation_unavailable"])],
      reason: `moderator unavailable: ${errorMessage(e)}`,
      ruleHits,
    };
  }
  return {
    level: maxLevel(ruleLevel, moderation.level),
    categories: [...new Set([...ruleHits.map((h) => h.category), ...moderation.categories])],
    reason: ruleHits.length ? `rules: ${ruleHits.map((h) => h.category).join(", ")}; model: ${moderation.reason}` : moderation.reason,
    ruleHits,
    moderation,
  };
}

export type GateOutcome = "send" | "review" | "dry_run" | "block";

/**
 * What happens to something that passed generation, given its safety level
 * and the current operating mode (brief §12, §27).
 */
export function gate(level: SafetyLevel, c: Controls): GateOutcome {
  if (level === "red") return "block";
  if (c.mode === "human_approval") return "review";
  if (level === "yellow" && c.require_review_for_yellow) return "review";
  if (isSendingDisabled(c)) return "dry_run";
  return "send";
}

export async function openReview(o: {
  subjectType: "reply" | "post";
  subjectId: string;
  assessment: Pick<SafetyAssessment, "level" | "categories" | "reason">;
  proposed: Record<string, unknown>;
  status?: "pending" | "rejected";
}): Promise<number | undefined> {
  const r = await one<{ id: number }>(
    `INSERT INTO safety_reviews (subject_type, subject_id, level, categories, reason, proposed, status, reviewer, reviewed_at, influencer_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (subject_type, subject_id) DO UPDATE SET
       level = EXCLUDED.level, categories = EXCLUDED.categories, reason = EXCLUDED.reason,
       proposed = EXCLUDED.proposed,
       status = CASE WHEN safety_reviews.status IN ('approved','rejected') THEN safety_reviews.status ELSE EXCLUDED.status END
     RETURNING id`,
    [
      o.subjectType,
      o.subjectId,
      o.assessment.level,
      o.assessment.categories,
      o.assessment.reason,
      JSON.stringify(o.proposed),
      o.status ?? "pending",
      o.status === "rejected" ? "system" : null,
      o.status === "rejected" ? new Date() : null,
      influencerId(),
    ],
  );
  return r?.id;
}
