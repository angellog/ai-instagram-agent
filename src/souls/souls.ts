import { influencerId } from "../context.js";
import { many, one, tx } from "../db/pool.js";
import { PermanentError } from "../lib/errors.js";
import type { SoulContext } from "../generation/types.js";

/**
 * Souls: an influencer's identity pack (v1.0.3 "give it a soul ID").
 * One active soul per influencer; creating a new one retires the old, so every
 * past post keeps pointing at the face it was made with. Identity references
 * are the ONLY images the Generation Engine accepts as identity anchors, and
 * they are owner-checked on every request.
 */

export interface SoulRow {
  id: number;
  influencer_id: number;
  soul_id: string;
  version: number;
  status: "draft" | "active" | "retired";
  description: string | null;
  provider_bindings: SoulContext["bindings"];
  created_at: Date;
}

export interface ActiveSoul {
  soul: SoulRow;
  identityRefs: string[];
  primaryRef: string | undefined;
}

export async function activeSoul(id: number = influencerId()): Promise<ActiveSoul | undefined> {
  const soul = await one<SoulRow>("SELECT * FROM souls WHERE influencer_id = $1 AND status = 'active'", [id]);
  if (!soul) return undefined;
  const refs = await many<{ url: string; is_primary: boolean }>(
    "SELECT url, is_primary FROM visual_references WHERE soul_id = $1 AND kind = 'identity' ORDER BY is_primary DESC, id",
    [soul.id],
  );
  return { soul, identityRefs: refs.map((r) => r.url), primaryRef: refs[0]?.url };
}

export function soulContext(s: ActiveSoul | undefined): SoulContext | undefined {
  return s ? { soulId: s.soul.soul_id, bindings: s.soul.provider_bindings ?? {} } : undefined;
}

export async function nextSoulId(slug: string): Promise<string> {
  const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM souls s JOIN influencers i ON i.id = s.influencer_id WHERE i.slug = $1", [slug]);
  return `soul_${slug.replace(/-/g, "_")}_v${(n?.n ?? 0) + 1}`;
}

/**
 * Create (and activate) a soul from approved identity references. The
 * references must already be public, durable URLs (hosted assets).
 */
export async function createSoul(o: {
  influencerId: number;
  soulId?: string;
  description?: string;
  identityRefs: string[];
  bindings?: SoulContext["bindings"];
  activate?: boolean;
}): Promise<SoulRow> {
  if (!o.identityRefs.length) throw new PermanentError("A soul needs at least one identity reference image");
  const slug = (await one<{ slug: string }>("SELECT slug FROM influencers WHERE id = $1", [o.influencerId]))?.slug;
  if (!slug) throw new PermanentError(`Influencer ${o.influencerId} not found`);
  const soulId = o.soulId ?? (await nextSoulId(slug));
  if (!/^soul_[a-z0-9_-]{2,60}$/.test(soulId)) throw new PermanentError(`Invalid soul id "${soulId}" (use soul_<letters, digits, _ or ->)`);
  return tx(async (c) => {
    const version = (await c.query<{ v: number }>("SELECT coalesce(max(version), 0) + 1 AS v FROM souls WHERE influencer_id = $1", [o.influencerId])).rows[0].v;
    if (o.activate !== false) await c.query("UPDATE souls SET status = 'retired', updated_at = now() WHERE influencer_id = $1 AND status = 'active'", [o.influencerId]);
    const soul = (
      await c.query<SoulRow>(
        `INSERT INTO souls (influencer_id, soul_id, version, status, description, provider_bindings) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [o.influencerId, soulId, version, o.activate === false ? "draft" : "active", o.description ?? null, JSON.stringify(o.bindings ?? {})],
      )
    ).rows[0];
    for (const [i, url] of o.identityRefs.entries()) {
      await c.query(
        "INSERT INTO visual_references (influencer_id, soul_id, kind, url, is_primary, label) VALUES ($1,$2,'identity',$3,$4,$5)",
        [o.influencerId, soul.id, url, i === 0, i === 0 ? "primary face" : `reference ${i + 1}`],
      );
    }
    return soul;
  });
}

export async function setSoulBinding(o: { influencerId: number; provider: string; binding: Record<string, unknown> | null }): Promise<void> {
  const s = await activeSoul(o.influencerId);
  if (!s) throw new PermanentError("No active soul to bind");
  const bindings = { ...(s.soul.provider_bindings ?? {}) };
  if (o.binding) bindings[o.provider] = o.binding as SoulContext["bindings"][string];
  else delete bindings[o.provider];
  await one("UPDATE souls SET provider_bindings = $2, updated_at = now() WHERE id = $1", [s.soul.id, JSON.stringify(bindings)]);
}

export async function listSouls(id: number): Promise<Array<SoulRow & { refs: string[] }>> {
  const souls = await many<SoulRow>("SELECT * FROM souls WHERE influencer_id = $1 ORDER BY version DESC", [id]);
  const out = [];
  for (const s of souls) {
    const refs = await many<{ url: string }>("SELECT url FROM visual_references WHERE soul_id = $1 AND kind = 'identity' ORDER BY is_primary DESC, id", [s.id]);
    out.push({ ...s, refs: refs.map((r) => r.url) });
  }
  return out;
}

/** Register a candidate image (e.g. a hatch face option) as owned by the influencer. */
export async function addCandidateReference(influencerId: number, url: string, label: string): Promise<void> {
  await one("INSERT INTO visual_references (influencer_id, kind, url, label) VALUES ($1, 'candidate', $2, $3)", [influencerId, url, label]);
}
