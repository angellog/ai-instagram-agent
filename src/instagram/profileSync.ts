import { influencerId } from "../context.js";
import { one } from "../db/pool.js";
import { localParts } from "../lib/time.js";
import { persona } from "../persona/loader.js";
import { hasAccount, instagramClient, primaryAccount } from "./accounts.js";

export interface ProfileNumbers {
  username: string | null;
  followers: number | null;
  follows: number | null;
  media: number | null;
}

/**
 * Pull the live profile (username, followers, following, posts) into
 * ig_accounts.profile and today's account_metrics row. Runs hourly per
 * influencer, right after an account is attached, and on the Refresh button,
 * so follower counts never wait for the nightly insights snapshot.
 */
export async function syncProfile(): Promise<ProfileNumbers | undefined> {
  if (!(await hasAccount())) return undefined;
  const acct = await primaryAccount();
  const ig = await instagramClient();
  const p = await ig.getProfile();
  await one("UPDATE ig_accounts SET username = coalesce($2, username), profile = $3, updated_at = now() WHERE id = $1", [acct!.id, p.username ?? null, JSON.stringify(p)]);
  const day = localParts(new Date(), persona().identity.timezone).day;
  await one(
    `INSERT INTO account_metrics (influencer_id, day, followers, raw) VALUES ($1, $2, $3, $4)
     ON CONFLICT (influencer_id, day) DO UPDATE SET followers = EXCLUDED.followers, collected_at = now()`,
    [influencerId(), day, p.followers_count ?? null, JSON.stringify({ profile: p })],
  );
  return { username: p.username ?? null, followers: p.followers_count ?? null, follows: p.follows_count ?? null, media: p.media_count ?? null };
}
