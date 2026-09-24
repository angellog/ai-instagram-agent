import { many, one } from "../db/pool.js";
import type { PolicyVerdict } from "./policy.js";

export interface MemoryRow {
  id: number;
  layer: "identity" | "world" | "relationship";
  ig_user_id: number | null;
  kind: string;
  key: string;
  content: string;
  confidence: number;
  importance: number;
  source_type: string;
  source_id: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type Stored = Extract<PolicyVerdict, { store: true }>;

/**
 * Insert or refresh a memory. Same (layer, user, kind, key) updates the
 * existing row: newest content wins, confidence only goes up, expiry extends.
 */
export async function upsertMemory(
  layer: MemoryRow["layer"],
  igUserId: number | null,
  v: Stored,
  source: { type: string; id?: string },
): Promise<MemoryRow> {
  const existing = await one<MemoryRow>(
    `SELECT * FROM memories WHERE layer = $1 AND coalesce(ig_user_id, 0) = coalesce($2::bigint, 0) AND kind = $3 AND key = $4 AND status = 'active'`,
    [layer, igUserId, v.kind, v.key],
  );
  if (existing) {
    const r = await one<MemoryRow>(
      `UPDATE memories SET content = $2, confidence = greatest(confidence, $3), importance = greatest(importance, $4),
         expires_at = CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE greatest(coalesce(expires_at, $5), $5) END,
         source_type = $6, source_id = $7, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [existing.id, v.content, v.confidence, v.importance, v.expiresAt, source.type, source.id ?? null],
    );
    return r!;
  }
  const r = await one<MemoryRow>(
    `INSERT INTO memories (layer, ig_user_id, kind, key, content, confidence, importance, source_type, source_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [layer, igUserId, v.kind, v.key, v.content, v.confidence, v.importance, source.type, source.id ?? null, v.expiresAt],
  );
  return r!;
}

/**
 * Relationship memories for one person, ranked by importance, confidence and
 * recency (half-life 60 days). Marks them used for the audit trail.
 */
export async function relationshipMemories(igUserId: number, limit = 12): Promise<MemoryRow[]> {
  const rows = await many<MemoryRow>(
    `SELECT * FROM memories
     WHERE layer = 'relationship' AND ig_user_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
     ORDER BY importance * confidence * power(0.5, extract(epoch FROM now() - updated_at) / (60*86400)) DESC
     LIMIT $2`,
    [igUserId, limit],
  );
  if (rows.length) {
    await one("UPDATE memories SET times_used = times_used + 1, last_used_at = now() WHERE id = ANY($1)", [rows.map((r) => r.id)]);
  }
  return rows;
}

export async function worldMemories(kinds: string[] = [], limit = 20): Promise<MemoryRow[]> {
  return many<MemoryRow>(
    `SELECT * FROM memories
     WHERE layer = 'world' AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
       AND ($1::text[] = '{}' OR kind = ANY($1))
     ORDER BY updated_at DESC LIMIT $2`,
    [kinds, limit],
  );
}

export async function expireMemories(): Promise<number> {
  const r = await many<{ id: number }>(
    `UPDATE memories SET status = 'expired', updated_at = now()
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now() RETURNING id`,
  );
  return r.length;
}

export async function forgetUser(igUserId: number): Promise<number> {
  const r = await many<{ id: number }>(
    `UPDATE memories SET status = 'deleted', content = '[deleted]', updated_at = now()
     WHERE ig_user_id = $1 AND status <> 'deleted' RETURNING id`,
    [igUserId],
  );
  await one(
    "UPDATE ig_users SET relationship_summary = NULL, known_interests = '{}', preferences = '{}', updated_at = now() WHERE id = $1",
    [igUserId],
  );
  return r.length;
}
