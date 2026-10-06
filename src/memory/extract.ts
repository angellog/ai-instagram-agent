import { z } from "zod";
import { influencerId } from "../context.js";
import { many, one } from "../db/pool.js";
import { llm } from "../llm/llm.js";
import { allowedContacts } from "../conversation/knowledge.js";
import { recordEvent } from "../lib/events.js";
import { applyMemoryPolicy, RELATIONSHIP_KINDS } from "./policy.js";
import { relationshipMemories, selfMemories, upsertMemory } from "./store.js";

export const extractionSchema = z.object({
  memories: z
    .array(
      z.object({
        kind: z.enum(RELATIONSHIP_KINDS),
        content: z.string().describe("One short third-person fact, e.g. 'Prefers matte finishes over glossy'"),
        confidence: z.number().min(0).max(1),
        importance: z.number().min(0).max(1),
        expires_on: z.string().nullable().describe("ISO date if the fact is tied to a date, else null"),
      }),
    )
    .max(5),
  self: z
    .array(
      z.object({
        kind: z.enum(["self_fact", "self_plan"]).describe("self_plan for something the creator is about to do (with a date if known), self_fact otherwise"),
        content: z.string().describe("One short third-person fact about the CREATOR, using their name, e.g. 'Zuri is replaying Spider-Man 2 this week'"),
        expires_on: z.string().nullable().describe("ISO date after which a plan is over, else null"),
      }),
    )
    .max(3)
    .describe("New details the CREATOR shared about their own life in their reply; [] if none"),
});

const SYSTEM = `You extract durable relationship memory for an Instagram creator about ONE follower.
Only extract what the FOLLOWER stated or clearly implied about themselves: interests, preferences, facts relevant to future chats, open questions they asked, upcoming events they mentioned.
Rules:
- Never extract: health, religion, politics, sexuality, finances, exact addresses, phone numbers, emails, IDs, passwords, age if under 18, or anything about third parties.
- Never extract anything the creator said, or guesses. No speculation.
- Skip small talk. If nothing is worth remembering, return {"memories": []}.
- Do not repeat memories already known (listed below) unless the new message changes them.

Separately, under "self": the creator is a character with a consistent life. From the CREATOR's reply only, extract new concrete details they stated about themselves (a favourite film, what they're playing or watching, a place they go, a plan for the weekend, an opinion they hold). Skip generic pleasantries and anything already in THEIR CANON. Never include business facts (prices, stock, addresses).`;

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
  const canon = await selfMemories(it.text, 30);
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
      reply ? `Creator's reply (use it only for "self"): """${reply.text}"""` : "",
      `THEIR CANON (already known about the creator):\n${canon.map((m) => `- ${m.content}`).join("\n") || "(nothing yet)"}`,
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

  // The creator's own story: shared canon, and a note of what this person was told.
  for (const f of reply ? out.self : []) {
    const v = applyMemoryPolicy({ kind: f.kind, content: f.content, confidence: 0.9, importance: 0.6, expires_on: f.expires_on }, new Date(), contacts);
    if (!v.store) continue;
    await upsertMemory("identity", null, v, { type: "message", id: String(interactionId) });
    const told = applyMemoryPolicy({ kind: "shared", content: `Told them: ${f.content}`, confidence: 0.9, importance: 0.4 }, new Date(), contacts);
    if (told.store) await upsertMemory("relationship", user.id, told, { type: "message", id: String(interactionId) });
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
