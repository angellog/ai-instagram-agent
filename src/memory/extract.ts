import { z } from "zod";
import { influencerId } from "../context.js";
import { many, one } from "../db/pool.js";
import { llm } from "../llm/llm.js";
import { allowedContacts } from "../conversation/knowledge.js";
import { recordEvent } from "../lib/events.js";
import { applyMemoryPolicy, RELATIONSHIP_KINDS } from "./policy.js";
import { relationshipMemories, upsertMemory } from "./store.js";

export const extractionSchema = z.object({
  memories: z
    .array(
      z.object({
        kind: z.enum(RELATIONSHIP_KINDS),
        content: z.string().describe("One short third-person fact, e.g. 'Prefers low-top Jordans'"),
        confidence: z.number().min(0).max(1),
        importance: z.number().min(0).max(1),
        expires_on: z.string().nullable().describe("ISO date if the fact is tied to a date, else null"),
      }),
    )
    .max(5),
});

const SYSTEM = `You extract durable relationship memory for an Instagram creator about ONE follower.
Only extract what the FOLLOWER stated or clearly implied about themselves: interests, preferences, facts relevant to future chats, open questions they asked, upcoming events they mentioned.
Rules:
- Never extract: health, religion, politics, sexuality, finances, exact addresses, phone numbers, emails, IDs, passwords, age if under 18, or anything about third parties.
- Never extract anything the creator said, or guesses. No speculation.
- Skip small talk. If nothing is worth remembering, return {"memories": []}.
- Do not repeat memories already known (listed below) unless the new message changes them.`;

/**
 * `memory.extract` job. Runs after the reply went out (or was skipped), so a
 * slow or failed extraction never delays the conversation.
 */
export async function extractMemories(interactionId: number): Promise<{ stored: number; rejected: number }> {
  const it = await one<{ id: number; text: string; sender_ig_id: string; kind: string }>(
    "SELECT id, text, sender_ig_id, kind FROM interactions WHERE id = $1 AND influencer_id = $2",
    [interactionId, influencerId()],
  );
  if (!it || !it.text.trim()) return { stored: 0, rejected: 0 };
  const user = await one<{ id: number; username: string | null; interaction_count: number }>(
    "SELECT id, username, interaction_count FROM ig_users WHERE influencer_id = $2 AND ig_scoped_id = $1",
    [it.sender_ig_id, influencerId()],
  );
  if (!user) return { stored: 0, rejected: 0 };

  const known = await relationshipMemories(user.id, 20);
  const reply = await one<{ text: string }>(
    "SELECT text FROM messages WHERE interaction_id = $1 AND direction = 'out' ORDER BY id DESC LIMIT 1",
    [interactionId],
  );

  const out = await llm().structured(extractionSchema, {
    operation: "memory.extract",
    tier: "fast",
    maxTokens: 600,
    ref: { type: "interaction", id: String(interactionId) },
    system: SYSTEM,
    prompt: [
      `Today: ${new Date().toISOString().slice(0, 10)}`,
      `Already known about @${user.username ?? "follower"}:\n${known.map((m) => `- (${m.kind}) ${m.content}`).join("\n") || "(nothing)"}`,
      `Follower's ${it.kind} message: """${it.text}"""`,
      reply ? `Creator's reply (context only, do not extract from it): """${reply.text}"""` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  let stored = 0;
  let rejected = 0;
  const contacts = allowedContacts();
  for (const cand of out.memories) {
    const v = applyMemoryPolicy(cand, new Date(), contacts);
    if (!v.store) {
      rejected++;
      await recordEvent("debug", "memory", "Memory candidate rejected by policy", { interactionId, reason: v.reason });
      continue;
    }
    await upsertMemory("relationship", user.id, v, { type: "message", id: String(interactionId) });
    stored++;
  }

  await refreshUserProfile(user.id, user.interaction_count);
  return { stored, rejected };
}

/** Denormalized profile fields + a periodic relationship summary. */
async function refreshUserProfile(igUserId: number, interactionCount: number): Promise<void> {
  const mems = await many<{ kind: string; content: string }>(
    "SELECT kind, content FROM memories WHERE influencer_id = $2 AND layer = 'relationship' AND ig_user_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 30",
    [igUserId, influencerId()],
  );
  const interests = mems.filter((m) => m.kind === "interest").map((m) => m.content).slice(0, 10);
  const prefs = Object.fromEntries(mems.filter((m) => m.kind === "preference").slice(0, 10).map((m, i) => [`p${i + 1}`, m.content]));
  await one("UPDATE ig_users SET known_interests = $2, preferences = $3, updated_at = now() WHERE id = $1", [
    igUserId,
    interests,
    JSON.stringify(prefs),
  ]);

  // Re-summarize on the 3rd interaction and every 5th after; cheap and bounded.
  if (mems.length && (interactionCount === 3 || (interactionCount > 3 && interactionCount % 5 === 0))) {
    const recent = await many<{ direction: string; text: string }>(
      `SELECT m.direction, m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.ig_user_id = $1 AND m.status IN ('received','sent') ORDER BY m.id DESC LIMIT 12`,
      [igUserId],
    );
    const summary = await llm().summarize(
      [
        "Known facts:",
        ...mems.map((m) => `- (${m.kind}) ${m.content}`),
        "Recent exchange (newest first):",
        ...recent.map((r) => `${r.direction === "in" ? "Follower" : "Creator"}: ${r.text}`),
      ].join("\n"),
      { operation: "memory.summarize", maxWords: 60, focus: "Describe the relationship: who they are to the creator and what they care about." },
    );
    await one("UPDATE ig_users SET relationship_summary = $2 WHERE id = $1", [igUserId, summary]);
  }
}
