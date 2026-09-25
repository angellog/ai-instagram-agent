import { influencerId } from "../context.js";
import { many, one } from "../db/pool.js";
import { instagramClient } from "../instagram/accounts.js";
import { calendarBrief } from "../calendar/events.js";
import { relationshipMemories, worldMemories, type MemoryRow } from "../memory/store.js";
import { retrieveKnowledge, type KnowledgeEntry } from "./knowledge.js";

export interface InteractionRow {
  id: number;
  influencer_id: number;
  kind: "comment" | "comment_reply" | "dm" | "story_reply" | "story_mention";
  ig_object_id: string;
  ig_account_id: string;
  sender_ig_id: string;
  sender_username: string | null;
  text: string;
  media_id: string | null;
  parent_comment_id: string | null;
  occurred_at: Date;
  status: string;
  attempts: number;
}

export interface UserRow {
  id: number;
  ig_scoped_id: string;
  username: string | null;
  interaction_count: number;
  relationship_summary: string | null;
  known_interests: string[];
  trust: "normal" | "vip" | "muted" | "blocked";
  first_interaction_at: Date;
  last_interaction_at: Date;
}

export interface ConversationContext {
  user: UserRow;
  conversationId: number;
  history: Array<{ direction: "in" | "out"; text: string; at: Date }>;
  memories: MemoryRow[];
  post?: { source: "own" | "instagram"; caption?: string; topic?: string; structure?: string; permalink?: string };
  knowledge: KnowledgeEntry[];
  recentOwnPosts: Array<{ topic: string; published_at: Date | null }>;
  /** Current affairs from the operator calendar (may be empty). */
  calendar: string;
  contextUsed: string[];
}

/** User lookup + upsert. Counts every interaction, including ignored ones. */
export async function upsertUser(it: InteractionRow): Promise<UserRow> {
  const r = await one<UserRow>(
    `INSERT INTO ig_users (influencer_id, ig_scoped_id, username, first_interaction_at, last_interaction_at, interaction_count)
     VALUES ($4, $1, $2, $3, $3, 1)
     ON CONFLICT (influencer_id, ig_scoped_id) DO UPDATE SET
       username = coalesce(EXCLUDED.username, ig_users.username),
       last_interaction_at = greatest(ig_users.last_interaction_at, EXCLUDED.last_interaction_at),
       interaction_count = ig_users.interaction_count + 1,
       updated_at = now()
     RETURNING *`,
    [it.sender_ig_id, it.sender_username, it.occurred_at, it.influencer_id],
  );
  return r!;
}

export function threadKey(it: InteractionRow): { key: string; channel: "dm" | "comments" } {
  if (it.kind === "dm" || it.kind === "story_reply") return { key: `dm:${it.sender_ig_id}`, channel: "dm" };
  return { key: `comments:${it.media_id ?? "unknown"}:${it.sender_ig_id}`, channel: "comments" };
}

export async function upsertConversation(it: InteractionRow, userId: number): Promise<number> {
  const t = threadKey(it);
  const r = await one<{ id: number }>(
    `INSERT INTO conversations (influencer_id, ig_user_id, channel, thread_key, media_id, last_inbound_at, message_count)
     VALUES ($6, $1, $2, $3, $4, $5, 0)
     ON CONFLICT (influencer_id, thread_key) DO UPDATE SET last_inbound_at = greatest(conversations.last_inbound_at, EXCLUDED.last_inbound_at), updated_at = now()
     RETURNING id`,
    [userId, t.channel, t.key, it.media_id, it.occurred_at, it.influencer_id],
  );
  return r!.id;
}

export async function recordInbound(conversationId: number, it: InteractionRow): Promise<void> {
  const existing = await one("SELECT 1 FROM messages WHERE interaction_id = $1 AND direction = 'in'", [it.id]);
  if (existing) return;
  await one(
    `INSERT INTO messages (influencer_id, conversation_id, interaction_id, direction, channel, text, status, created_at)
     VALUES ($6, $1, $2, 'in', $3, $4, 'received', $5)`,
    [conversationId, it.id, it.kind === "dm" || it.kind === "story_reply" ? "dm" : "comment", it.text, it.occurred_at, it.influencer_id],
  );
  await one("UPDATE conversations SET message_count = message_count + 1 WHERE id = $1", [conversationId]);
}

