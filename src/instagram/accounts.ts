import { env } from "../config/env.js";
import { many, one } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import type { FetchLike } from "../lib/async.js";
import { recordEvent } from "../lib/events.js";
import { InstagramClient } from "./client.js";

export interface IgAccountRow {
  id: number;
  ig_user_id: string;
  username: string | null;
  access_token_enc: string | null;
  access_token_plain: string | null;
  token_expires_at: Date | null;
  token_refreshed_at: Date | null;
  is_primary: boolean;
  profile: Record<string, unknown>;
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

export async function upsertAccount(o: {
  igUserId: string;
  username?: string;
  accessToken: string;
  expiresAt?: Date;
  makePrimary?: boolean;
  profile?: Record<string, unknown>;
}): Promise<IgAccountRow> {
  const sealed = sealToken(o.accessToken);
  if (o.makePrimary) await one("UPDATE ig_accounts SET is_primary = false WHERE is_primary AND ig_user_id <> $1", [o.igUserId]);
  const row = await one<IgAccountRow>(
    `INSERT INTO ig_accounts (ig_user_id, username, access_token_enc, access_token_plain, token_expires_at, token_refreshed_at, is_primary, profile)
     VALUES ($1,$2,$3,$4,$5, now(), $6, $7)
     ON CONFLICT (ig_user_id) DO UPDATE SET
       username = coalesce(EXCLUDED.username, ig_accounts.username),
       access_token_enc = EXCLUDED.access_token_enc,
       access_token_plain = EXCLUDED.access_token_plain,
       token_expires_at = EXCLUDED.token_expires_at,
       token_refreshed_at = now(),
       is_primary = ig_accounts.is_primary OR EXCLUDED.is_primary,
       profile = CASE WHEN EXCLUDED.profile = '{}'::jsonb THEN ig_accounts.profile ELSE EXCLUDED.profile END,
       updated_at = now()
     RETURNING *`,
    [o.igUserId, o.username ?? null, sealed.enc, sealed.plain, o.expiresAt ?? null, o.makePrimary ?? false, JSON.stringify(o.profile ?? {})],
  );
  return row!;
}

export async function primaryAccount(): Promise<IgAccountRow | undefined> {
  return one<IgAccountRow>("SELECT * FROM ig_accounts WHERE is_primary LIMIT 1");
}

/**
 * Seed the persona's account from INSTAGRAM_ACCOUNT_ID / INSTAGRAM_ACCESS_TOKEN
 * on boot. The DB copy is authoritative afterwards because the refresh job
 * rotates the token; the env value is only used if nothing is stored yet or the
 * operator changed the account id.
 */
export async function seedAccountFromEnv(): Promise<void> {
  const e = env();
  if (!e.INSTAGRAM_ACCOUNT_ID || !e.INSTAGRAM_ACCESS_TOKEN) return;
  const existing = await one<IgAccountRow>("SELECT * FROM ig_accounts WHERE ig_user_id = $1", [e.INSTAGRAM_ACCOUNT_ID]);
  if (existing && openToken(existing)) {
    if (!existing.is_primary) {
      await one("UPDATE ig_accounts SET is_primary = false WHERE is_primary");
      await one("UPDATE ig_accounts SET is_primary = true WHERE id = $1", [existing.id]);
    }
    return;
  }
  await upsertAccount({
    igUserId: e.INSTAGRAM_ACCOUNT_ID,
    accessToken: e.INSTAGRAM_ACCESS_TOKEN,
    // Unknown until the first refresh; assume a fresh 60-day token.
    expiresAt: new Date(Date.now() + 55 * 24 * 3600 * 1000),
    makePrimary: true,
  });
  await recordEvent("info", "instagram", "Seeded primary Instagram account from environment", { igUserId: e.INSTAGRAM_ACCOUNT_ID });
}

let clientOverride: InstagramClient | undefined;

/** Test hook: route every Instagram call through a fake client. */
export function setInstagramClient(c: InstagramClient | undefined): void {
  clientOverride = c;
}

export async function instagramClient(fetchImpl?: FetchLike): Promise<InstagramClient> {
  if (clientOverride) return clientOverride;
  const acct = await primaryAccount();
  if (!acct) throw new Error("No Instagram account connected (set INSTAGRAM_ACCOUNT_ID + INSTAGRAM_ACCESS_TOKEN or use /admin/connect)");
  const token = openToken(acct);
  if (!token) throw new Error("Primary Instagram account has no stored token");
  const e = env();
  return new InstagramClient({ accessToken: token, igUserId: acct.ig_user_id, host: e.META_GRAPH_HOST, version: e.META_GRAPH_API_VERSION, fetchImpl });
}

/** Refresh long-lived tokens with < `withinDays` left (they last 60 days). */
export async function refreshExpiringTokens(withinDays = 20, fetchImpl?: FetchLike): Promise<{ refreshed: number; failed: number }> {
  const rows = await many<IgAccountRow>(
    `SELECT * FROM ig_accounts
     WHERE token_expires_at IS NULL OR token_expires_at < now() + ($1 || ' days')::interval`,
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
        daysLeft: Number.isFinite(daysLeft) ? Math.round(daysLeft) : null,
        error: (e as Error).message,
      });
    }
  }
  return { refreshed, failed };
}
