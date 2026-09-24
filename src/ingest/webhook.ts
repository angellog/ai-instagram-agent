import { env } from "../config/env.js";
import { one } from "../db/pool.js";
import { hmacSha256Hex, sha256, signatureMatches } from "../lib/crypto.js";

/**
 * Meta webhook payloads for the Instagram product, normalized into the one
 * shape the conversation pipeline consumes. Shapes: docs/RESEARCH.md §2.
 */

export type InteractionKind = "comment" | "comment_reply" | "dm" | "story_reply" | "story_mention";

export interface NormalizedInteraction {
  kind: InteractionKind;
  igObjectId: string;
  igAccountId: string;
  senderIgId: string;
  senderUsername?: string;
  text: string;
  mediaId?: string;
  parentCommentId?: string;
  occurredAt: Date;
}

interface Entry {
  id?: string;
  time?: number;
  changes?: Array<{ field?: string; value?: Record<string, any> }>;
  messaging?: Array<{
    sender?: { id?: string };
    recipient?: { id?: string };
    timestamp?: number;
    message?: {
      mid?: string;
      text?: string;
      is_echo?: boolean;
      is_deleted?: boolean;
      is_unsupported?: boolean;
      reply_to?: { story?: { id?: string; url?: string } };
      attachments?: Array<{ type?: string; payload?: { url?: string } }>;
    };
  }>;
}

export function normalizeWebhook(payload: unknown): NormalizedInteraction[] {
  const p = payload as { object?: string; entry?: Entry[] };
  if (!p || p.object !== "instagram" || !Array.isArray(p.entry)) return [];
  const out: NormalizedInteraction[] = [];

  for (const entry of p.entry) {
    const accountId = entry.id;
    if (!accountId) continue;

    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (change.field === "comments" || change.field === "live_comments") {
        const id = v.id ?? v.comment_id;
        const from = v.from?.id;
        if (!id || !from) continue;
        // The persona's own comments/replies echo back as webhooks; never answer yourself.
        if (from === accountId) continue;
        out.push({
          kind: v.parent_id ? "comment_reply" : "comment",
          igObjectId: String(id),
          igAccountId: accountId,
          senderIgId: String(from),
          senderUsername: v.from?.username,
          text: String(v.text ?? ""),
          mediaId: v.media?.id ?? v.media_id,
          parentCommentId: v.parent_id,
          occurredAt: entry.time ? new Date(entry.time * 1000) : new Date(),
        });
      } else if (change.field === "mentions") {
        const id = v.comment_id ?? v.media_id;
        if (!id) continue;
        out.push({
          kind: "story_mention",
          igObjectId: String(id),
          igAccountId: accountId,
          senderIgId: String(v.from?.id ?? "unknown"),
          senderUsername: v.from?.username,
          text: String(v.text ?? ""),
          mediaId: v.media_id,
          occurredAt: entry.time ? new Date(entry.time * 1000) : new Date(),
        });
      }
    }

    for (const m of entry.messaging ?? []) {
      const msg = m.message;
      const sender = m.sender?.id;
      if (!msg || !msg.mid || !sender) continue;
      if (msg.is_echo || msg.is_deleted || msg.is_unsupported) continue;
      if (sender === accountId) continue;
      const isStoryReply = Boolean(msg.reply_to?.story);
      const text = msg.text ?? (msg.attachments?.length ? `[${msg.attachments.map((a) => a.type ?? "attachment").join(", ")}]` : "");
      out.push({
        kind: isStoryReply ? "story_reply" : "dm",
        igObjectId: msg.mid,
        igAccountId: m.recipient?.id ?? accountId,
        senderIgId: sender,
        text,
        occurredAt: m.timestamp ? new Date(m.timestamp) : new Date(),
      });
    }
  }
  return out;
}

/** Meta signs with the Instagram app secret or the Facebook app secret depending on app type. */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined): boolean {
  const e = env();
  const secrets = [e.INSTAGRAM_APP_SECRET, e.FACEBOOK_APP_SECRET].filter((s): s is string => Boolean(s));
  return secrets.some((s) => signatureMatches(hmacSha256Hex(s, rawBody), header));
}

/**
 * OpenReply relay: OpenReply already verified Meta's signature, then re-signs
 * the raw body with the shared relay secret plus a timestamp to stop replays.
 * Header: x-openreply-signature: t=<unix>,v1=<hex(hmac(secret, t + "." + body))>
 */
export function verifyRelaySignature(rawBody: Buffer | string, header: string | undefined, now = Date.now()): boolean {
  const secret = env().OPENREPLY_RELAY_SECRET;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false;
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  return signatureMatches(hmacSha256Hex(secret, `${t}.${body}`), parts.v1);
}

export function signRelay(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${hmacSha256Hex(secret, `${t}.${rawBody}`)}`;
}

/**
 * Persist the raw event. Returns undefined when this exact body was already
 * received (Meta retries deliveries; OpenReply may relay a retry too).
 */
export async function storeWebhookEvent(source: "meta" | "openreply_relay" | "simulated", rawBody: string, payload: unknown) {
  return one<{ id: number }>(
    `INSERT INTO webhook_events (source, dedup_key, payload) VALUES ($1, $2, $3)
     ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [source, sha256(rawBody), JSON.stringify(payload)],
  );
}
