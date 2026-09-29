import { env } from "../config/env.js";
import { setting } from "../config/settings.js";
import { maybeInfluencer } from "../context.js";
import { many, one } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import type { FetchLike } from "../lib/async.js";
import { errorMessage, PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { TikTokClient, TikTokTokenError, type CreatorInfo, type TikTokTokens, type TikTokUser } from "./client.js";

/**
 * TikTok accounts per influencer. Access tokens live 24h and are renewed
 * automatically with the refresh token (valid 365 days). If TikTok refuses the
 * renewal or a call, the account is marked disconnected once, with one alert,
 * exactly like Instagram (see instagram/accounts.ts markTokenInvalid).
 */

export interface TikTokAccountRow {
  id: number;
  influencer_id: number;
  open_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  scope: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  access_expires_at: Date | null;
  refresh_expires_at: Date | null;
  token_status: "ok" | "invalid";
  token_error: string | null;
  token_invalid_at: Date | null;
  creator_info: Partial<CreatorInfo>;
  stats: Record<string, unknown>;
}

const seal = (t: string) => {
  const key = env().ENCRYPTION_KEY;
  return key ? `enc:${encrypt(t, key)}` : `plain:${t}`;
};
const unseal = (s: string | null): string | undefined => {
  if (!s) return undefined;
  if (s.startsWith("plain:")) return s.slice(6);
  const key = env().ENCRYPTION_KEY;
  if (!key) throw new Error("Stored TikTok token is encrypted but ENCRYPTION_KEY is not set");
  return decrypt(s.replace(/^enc:/, ""), key);
};

let fetchOverride: FetchLike | undefined;
let hostOverride: string | undefined;
/** Test hook: send TikTok HTTP to a fake. */
export function setTikTokFetch(f: FetchLike | undefined, host?: string): void {
  fetchOverride = f;
  hostOverride = host;
}
export const tiktokFetch = () => fetchOverride;
export const tiktokHost = () => hostOverride;

export async function tiktokApp(): Promise<{ clientKey: string; clientSecret: string } | undefined> {
  const [clientKey, clientSecret] = await Promise.all([setting("TIKTOK_CLIENT_KEY"), setting("TIKTOK_CLIENT_SECRET")]);
  return clientKey && clientSecret ? { clientKey, clientSecret } : undefined;
}

export async function primaryTikTok(id: number | undefined = maybeInfluencer()?.id): Promise<TikTokAccountRow | undefined> {
  if (id === undefined) return undefined;
  return one<TikTokAccountRow>("SELECT * FROM tiktok_accounts WHERE influencer_id = $1 AND is_primary LIMIT 1", [id]);
}

/** Store (or refresh after a reconnect) the account from a fresh login. One TikTok account, one influencer. */
export async function upsertTikTok(influencerId: number, t: TikTokTokens, user: TikTokUser): Promise<TikTokAccountRow> {
  const other = await one<{ influencer_id: number }>("SELECT influencer_id FROM tiktok_accounts WHERE open_id = $1", [t.open_id]);
  if (other && Number(other.influencer_id) !== influencerId) {
    const who = await one<{ slug: string }>("SELECT slug FROM influencers WHERE id = $1", [other.influencer_id]);
    throw new PermanentError(`That TikTok account is already connected to "${who?.slug}"`);
  }
  // Replacing the account: the old one stops being primary.
  await one("UPDATE tiktok_accounts SET is_primary = false WHERE influencer_id = $1 AND open_id <> $2 AND is_primary", [influencerId, t.open_id]);
  const row = await one<TikTokAccountRow>(
    `INSERT INTO tiktok_accounts (influencer_id, open_id, username, display_name, avatar_url, scope, access_token_enc, refresh_token_enc,
       access_expires_at, refresh_expires_at, stats, is_primary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9), now() + make_interval(secs => $10), $11, true)
     ON CONFLICT (open_id) DO UPDATE SET username = coalesce(EXCLUDED.username, tiktok_accounts.username), display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url, scope = EXCLUDED.scope, access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at, stats = EXCLUDED.stats, is_primary = true,
       token_status = 'ok', token_error = NULL, token_invalid_at = NULL, updated_at = now()
     RETURNING *`,
    [
      influencerId,
      t.open_id,
      user.username ?? null,
      user.display_name ?? null,
      user.avatar_url ?? null,
      t.scope,
      seal(t.access_token),
      seal(t.refresh_token),
      t.expires_in,
      t.refresh_expires_in,
      JSON.stringify({ followers: user.follower_count ?? null, following: user.following_count ?? null, likes: user.likes_count ?? null, videos: user.video_count ?? null }),
    ],
  );
  await recordEvent("info", "tiktok", `TikTok connected: @${user.username ?? user.display_name ?? t.open_id}`, { influencerId });
  // Bring back anything held while it was disconnected.
  const { resumeAfterReconnect } = await import("../content/reconnect.js");
  await resumeAfterReconnect(influencerId, "tiktok").catch((e) => recordEvent("warn", "tiktok", "Could not restore held posts after reconnect", { error: errorMessage(e) }));
  return row!;
}

/** TikTok ended the login: mark it once, alert once. */
export async function markTikTokInvalid(accountId: number, message: string): Promise<boolean> {
  const row = await one<{ influencer_id: number; username: string | null; display_name: string | null }>(
    `UPDATE tiktok_accounts SET token_status = 'invalid', token_error = $2, token_invalid_at = now(), updated_at = now()
     WHERE id = $1 AND token_status = 'ok' RETURNING influencer_id, username, display_name`,
    [accountId, message.slice(0, 500)],
  );
  if (!row) return false;
  const inf = await one<{ name: string }>("SELECT name FROM influencers WHERE id = $1", [row.influencer_id]);
  const who = `${inf?.name ?? "An influencer"} (TikTok @${row.username ?? row.display_name ?? "?"})`;
  await recordEvent("error", "tiktok", `TikTok disconnected for ${who}: log in with TikTok again to resume posting.`, { influencerId: row.influencer_id, error: message });
  const { notify } = await import("../notify/telegram.js");
  await notify(`🔌 TikTok disconnected: ${who}\nNothing will post to TikTok until you log in with TikTok again.`, "/admin/persona#tiktok").catch(() => undefined);
  return true;
}

/** Why this influencer can't post to TikTok right now, or undefined when it can. */
export async function tiktokBlocker(id: number | undefined = maybeInfluencer()?.id): Promise<string | undefined> {
  const acct = await primaryTikTok(id);
  if (!acct) return "no TikTok account connected";
  if (acct.token_status === "invalid") return `TikTok disconnected for @${acct.username ?? acct.display_name ?? "?"}: log in with TikTok again`;
  return undefined;
}

/**
 * A client with a live access token, renewing it first when it expires within
 * 10 minutes. A refused renewal marks the account disconnected.
 */
export async function tiktokClientFor(acct: TikTokAccountRow): Promise<TikTokClient> {
  if (acct.token_status === "invalid") throw new TikTokTokenError(`TikTok disconnected for @${acct.username ?? "?"}: log in with TikTok again`);
  let token = unseal(acct.access_token_enc);
  if (!token || !acct.access_expires_at || new Date(acct.access_expires_at).getTime() < Date.now() + 10 * 60_000) {
    token = await renew(acct);
  }
  const client = new TikTokClient(token, fetchOverride ?? fetch, hostOverride);
  // Any "token invalid" answer during use marks the account too.
  return new Proxy(client, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        try {
          return await v.apply(target, args);
        } catch (e) {
          if (e instanceof TikTokTokenError) await markTikTokInvalid(acct.id, e.message);
          throw e;
        }
      };
    },
  });
}

