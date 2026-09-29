import { getControls } from "../config/controls.js";
import { influencerId } from "../context.js";
import { many, one } from "../db/pool.js";
import { errorMessage, PermanentError } from "../lib/errors.js";
import { assertXRead, primaryX, recordXRead, updateXStats, xBlocker, xClient } from "./accounts.js";

/** Posts are measured daily for this many days after they go out; most engagement lands in the first week. */
export const METRICS_WINDOW_DAYS = 7;

export type MetricsResult = { skipped: string } | { posts: number; followers?: number };

/** Daily snapshot of the account (followers) and its recent posts' public metrics. Safe to rerun: one row per post per day. */
export async function collectXMetrics(): Promise<MetricsResult> {
  const acct = await primaryX();
  if (!acct) return { skipped: "No X account connected" };
  const c = await getControls();
  const blocker = await xBlocker(c);
  if (blocker) return { skipped: blocker };
  try {
    await assertXRead(c, 2);
  } catch (e) {
    if (e instanceof PermanentError) return { skipped: errorMessage(e) };
    throw e;
  }
  const client = await xClient();
  const user = await client.user(acct.x_user_id);
  await recordXRead("x.read.user", { users: 1 }, String(acct.id));
  await updateXStats(acct.id, user);

  await assertXRead(c, 1);
  const page = await client.posts(acct.x_user_id, { startTime: new Date(Date.now() - METRICS_WINDOW_DAYS * 86400_000), maxResults: 100 });
  await recordXRead("x.read.posts", { posts: page.data.length }, String(acct.id));
  for (const p of page.data) {
    const m = p.public_metrics ?? {};
    await one(
      `INSERT INTO x_post_metrics (tweet_id, day, influencer_id, x_account_id, text, posted_at, impressions, likes, replies, reposts, quotes, bookmarks)
       VALUES ($1, current_date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tweet_id, day) DO UPDATE SET impressions = EXCLUDED.impressions, likes = EXCLUDED.likes, replies = EXCLUDED.replies,
         reposts = EXCLUDED.reposts, quotes = EXCLUDED.quotes, bookmarks = EXCLUDED.bookmarks, collected_at = now()`,
      [p.id, influencerId(), acct.id, p.text, p.created_at ?? new Date().toISOString(), m.impression_count ?? null, m.like_count ?? null, m.reply_count ?? null, m.retweet_count ?? null, m.quote_count ?? null, m.bookmark_count ?? null],
    );
  }
  return { posts: page.data.length, followers: user.public_metrics?.followers_count };
}

export interface XPostRow {
  tweet_id: string;
  text: string | null;
  posted_at: Date;
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  bookmarks: number | null;
  day: string;
}

/** Latest measurement of each recent post, newest post first. */
export async function latestPostMetrics(accountId: number, limit = 30): Promise<XPostRow[]> {
  return many(
    `SELECT DISTINCT ON (tweet_id) tweet_id, text, posted_at, impressions, likes, replies, reposts, bookmarks, day::text AS day
     FROM x_post_metrics WHERE x_account_id = $1 ORDER BY tweet_id, day DESC`,
    [accountId],
  ).then((rows) => (rows as XPostRow[]).sort((a, b) => +new Date(b.posted_at) - +new Date(a.posted_at)).slice(0, limit));
}
