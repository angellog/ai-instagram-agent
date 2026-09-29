import type { Controls } from "../config/controls.js";
import { setting } from "../config/settings.js";
import { influencerId } from "../context.js";
import { assertBudget, recordCost } from "../cost/ledger.js";
import { many, one, tx } from "../db/pool.js";
import type { FetchLike } from "../lib/async.js";
import { PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { readCostUsd, X_API, XClient, type XUser } from "./client.js";

export interface XAccount {
  id: number;
  influencer_id: number;
  x_user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  stats: { followers?: number; following?: number; posts?: number };
  mentions_since_id: string | null;
  last_polled_at: Date | null;
  last_poll_note: string | null;
  created_at: Date;
}

// Test seam: an in-memory X API.
let fetchOverride: FetchLike | undefined;
let hostOverride: string | undefined;
export function setXFetch(f?: FetchLike, host?: string): void {
  fetchOverride = f;
  hostOverride = host;
}

export async function xClient(): Promise<XClient> {
  const bearer = await setting("X_BEARER_TOKEN");
  if (!bearer) throw new PermanentError("No X bearer token: add it under Config & keys → X (Twitter)");
  return new XClient(bearer, fetchOverride ?? fetch, hostOverride ?? X_API);
}

export async function primaryX(id = influencerId()): Promise<XAccount | undefined> {
  return one<XAccount>("SELECT * FROM x_accounts WHERE influencer_id = $1 AND is_primary", [id]);
}

/** Why X work can't run right now, or undefined when it can. Checked before any API call. */
export async function xBlocker(c: Controls): Promise<string | undefined> {
  if (c.paused) return "Paused";
  if (!c.x_enabled) return "X is switched off in Controls";
  if (!(await setting("X_BEARER_TOKEN"))) return "No X bearer token: add it under Config & keys → X (Twitter)";
  return undefined;
}

/** Items (posts + accounts) read from X today, across all influencers: the count cap. */
export async function xReadsToday(): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT coalesce(sum(coalesce((units->>'posts')::int, 0) + coalesce((units->>'users')::int, 0)), 0)::int AS n
     FROM cost_ledger WHERE provider = 'x' AND occurred_at >= date_trunc('day', now())`,
  );
  return Number(r?.n ?? 0);
}

/** Record what a read cost. X bills per item returned, so the true cost is only known afterwards. */
export async function recordXRead(operation: string, n: { posts?: number; users?: number }, refId?: string): Promise<void> {
  await recordCost({ category: "api", provider: "x", operation, units: { posts: n.posts ?? 0, users: n.users ?? 0 }, costUsd: readCostUsd(n), refType: "x_account", refId });
}

/** Refuse a read that would break the daily count or USD caps. */
export async function assertXRead(c: Controls, expectedItems: number): Promise<void> {
  const used = await xReadsToday();
  if (c.x_daily_read_cap <= 0 || used + expectedItems > c.x_daily_read_cap) {
    throw new PermanentError(`X daily read cap reached (${used}/${c.x_daily_read_cap} items today)`);
  }
  await assertBudget("api", readCostUsd({ posts: expectedItems }), "x");
}

function statsOf(u: XUser): XAccount["stats"] {
  const m = u.public_metrics ?? {};
  return { followers: m.followers_count, following: m.following_count, posts: m.tweet_count };
}

/**
 * Attach an X account to the current influencer by username. Phase 1 needs no
 * login: the bearer token can read any public account's mentions and posts.
 */
export async function connectX(c: Controls, username: string): Promise<XAccount> {
  await assertXRead(c, 1);
  const user = await (await xClient()).userByUsername(username);
  await recordXRead("x.read.user", { users: 1 });
  const id = influencerId();
  const acct = await tx(async (q) => {
    const taken = await one<{ influencer_id: number }>("SELECT influencer_id FROM x_accounts WHERE x_user_id = $1", [user.id], q);
    if (taken && Number(taken.influencer_id) !== id) throw new PermanentError(`@${user.username} is already connected to another influencer`);
    await q.query("UPDATE x_accounts SET is_primary = false WHERE influencer_id = $1 AND is_primary AND x_user_id <> $2", [id, user.id]);
    return one<XAccount>(
      `INSERT INTO x_accounts (influencer_id, x_user_id, username, display_name, avatar_url, stats)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (x_user_id) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url, stats = EXCLUDED.stats, is_primary = true, updated_at = now()
       RETURNING *`,
      [id, user.id, user.username, user.name ?? null, user.profile_image_url ?? null, JSON.stringify(statsOf(user))],
      q,
    );
  });
  await recordEvent("info", "x", `Connected X account @${user.username}`, { influencerId: id, xUserId: user.id });
  return acct!;
}

export async function disconnectX(): Promise<string | undefined> {
  const r = await one<{ username: string }>("DELETE FROM x_accounts WHERE influencer_id = $1 AND is_primary RETURNING username", [influencerId()]);
  if (r) await recordEvent("info", "x", `Disconnected X account @${r.username}`, { influencerId: influencerId() });
  return r?.username;
}

export async function updateXStats(accountId: number, u: XUser): Promise<void> {
  const s = statsOf(u);
  await one("UPDATE x_accounts SET stats = $2, display_name = coalesce($3, display_name), avatar_url = coalesce($4, avatar_url), updated_at = now() WHERE id = $1", [
    accountId,
    JSON.stringify(s),
    u.name ?? null,
    u.profile_image_url ?? null,
  ]);
  await one(
    `INSERT INTO x_account_metrics (x_account_id, day, followers, following, posts) VALUES ($1, current_date, $2, $3, $4)
     ON CONFLICT (x_account_id, day) DO UPDATE SET followers = EXCLUDED.followers, following = EXCLUDED.following, posts = EXCLUDED.posts, collected_at = now()`,
    [accountId, s.followers ?? null, s.following ?? null, s.posts ?? null],
  );
}

export async function followerHistory(accountId: number, days = 30): Promise<Array<{ day: string; followers: number | null }>> {
  return many("SELECT day::text AS day, followers FROM x_account_metrics WHERE x_account_id = $1 AND day > current_date - $2::int ORDER BY day", [accountId, days]);
}