async function renew(acct: TikTokAccountRow): Promise<string> {
  const app = await tiktokApp();
  const refresh = unseal(acct.refresh_token_enc);
  if (!app || !refresh) throw new PermanentError("TikTok app keys or refresh token missing: add them in Config & keys, then log in with TikTok");
  try {
    const t = await TikTokClient.refresh({ ...app, refreshToken: refresh }, fetchOverride, hostOverride);
    await one(
      `UPDATE tiktok_accounts SET access_token_enc = $2, refresh_token_enc = $3, access_expires_at = now() + make_interval(secs => $4),
         refresh_expires_at = now() + make_interval(secs => $5), scope = coalesce($6, scope), updated_at = now() WHERE id = $1`,
      [acct.id, seal(t.access_token), seal(t.refresh_token), t.expires_in, t.refresh_expires_in, t.scope ?? null],
    );
    return t.access_token;
  } catch (e) {
    if (e instanceof TikTokTokenError || (e instanceof PermanentError && /invalid_grant|refresh_token/i.test(e.message))) await markTikTokInvalid(acct.id, errorMessage(e));
    throw e;
  }
}

export async function tiktokClient(id: number | undefined = maybeInfluencer()?.id): Promise<TikTokClient> {
  const acct = await primaryTikTok(id);
  if (!acct) throw new PermanentError("No TikTok account connected");
  return tiktokClientFor(acct);
}

/** `tiktok.refresh` job: renew every live login that expires within 3 hours, so posting never waits on it. */
export async function refreshTikTokTokens(): Promise<{ refreshed: number; failed: number }> {
  const rows = await many<TikTokAccountRow>("SELECT * FROM tiktok_accounts WHERE token_status = 'ok' AND (access_expires_at IS NULL OR access_expires_at < now() + interval '3 hours')");
  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await renew(row);
      refreshed++;
    } catch (e) {
      failed++;
      await recordEvent("warn", "tiktok", "TikTok token renewal failed", { influencerId: row.influencer_id, error: errorMessage(e) });
    }
  }
  return { refreshed, failed };
}

/** Save the latest creator info (privacy options etc.) for the console. */
export async function saveCreatorInfo(accountId: number, info: CreatorInfo): Promise<void> {
  await one("UPDATE tiktok_accounts SET creator_info = $2, updated_at = now() WHERE id = $1", [accountId, JSON.stringify(info)]);
}
