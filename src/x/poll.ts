import { getControls } from "../config/controls.js";
import { influencerId } from "../context.js";
import { one } from "../db/pool.js";
import { errorMessage, PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { assertXRead, primaryX, recordXRead, xBlocker, xClient } from "./accounts.js";
import type { XPost, XUser } from "./client.js";

/** Mentions per page, and how many pages one poll may read. The first poll only backfills one page. */
export const MENTION_PAGE_SIZE = 20;
export const MENTION_MAX_PAGES = 5;

export type PollResult = { skipped: string } | { fetched: number; inserted: number; pages: number; truncated: boolean };

/**
 * Read new mentions of the influencer's X account into x_mentions. Idempotent:
 * tweet ids are unique, and the since_id cursor only moves forward. An
 * influencer with no X account returns immediately without touching the API.
 */
export async function pollMentions(): Promise<PollResult> {
  const acct = await primaryX();
  if (!acct) return { skipped: "No X account connected" };
  const c = await getControls();
  const blocker = await xBlocker(c);
  if (blocker) return skip(acct.id, blocker);
  // Caps reached: skip quietly (and say so on the X page) instead of failing every 15 minutes.
  try {
    await assertXRead(c, 1);
  } catch (e) {
    if (e instanceof PermanentError) return skip(acct.id, errorMessage(e));
    throw e;
  }

  const client = await xClient();
  const since = acct.mentions_since_id ?? undefined;
  const maxPages = since ? MENTION_MAX_PAGES : 1;
  let newest: string | undefined;
  let token: string | undefined;
  let fetched = 0;
  let inserted = 0;
  let pages = 0;
  do {
    await assertXRead(c, 1);
    const page = await client.mentions(acct.x_user_id, { sinceId: since, maxResults: MENTION_PAGE_SIZE, paginationToken: token });
    pages++;
    await recordXRead("x.read.mentions", { posts: page.data.length, users: page.users.length }, String(acct.id));
    newest ??= page.newestId;
    fetched += page.data.length;
    const users = new Map(page.users.map((u) => [u.id, u]));
    for (const p of page.data) {
      if (p.author_id === acct.x_user_id) continue; // our own posts that tag us
      if (await insertMention(acct.id, p, users)) inserted++;
    }
    token = page.nextToken;
  } while (token && pages < maxPages);

  const truncated = Boolean(token);
  const note = `${inserted} new mention${inserted === 1 ? "" : "s"}${truncated && since ? " (older ones skipped)" : ""}`;
  await one("UPDATE x_accounts SET mentions_since_id = coalesce($2, mentions_since_id), last_polled_at = now(), last_poll_note = $3, updated_at = now() WHERE id = $1", [acct.id, newest ?? null, note]);
  if (truncated && since) {
    await recordEvent("warn", "x", `More than ${MENTION_PAGE_SIZE * MENTION_MAX_PAGES} mentions since the last poll; older ones were skipped`, { influencerId: influencerId(), account: acct.username });
  }
  return { fetched, inserted, pages, truncated };
}

async function skip(accountId: number, why: string): Promise<PollResult> {
  await one("UPDATE x_accounts SET last_poll_note = $2 WHERE id = $1", [accountId, `Skipped: ${why}`]);
  return { skipped: why };
}

async function insertMention(accountId: number, p: XPost, users: Map<string, XUser>): Promise<boolean> {
  const author = p.author_id ? users.get(p.author_id) : undefined;
  const replyTo = p.referenced_tweets?.find((r) => r.type === "replied_to")?.id ?? null;
  const r = await one<{ id: number }>(
    `INSERT INTO x_mentions (influencer_id, x_account_id, tweet_id, conversation_id, in_reply_to_tweet_id, author_id, author_username, author_name, text, lang, posted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tweet_id) DO NOTHING RETURNING id`,
    [influencerId(), accountId, p.id, p.conversation_id ?? null, replyTo, p.author_id ?? "unknown", author?.username ?? null, author?.name ?? null, p.text, p.lang ?? null, p.created_at ?? new Date().toISOString()],
  );
  return Boolean(r);
}