export async function buildContext(it: InteractionRow, user: UserRow, conversationId: number): Promise<ConversationContext> {
  const contextUsed: string[] = [];
  const history = (
    await many<{ direction: "in" | "out"; text: string; created_at: Date }>(
      `SELECT direction, text, created_at FROM messages
       WHERE conversation_id = $1 AND (interaction_id IS DISTINCT FROM $2 OR direction = 'out') AND status IN ('received','sent','dry_run')
       ORDER BY id DESC LIMIT 10`,
      [conversationId, it.id],
    )
  )
    .reverse()
    .map((m) => ({ direction: m.direction, text: m.text, at: m.created_at }));
  if (history.length) contextUsed.push("conversation_history");

  const memories = await relationshipMemories(user.id);
  if (memories.length || user.relationship_summary) contextUsed.push("user_memory");

  let post: ConversationContext["post"];
  if (it.media_id) {
    const own = await one<{ caption: string; permalink: string | null; topic: string | null; structure: string | null }>(
      `SELECT p.caption, p.permalink, ci.topic, ci.structure FROM posts p
       LEFT JOIN content_ideas ci ON ci.id = p.content_idea_id WHERE p.ig_media_id = $1 AND p.influencer_id = $2`,
      [it.media_id, influencerId()],
    );
    if (own) {
      post = { source: "own", caption: own.caption, topic: own.topic ?? undefined, structure: own.structure ?? undefined, permalink: own.permalink ?? undefined };
    } else {
      // Posts made outside the agent (manually, or before it existed).
      try {
        const m = await (await instagramClient()).getMedia(it.media_id);
        post = { source: "instagram", caption: m.caption, permalink: m.permalink };
      } catch {
        post = undefined;
      }
    }
    if (post) contextUsed.push("recent_post");
  }

  const knowledge = retrieveKnowledge(it.text);
  if (knowledge.length) contextUsed.push("business_knowledge");

  const recentOwnPosts = (await worldMemories(["published"], 5)).map((m) => ({ topic: m.content, published_at: m.updated_at }));
  if (recentOwnPosts.length) contextUsed.push("recent_activity");

  const calendar = await calendarBrief("conversation");
  if (calendar) contextUsed.push("calendar");

  return { user, conversationId, history, memories, post, knowledge, recentOwnPosts, calendar, contextUsed };
}

export function renderContext(it: InteractionRow, ctx: ConversationContext, now = new Date()): string {
  const u = ctx.user;
  const sinceFirst = Math.round((now.getTime() - new Date(u.first_interaction_at).getTime()) / 86_400_000);
  return [
    `INTERACTION: ${it.kind} from @${u.username ?? it.sender_username ?? "unknown"} at ${new Date(it.occurred_at).toISOString()}`,
    `MESSAGE: """${it.text}"""`,
    `PERSON: ${u.interaction_count} interactions over ${sinceFirst} days${u.trust === "vip" ? " (VIP regular)" : ""}.${
      u.relationship_summary ? ` Summary: ${u.relationship_summary}` : ""
    }`,
    `MEMORIES (the only things you remember about them):\n${
      ctx.memories.map((m) => `- [${m.id}] (${m.kind}) ${m.content}`).join("\n") || "- none"
    }`,
    ctx.history.length
      ? `THREAD SO FAR:\n${ctx.history.map((h) => `${h.direction === "in" ? "Them" : "You"}: ${h.text}`).join("\n")}`
      : "THREAD SO FAR: (first message in this thread)",
    ctx.post
      ? `POST THEY ARE ON: ${ctx.post.topic ? `topic "${ctx.post.topic}"; ` : ""}caption: """${(ctx.post.caption ?? "").slice(0, 600)}"""`
      : "",
    ctx.knowledge.length ? `KNOWLEDGE:\n${ctx.knowledge.map((k) => `- [${k.id}] ${k.content.trim()}`).join("\n")}` : "KNOWLEDGE: none relevant",
    ctx.calendar ? `WHAT'S GOING ON AROUND YOU (mention only if it is relevant to what they said):\n${ctx.calendar}` : "",
    ctx.recentOwnPosts.length ? `YOUR RECENT POSTS: ${ctx.recentOwnPosts.map((p) => p.topic).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
