import type { FetchLike } from "../lib/async.js";
import { PermanentError, RateLimitedError, TransientError } from "../lib/errors.js";

/**
 * TikTok Open API v2 (open.tiktokapis.com): Login Kit tokens, user info and the
 * Content Posting API (photo posts pulled from our verified media domain).
 * Sources: developers.tiktok.com/doc/{oauth-user-access-token-management,
 * content-posting-api-get-started, content-posting-api-reference-photo-post,
 * content-posting-api-reference-query-creator-info,
 * content-posting-api-reference-get-video-status, content-posting-api-media-transfer-guide}.
 */

export const TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_API = "https://open.tiktokapis.com";
export const TIKTOK_SCOPES = ["user.info.basic", "user.info.profile", "user.info.stats", "video.publish", "video.upload"];

/** TikTok ended or rejected the login (token expired past renewal, revoked, or the account logged out everywhere). */
export class TikTokTokenError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = "TikTokTokenError";
  }
}

export interface TikTokTokens {
  access_token: string;
  expires_in: number;
  open_id: string;
  refresh_token: string;
  refresh_expires_in: number;
  scope: string;
  token_type: string;
}

export interface TikTokUser {
  open_id: string;
  union_id?: string;
  avatar_url?: string;
  display_name?: string;
  username?: string;
  follower_count?: number;
  following_count?: number;
  likes_count?: number;
  video_count?: number;
}

export type TikTokPrivacy = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";

export interface CreatorInfo {
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options: TikTokPrivacy[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

export interface PhotoPost {
  title: string;
  description: string;
  privacy_level: TikTokPrivacy;
  disable_comment: boolean;
  auto_add_music: boolean;
  brand_content_toggle: boolean;
  brand_organic_toggle: boolean;
  is_aigc: boolean;
  photo_images: string[];
  photo_cover_index: number;
}

export type PublishStatus = "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD" | "SEND_TO_USER_INBOX" | "PUBLISH_COMPLETE" | "FAILED";

const TOKEN_CODES = new Set(["access_token_invalid", "invalid_token", "token_expired", "scope_not_authorized", "invalid_grant"]);

/**
 * TikTok returns post ids as 19-digit JSON numbers (int64), which JavaScript
 * would round. Integers of 16+ digits are read as strings instead.
 */
export function parseLosslessly(text: string): unknown {
  try {
    return JSON.parse(text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
  } catch {
    return {};
  }
}

/** Map a TikTok error (OAuth or Open API envelope) to our retry semantics. */
export function classifyTikTokError(status: number, path: string, code: string | undefined, message: string | undefined): Error {
  const msg = `TikTok ${path}: ${message || code || `HTTP ${status}`}${code ? ` [${code}]` : ""}`;
  if (status === 401 || (code && TOKEN_CODES.has(code))) return new TikTokTokenError(msg);
  if (status === 429 || code === "rate_limit_exceeded") return new RateLimitedError(msg, 60_000);
  if (status >= 500 || code === "internal_error") return new TransientError(msg);
  return new PermanentError(msg, { code, status });
}

export class TikTokClient {
  constructor(
    private readonly accessToken: string,
    private readonly f: FetchLike = fetch,
    private readonly host = TIKTOK_API,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.host}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.f(url, {
        method,
        headers: { authorization: `Bearer ${this.accessToken}`, ...(body ? { "content-type": "application/json; charset=UTF-8" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new TransientError(`TikTok ${path}: network error ${(e as Error).message}`);
    }
    const json = parseLosslessly((await res.text().catch(() => "")) || "{}") as { data?: T; error?: { code?: string; message?: string } };
    const code = json.error?.code;
    if (!res.ok || (code && code !== "ok")) throw classifyTikTokError(res.status, url.pathname, code, json.error?.message);
    return (json.data ?? {}) as T;
  }

  userInfo(): Promise<{ user: TikTokUser }> {
    return this.call("GET", "/v2/user/info/", undefined, { fields: "open_id,union_id,avatar_url,display_name,username,follower_count,following_count,likes_count,video_count" });
  }

  /** Must be called before every post: the account's current privacy options and interaction settings. */
  creatorInfo(): Promise<CreatorInfo> {
    return this.call("POST", "/v2/post/publish/creator_info/query/", {});
  }

  /** Direct Post of a photo carousel; TikTok downloads each image from our verified domain. */
  async initPhotoPost(p: PhotoPost): Promise<{ publish_id: string }> {
    return this.call("POST", "/v2/post/publish/content/init/", {
      post_info: {
        title: p.title,
        description: p.description,
        privacy_level: p.privacy_level,
        disable_comment: p.disable_comment,
        auto_add_music: p.auto_add_music,
        brand_content_toggle: p.brand_content_toggle,
        brand_organic_toggle: p.brand_organic_toggle,
        is_aigc: p.is_aigc,
      },
      source_info: { source: "PULL_FROM_URL", photo_cover_index: p.photo_cover_index, photo_images: p.photo_images },
      post_mode: "DIRECT_POST",
      media_type: "PHOTO",
    });
  }

  fetchStatus(publishId: string): Promise<{ status: PublishStatus; fail_reason?: string; publicaly_available_post_id?: Array<string | number> }> {
    return this.call("POST", "/v2/post/publish/status/fetch/", { publish_id: publishId });
  }

  // ------------------------------------------------------------ OAuth (no bearer)
  private static async oauth(form: Record<string, string>, f: FetchLike = fetch, host = TIKTOK_API): Promise<TikTokTokens> {
    let res: Response;
    try {
      res = await f(`${host}/v2/oauth/token/`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new TransientError(`TikTok oauth: network error ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as Partial<TikTokTokens> & { error?: string; error_description?: string };
    if (!res.ok || json.error || !json.access_token) throw classifyTikTokError(res.status, "/v2/oauth/token/", json.error, json.error_description);
    return json as TikTokTokens;
  }

  static exchangeCode(o: { clientKey: string; clientSecret: string; code: string; redirectUri: string }, f?: FetchLike, host?: string): Promise<TikTokTokens> {
    return TikTokClient.oauth({ client_key: o.clientKey, client_secret: o.clientSecret, code: o.code, grant_type: "authorization_code", redirect_uri: o.redirectUri }, f, host);
  }

  static refresh(o: { clientKey: string; clientSecret: string; refreshToken: string }, f?: FetchLike, host?: string): Promise<TikTokTokens> {
    return TikTokClient.oauth({ client_key: o.clientKey, client_secret: o.clientSecret, grant_type: "refresh_token", refresh_token: o.refreshToken }, f, host);
  }

  static authorizeUrl(o: { clientKey: string; redirectUri: string; state: string; scopes?: string[] }): string {
    const u = new URL(TIKTOK_AUTH_URL);
    u.searchParams.set("client_key", o.clientKey);
    u.searchParams.set("scope", (o.scopes ?? TIKTOK_SCOPES).join(","));
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", o.redirectUri);
    u.searchParams.set("state", o.state);
    return u.toString();
  }
}
