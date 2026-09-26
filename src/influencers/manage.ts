import { env } from "../config/env.js";
import { invalidateInfluencer, parseKnowledge, slugify, withInfluencerLoose } from "../context.js";
import { many, one } from "../db/pool.js";
import { upsertAccount } from "../instagram/accounts.js";
import { InstagramClient } from "../instagram/client.js";
import { PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { parsePersona, recordPersonaVersion } from "../persona/loader.js";
import type { FetchLike } from "../lib/async.js";

export type InfluencerStatus = "hatching" | "active" | "paused" | "archived";

export interface InfluencerRow {
  id: number;
  slug: string;
  name: string;
  status: InfluencerStatus;
  persona_yaml: string;
  knowledge_yaml: string;
  avatar_url: string | null;
  hatch_state: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  hatched_at: Date | null;
}

/** A free slug derived from the name ("Amara K." → amara-k, then amara-k-2 …). */
export async function freeSlug(name: string): Promise<string> {
  const base = slugify(name) || "influencer";
  for (let i = 1; i < 100; i++) {
    const s = i === 1 ? base : `${base}-${i}`.slice(0, 40);
    if (!(await one("SELECT 1 FROM influencers WHERE slug = $1", [s]))) return s;
  }
  throw new PermanentError("could not find a free slug");
}

/** Start a new influencer (status hatching: invisible to schedulers until launched). */
export async function createInfluencer(o: { name: string; personaYaml?: string; knowledgeYaml?: string; hatchState?: Record<string, unknown> }): Promise<InfluencerRow> {
  const name = o.name.trim();
  if (!name || name.length > 60) throw new PermanentError("name must be 1–60 characters");
  if (o.personaYaml) parsePersona(o.personaYaml);
  if (o.knowledgeYaml) parseKnowledge(o.knowledgeYaml);
  const r = await one<InfluencerRow>(
    `INSERT INTO influencers (slug, name, status, persona_yaml, knowledge_yaml, hatch_state) VALUES ($1,$2,'hatching',$3,$4,$5) RETURNING *`,
    [await freeSlug(name), name, o.personaYaml ?? "", o.knowledgeYaml ?? "", JSON.stringify(o.hatchState ?? {})],
  );
  if (o.personaYaml) await recordPersonaVersion(Number(r!.id), o.personaYaml);
  await withInfluencerLoose(Number(r!.id), () => recordEvent("info", "influencers", `Hatching ${name}`, { influencerId: r!.id, slug: r!.slug }));
  return r!;
}

export async function getInfluencer(id: number): Promise<InfluencerRow | undefined> {
  return one<InfluencerRow>("SELECT * FROM influencers WHERE id = $1", [id]);
}

export async function allInfluencers(): Promise<
  Array<InfluencerRow & { username: string | null; followers: number | null; follows: number | null; media: number | null; synced_at: Date | null; soul_id: string | null }>
> {
  return many(
    `SELECT i.*, a.username,
            coalesce((a.profile->>'followers_count')::int, (SELECT followers FROM account_metrics m WHERE m.influencer_id = i.id ORDER BY day DESC LIMIT 1)) AS followers,
            (a.profile->>'follows_count')::int AS follows, (a.profile->>'media_count')::int AS media, a.updated_at AS synced_at,
            (SELECT soul_id FROM souls s WHERE s.influencer_id = i.id AND s.status = 'active') AS soul_id
     FROM influencers i LEFT JOIN ig_accounts a ON a.influencer_id = i.id AND a.is_primary
     ORDER BY CASE i.status WHEN 'active' THEN 0 WHEN 'hatching' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, i.id`,
  );
}

/** Validate and store a new persona (and optionally knowledge); versioned; takes effect within seconds. */
export async function updatePersona(id: number, personaYaml: string, knowledgeYaml?: string, by = "operator"): Promise<{ hash: string; name: string }> {
  const p = parsePersona(personaYaml); // readable error on invalid YAML/schema
  if (knowledgeYaml !== undefined) parseKnowledge(knowledgeYaml);
  const row = await one<{ id: number }>(
    `UPDATE influencers SET persona_yaml = $2, knowledge_yaml = coalesce($3, knowledge_yaml), name = $4, updated_at = now() WHERE id = $1 RETURNING id`,
    [id, personaYaml, knowledgeYaml ?? null, p.identity.name],
  );
  if (!row) throw new PermanentError(`influencer ${id} not found`);
  invalidateInfluencer(id);
  const hash = await recordPersonaVersion(id, personaYaml);
  await recordEvent("info", "influencers", `Persona updated by ${by}`, { influencerId: id, hash });
  return { hash, name: p.identity.name };
}

export async function setHatchState(id: number, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await one<{ hatch_state: Record<string, unknown> }>(
    "UPDATE influencers SET hatch_state = hatch_state || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING hatch_state",
    [id, JSON.stringify(patch)],
  );
  if (!r) throw new PermanentError(`influencer ${id} not found`);
  return r.hatch_state;
}

/**
 * Status changes. Launching requires a valid persona and an active soul;
 * the caller re-syncs schedulers (worker.syncInfluencerSchedulers).
 */
export async function setStatus(id: number, status: InfluencerStatus): Promise<void> {
  const inf = await getInfluencer(id);
  if (!inf) throw new PermanentError(`influencer ${id} not found`);
  if (status === "active") {
    if (!inf.persona_yaml.trim()) throw new PermanentError("give the influencer a persona before launching");
    parsePersona(inf.persona_yaml);
    if (!(await one("SELECT 1 FROM souls WHERE influencer_id = $1 AND status = 'active'", [id]))) throw new PermanentError("give the influencer a soul (face) before launching");
  }
  await one("UPDATE influencers SET status = $2, hatched_at = CASE WHEN $2 = 'active' THEN coalesce(hatched_at, now()) ELSE hatched_at END, updated_at = now() WHERE id = $1", [id, status]);
  invalidateInfluencer(id);
  await recordEvent("info", "influencers", `${inf.name} is now ${status}`, { influencerId: id });
}

export async function setAvatar(id: number, url: string): Promise<void> {
  await one("UPDATE influencers SET avatar_url = $2, updated_at = now() WHERE id = $1", [id, url]);
}

/**
 * Attach an Instagram professional account by access token (Instagram Login
 * API token from the Meta app dashboard's "Generate token"). Validates the
 * token with /me, refuses an account owned by another influencer, stores the
 * token encrypted, and optionally subscribes the account to webhooks.
 */
export async function attachInstagram(
  influencerId: number,
  token: string,
  o: { subscribe?: boolean; fetchImpl?: FetchLike } = {},
): Promise<{ username: string; igUserId: string; subscribed: boolean; accountType?: string }> {
  const t = token.trim();
  if (t.length < 20) throw new PermanentError("that does not look like an Instagram access token");
  const e = env();
  const probe = new InstagramClient({ accessToken: t, igUserId: "me", host: e.META_GRAPH_HOST, version: e.META_GRAPH_API_VERSION, fetchImpl: o.fetchImpl });
  const profile = await probe.getProfile();
  const igUserId = String(profile.user_id ?? profile.id);
  if (profile.account_type && !["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(String(profile.account_type).toUpperCase())) {
    throw new PermanentError(`@${profile.username} is a ${profile.account_type} account; switch it to Creator or Business in the Instagram app first`);
  }
  await upsertAccount({
    influencerId,
    igUserId,
    username: profile.username,
    accessToken: t,
    expiresAt: new Date(Date.now() + 55 * 86400_000),
    makePrimary: true,
    profile: profile as unknown as Record<string, unknown>,
  });
  let subscribed = false;
  if (o.subscribe) {
    const ig = new InstagramClient({ accessToken: t, igUserId, host: e.META_GRAPH_HOST, version: e.META_GRAPH_API_VERSION, fetchImpl: o.fetchImpl });
    subscribed = Boolean((await ig.subscribeWebhooks(["comments", "messages"])).success);
  }
  await recordEvent("info", "instagram", `Attached @${profile.username}`, { influencerId, igUserId, subscribed });
  if (profile.followers_count !== undefined) {
    await one(
      `INSERT INTO account_metrics (influencer_id, day, followers, raw) VALUES ($1, now()::date, $2, '{}')
       ON CONFLICT (influencer_id, day) DO UPDATE SET followers = EXCLUDED.followers, collected_at = now()`,
      [influencerId, profile.followers_count],
    );
  }
  return { username: profile.username ?? igUserId, igUserId, subscribed, accountType: profile.account_type ? String(profile.account_type) : undefined };
}
