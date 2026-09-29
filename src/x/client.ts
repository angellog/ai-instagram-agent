import type { FetchLike } from "../lib/async.js";
import { PermanentError, RateLimitedError, TransientError } from "../lib/errors.js";
import { parseLosslessly } from "../tiktok/client.js";

/**
 * X API v2 (api.x.com), read-only. Phase 1 authenticates with the app-only
 * bearer token, which X accepts for mention timelines, user timelines and
 * user lookup but never for writes — so this client cannot post by design.
 * Sources: docs.x.com/x-api/{users/get-mentions, users/get-posts,
 * users/user-lookup-by-username, getting-started/pricing}.
 */

export const X_API = "https://api.x.com";

/**
 * Pay-per-use prices for app-only reads (USD per resource returned).
 * Owned Reads ($0.001) need user-context auth as the app owner — phase 2.
 * Keep COSTS.md in sync.
 */
export const X_READ_PRICES = { post: 0.005, user: 0.01 } as const;

export function readCostUsd(n: { posts?: number; users?: number }): number {
  return (n.posts ?? 0) * X_READ_PRICES.post + (n.users ?? 0) * X_READ_PRICES.user;
}

/** X refused the bearer token (revoked, regenerated, or the app was suspended). */
export class XAuthError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = "XAuthError";
  }
}

/** The developer account has no API credit left; nothing works until it is topped up. */
export class XCreditsError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = "XCreditsError";
  }
}

export interface XUser {
  id: string;
  username: string;
  name?: string;
  profile_image_url?: string;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number; listed_count?: number };
}

export interface XPost {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  lang?: string;
  referenced_tweets?: Array<{ type: "replied_to" | "quoted" | "retweeted"; id: string }>;
  public_metrics?: { impression_count?: number; like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number; bookmark_count?: number };
}

export interface XPage {
  data: XPost[];
  users: XUser[];
  newestId?: string;
  nextToken?: string;
}

interface Envelope<T> {
  data?: T;
  includes?: { users?: XUser[] };
  meta?: { newest_id?: string; next_token?: string; result_count?: number };
  errors?: Array<{ message?: string; title?: string; detail?: string }>;
  title?: string;
  detail?: string;
  type?: string;
}

/** Map an X error response to our retry semantics. */
export function classifyXError(status: number, path: string, body: { title?: string; detail?: string; type?: string } | undefined, resetEpochSec?: number, now = Date.now()): Error {
  const why = body?.detail || body?.title || `HTTP ${status}`;
  const msg = `X ${path}: ${why}`;
  if (status === 402 || body?.type?.endsWith("/credits-depleted")) return new XCreditsError(`${msg} — top up credits at console.x.com`);
  if (status === 401 || status === 403) return new XAuthError(msg);
  if (status === 429) {
    const wait = resetEpochSec ? Math.max(1_000, resetEpochSec * 1000 - now) : 15 * 60_000;
    return new RateLimitedError(msg, wait);
  }
  if (status >= 500) return new TransientError(msg);
  return new PermanentError(msg, { status, type: body?.type });
}

const POST_FIELDS = "created_at,conversation_id,lang,referenced_tweets,author_id";

export class XClient {
  constructor(
    private readonly bearer: string,
    private readonly f: FetchLike = fetch,
    private readonly host = X_API,
  ) {}

  private async get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<Envelope<T>> {
    const url = new URL(`${this.host}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.f(url, { method: "GET", headers: { authorization: `Bearer ${this.bearer}` }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new TransientError(`X ${path}: network error ${(e as Error).message}`);
    }
    const json = parseLosslessly((await res.text().catch(() => "")) || "{}") as Envelope<T>;
    if (!res.ok) {
      const reset = Number(res.headers.get("x-rate-limit-reset") ?? "") || undefined;
      throw classifyXError(res.status, url.pathname, json, reset);
    }
    return json;
  }

  async userByUsername(username: string): Promise<XUser> {
    const u = username.replace(/^@/, "").trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(u)) throw new PermanentError(`"${username}" is not a valid X username`);
    const r = await this.get<XUser>(`/2/users/by/username/${u}`, { "user.fields": "name,profile_image_url,public_metrics" });
    if (!r.data) throw new PermanentError(`X: no account @${u}${r.errors?.[0]?.detail ? ` (${r.errors[0].detail})` : ""}`);
    return r.data;
  }

  async user(id: string): Promise<XUser> {
    const r = await this.get<XUser>(`/2/users/${id}`, { "user.fields": "name,profile_image_url,public_metrics" });
    if (!r.data) throw new PermanentError(`X: no account with id ${id}`);
    return r.data;
  }

  /** Newest first. With sinceId only newer mentions come back; nextToken pages to older ones. */
  async mentions(userId: string, o: { sinceId?: string; maxResults?: number; paginationToken?: string } = {}): Promise<XPage> {
    const r = await this.get<XPost[]>(`/2/users/${userId}/mentions`, {
      since_id: o.sinceId,
      pagination_token: o.paginationToken,
      max_results: String(Math.min(100, Math.max(5, o.maxResults ?? 20))),
      "tweet.fields": POST_FIELDS,
      expansions: "author_id",
      "user.fields": "username,name",
    });
    return { data: r.data ?? [], users: r.includes?.users ?? [], newestId: r.meta?.newest_id, nextToken: r.meta?.next_token };
  }

  /** The account's own posts (no reposts) since startTime, with public metrics. */
  async posts(userId: string, o: { startTime?: Date; maxResults?: number; paginationToken?: string } = {}): Promise<XPage> {
    const r = await this.get<XPost[]>(`/2/users/${userId}/tweets`, {
      start_time: o.startTime?.toISOString().replace(/\.\d{3}Z$/, "Z"),
      pagination_token: o.paginationToken,
      max_results: String(Math.min(100, Math.max(5, o.maxResults ?? 100))),
      exclude: "retweets",
      "tweet.fields": `${POST_FIELDS},public_metrics`,
    });
    return { data: r.data ?? [], users: [], newestId: r.meta?.newest_id, nextToken: r.meta?.next_token };
  }
}
