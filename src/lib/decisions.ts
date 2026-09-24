import { one } from "../db/pool.js";

/**
 * Auditable decision object (brief §18). `reason` is a concise operational
 * explanation, never model chain-of-thought.
 */
export interface DecisionRecord {
  agent: string;
  subjectType: "interaction" | "content_idea" | "post" | "activity" | "system";
  subjectId: string | number;
  intent?: string;
  action: string;
  confidence?: number;
  safetyLevel?: "green" | "yellow" | "red";
  contextUsed?: string[];
  reason?: string;
  output?: Record<string, unknown>;
  latencyMs?: number;
}

export async function recordDecision(d: DecisionRecord): Promise<number> {
  const r = await one<{ id: number }>(
    `INSERT INTO agent_decisions (agent, subject_type, subject_id, intent, action, confidence, safety_level, context_used, reason, output, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      d.agent,
      d.subjectType,
      String(d.subjectId),
      d.intent ?? null,
      d.action,
      d.confidence ?? null,
      d.safetyLevel ?? null,
      d.contextUsed ?? [],
      d.reason?.slice(0, 500) ?? null,
      JSON.stringify(d.output ?? {}),
      d.latencyMs ?? null,
    ],
  );
  return r!.id;
}
