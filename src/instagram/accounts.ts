import { env } from "../config/env.js";
import { currentInfluencer, influencerId, maybeInfluencer } from "../context.js";
import { many, one } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import type { FetchLike } from "../lib/async.js";
import { PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { InstagramClient, TokenInvalidError } from "./client.js";

export interface IgAccountRow {
  id: number;
  influencer_id: number;
  ig_user_id: string;
  username: string | null;
  access_token_enc: string | null;
  access_token_plain: string | null;
  token_expires_at: Date | null;
  token_refreshed_at: Date | null;
  is_primary: boolean;
  profile: Record<string, unknown>;
  token_status: "ok" | "invalid";
  token_error: string | null;
  token_invalid_at: Date | null;
}

function sealToken(token: string): { enc: string | null; plain: string | null } {
  const key = env().ENCRYPTION_KEY;
  return key ? { enc: encrypt(token, key), plain: null } : { enc: null, plain: token };
}

export function openToken(row: Pick<IgAccountRow, "access_token_enc" | "access_token_plain">): string | undefined {
  if (row.access_token_enc) {
    const key = env().ENCRYPTION_KEY;
    if (!key) throw new Error("Stored token is encrypted but ENCRYPTION_KEY is not set");
    return decrypt(row.access_token_enc, key);
  }
  return row.access_token_plain ?? undefined;
}

/**
 * Attach (or refresh) an Instagram account for an influencer. An account that
 * already belongs to a different influencer is refused: one Instagram page,
 * one influencer, always.
 */
export async function upsertAccount(o: {
  influencerId?: number;
  igUserId: string;
  username?: string;
  accessToken: string;
  expiresAt?: Date;
  makePrimary?: boolean;
  profile?: Record<string, unknown>;
}): Promise<IgAccountRow> {
  const owner = o.influencerId ?? influencerId();
  const existing = await one<{ influencer_id: number }>("SELECT influencer_id FROM ig_accounts WHERE ig_user_id = $1", [o.igUserId]);
  if (existing && Number(existing.influencer_id) !== owner) {
    const other = await one<{ slug: string }>("SELECT slug FROM influencers WHERE id = $1", [existing.influencer_id]);
    throw new PermanentError(`Instagram account ${o.igUserId} is already attached to influencer "${other?.slug}"`);
  }
  const sealed = sealToken(o.accessToken);
  if (o.makePrimary) {
    await one("UPDATE ig_accounts SET is_primary = false WHERE influencer_id = $1 AND is_primary AND ig_user_id <> $2", [owner, o.igUserId]);
  }
  const row = await one<IgAccountRow>(
    `INSERT INTO ig_accounts (influencer_id, ig_user_id, username, access_token_enc, access_token_plain, token_expires_at, token_refreshed_at, is_primary, profile)
     VALUES ($1,$2,$3,$4,$5,$6, now(), $7, $8)
     ON CONFLICT (ig_user_id) DO UPDATE SET
       username = coalesce(EXCLUDED.username, ig_accounts.username),
       access_token_enc = EXCLUDED.access_token_enc,
       access_token_plain = EXCLUDED.access_token_plain,
       token_expires_at = EXCLUDED.token_expires_at,
       token_refreshed_at = now(),
       token_status = 'ok', token_error = NULL, token_invalid_at = NULL,
       is_primary = ig_accounts.is_primary OR EXCLUDED.is_primary,
       profile = CASE WHEN EXCLUDED.profile = '{}'::jsonb THEN ig_accounts.profile ELSE EXCLUDED.profile END,
       updated_at = now()
     RETURNING *`,
    [owner, o.igUserId, o.username ?? null, sealed.enc, sealed.plain, o.expiresAt ?? null, o.makePrimary ?? false, JSON.stringify(o.profile ?? {})],
  );
  if (existing) {
    // A reconnect: bring back what was held while the account was disconnected.
    const { resumeAfterReconnect } = await import("../content/reconnect.js");
    await resumeAfterReconnect(owner).catch((e) => recordEvent("warn", "instagram", "Could not restore held posts after reconnect", { error: (e as Error).message }));
  }
  return row!;
}

/**
 * Meta ended the session (code 190: password change, security check, logout
 * everywhere). Mark the account disconnected once, alert once; everything that
 * needs Instagram then stops cleanly until a new token is attached.
 */
export async function markTokenInvalid(accountId: number, message: string): Promise<boolean> {
  const row = await one<{ influencer_id: number; username: string | null; ig_user_id: string }>(
    `UPDATE ig_accounts SET token_status = 'invalid', token_error = $2, token_invalid_at = now(), updated_at = now()
     WHERE id = $1 AND token_status = 'ok' RETURNING influencer_id, username, ig_user_id`,
    [accountId, message.slice(0, 500)],
  );
  if (!row) return false; // already known: no repeat alerts
  const inf = await one<{ name: string }>("SELECT name FROM influencers WHERE id = $1", [row.influencer_id]);
  const who = `${inf?.name ?? "An influencer"} (@${row.username ?? row.ig_user_id})`;
  await recordEvent("error", "instagram", `Instagram disconnected for ${who}: Meta ended the session. Reconnect to resume posting and replies.`, { influencerId: row.influencer_id, error: message });
  const { notify } = await import("../notify/telegram.js");
  await notify(`🔌 Instagram disconnected: ${who}\nMeta ended the session (password change or security check). Nothing will post or reply until you reconnect it.`, "/admin/persona#instagram").catch(() => undefined);
  return true;
}

/** Why this influencer can't use Instagram right now, or undefined when it can. */
export async function accountBlocker(id: number | undefined = maybeInfluencer()?.id): Promise<string | undefined> {
  if (id !== undefined && overrides.has(id)) return undefined;
  if (clientOverride) return undefined;
  const acct = await primaryAccount(id);
  if (!acct) return "no Instagram account connected";
  if (acct.token_status === "invalid") return `Instagram disconnected for @${acct.username ?? acct.ig_user_id}: reconnect it on the Persona page`;
  return undefined;
}

export async function primaryAccount(id: number | undefined = maybeInfluencer()?.id): Promise<IgAccountRow | undefined> {
  if (id === undefined) return undefined;
  return one<IgAccountRow>("SELECT * FROM ig_accounts WHERE influencer_id = $1 AND is_primary LIMIT 1", [id]);
}

/** Which influencer owns this Instagram account (webhook routing). */
export async function influencerForIgAccount(igUserId: string): Promise<number | undefined> {
  const r = await one<{ influencer_id: number }>("SELECT influencer_id FROM ig_accounts WHERE ig_user_id = $1", [igUserId]);
  return r ? Number(r.influencer_id) : undefined;
}

/**
 * Seed influencer #1's account from INSTAGRAM_ACCOUNT_ID / INSTAGRAM_ACCESS_TOKEN
 * (the single-influencer v0 setup). The DB copy is authoritative afterwards.
 */
export async function seedAccountFromEnv(target = 1): Promise<void> {
  const e = env();
  if (!e.INSTAGRAM_ACCOUNT_ID || !e.INSTAGRAM_ACCESS_TOKEN) return;
  const existing = await one<IgAccountRow>("SELECT * FROM ig_accounts WHERE ig_user_id = $1", [e.INSTAGRAM_ACCOUNT_ID]);
  if (existing && openToken(existing)) {
    if (!existing.username) await fillProfile(existing);
    return;
  }
  const row = await upsertAccount({
    influencerId: target,
    igUserId: e.INSTAGRAM_ACCOUNT_ID,
    accessToken: e.INSTAGRAM_ACCESS_TOKEN,
    expiresAt: new Date(Date.now() + 55 * 24 * 3600 * 1000),
    makePrimary: true,
  });
  await fillProfile(row);
  await recordEvent("info", "instagram", "Seeded Instagram account from environment", { igUserId: e.INSTAGRAM_ACCOUNT_ID, influencerId: target });
}

/** Best effort: store username/profile for display. Never blocks boot. */
async function fillProfile(row: IgAccountRow): Promise<void> {
  try {
    const token = openToken(row);
    if (!token) return;
    const profile = await clientFor(row, token).getProfile();
    await one("UPDATE ig_accounts SET username = $2, profile = $3, updated_at = now() WHERE id = $1", [row.id, profile.username, JSON.stringify(profile)]);
  } catch {
    // offline or token issue: the refresh job and dashboard surface real problems
  }
}

function clientFor(row: Pick<IgAccountRow, "ig_user_id"> & { id?: number }, token: string, fetchImpl?: FetchLike): InstagramClient {
  const e = env();
  return new InstagramClient({
    accessToken: token,
    igUserId: row.ig_user_id,
    host: e.META_GRAPH_HOST,
    version: e.META_GRAPH_API_VERSION,
    fetchImpl: fetchImpl ?? fetchOverride,
    onTokenInvalid: row.id === undefined ? undefined : (message) => markTokenInvalid(row.id!, message),
  });
}

let clientOverride: InstagramClient | undefined;
let fetchOverride: FetchLike | undefined;

/** Test hook: keep the real per-account client (token checks included) but send its HTTP to a fake. */
export function setInstagramFetch(f: FetchLike | undefined): void {
  fetchOverride = f;
}
/** The fetch Instagram clients should use (the test hook's, or the platform's). */
export const instagramFetch = (): FetchLike | undefined => fetchOverride;
const overrides = new Map<number, InstagramClient>();

/** Test hook: route every Instagram call through a fake client (optionally per influencer). */
export function setInstagramClient(c: InstagramClient | undefined, forInfluencer?: number): void {
  if (forInfluencer !== undefined) {
    if (c) overrides.set(forInfluencer, c);
    else overrides.delete(forInfluencer);
    return;
  }
  clientOverride = c;
  if (!c) overrides.clear();
}

/** True when Instagram can be used: a connected account whose token Meta hasn't ended (or a test client). */
export async function hasAccount(): Promise<boolean> {
  return (await accountBlocker()) === undefined;
}

/** The current influencer's Instagram client. Never another influencer's token. */
export async function instagramClient(fetchImpl?: FetchLike): Promise<InstagramClient> {
  const ctx = currentInfluencer();
  const o = overrides.get(ctx.id) ?? clientOverride;
  if (o) return o;
  const acct = await primaryAccount(ctx.id);
  if (!acct) throw new PermanentError(`${ctx.name} has no Instagram account connected`);
  // Never call Meta with a token it already rejected.
  if (acct.token_status === "invalid") throw new TokenInvalidError(`Instagram disconnected for @${acct.username ?? acct.ig_user_id}: reconnect it on the Persona page`);
  const token = openToken(acct);
  if (!token) throw new PermanentError(`${ctx.name}'s Instagram account has no stored token`);
  return clientFor(acct, token, fetchImpl);
}

/** Refresh long-lived tokens with < `withinDays` left, for every influencer. */
export async function refreshExpiringTokens(withinDays = 20, fetchImpl?: FetchLike): Promise<{ refreshed: number; failed: number }> {
  const rows = await many<IgAccountRow>(
    `SELECT * FROM ig_accounts
     WHERE token_status = 'ok' AND (token_expires_at IS NULL OR token_expires_at < now() + ($1 || ' days')::interval)`,
    [String(withinDays)],
  );
  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    const token = openToken(row);
    if (!token) continue;
    // Meta refuses refreshes of tokens younger than 24h.
    if (row.token_refreshed_at && Date.now() - new Date(row.token_refreshed_at).getTime() < 24 * 3600 * 1000) continue;
    try {
      const r = await InstagramClient.refreshLongLivedToken(token, { host: env().META_GRAPH_HOST, fetchImpl });
      const sealed = sealToken(r.access_token);
      await one(
        `UPDATE ig_accounts SET access_token_enc = $2, access_token_plain = $3, token_expires_at = $4, token_refreshed_at = now(), updated_at = now() WHERE id = $1`,
        [row.id, sealed.enc, sealed.plain, new Date(Date.now() + r.expires_in * 1000)],
      );
      refreshed++;
    } catch (e) {
      failed++;
      const daysLeft = row.token_expires_at ? (new Date(row.token_expires_at).getTime() - Date.now()) / 86_400_000 : NaN;
      await recordEvent(daysLeft < 7 ? "error" : "warn", "instagram", "Token refresh failed", {
        igUserId: row.ig_user_id,
        influencerId: row.influencer_id,
        daysLeft: Number.isFinite(daysLeft) ? Math.round(daysLeft) : null,
        error: (e as Error).message,
      });
    }
  }
  return { refreshed, failed };
}
