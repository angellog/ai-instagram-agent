import { sleep, type FetchLike } from "../lib/async.js";
import { PermanentError, RateLimitedError, TransientError } from "../lib/errors.js";

/**
 * Instagram API with Instagram Login (graph.instagram.com). Every endpoint
 * used here is documented in docs/RESEARCH.md §2. Auth is a Bearer header so
 * tokens never appear in URLs or logs.
 */

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly subcode?: number,
    readonly traceId?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

export class TokenInvalidError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = "TokenInvalidError";
  }
}

export type ContainerStatus = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED";

export interface IgProfile {
  id: string;
  user_id?: string;
  username: string;
  name?: string;
  account_type?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  profile_picture_url?: string;
}

export interface IgMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

export interface InstagramClientOptions {
  accessToken: string;
  igUserId: string;
  host?: string;
  version?: string;
  fetchImpl?: FetchLike;
  /** Poll schedule for container status, overridable in tests. */
  pollDelaysMs?: number[];
}

const DEFAULT_POLL = [3_000, 5_000, 10_000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];

export class InstagramClient {
  readonly igUserId: string;
  private readonly base: string;
  private readonly token: string;
  private readonly f: FetchLike;
  private readonly pollDelays: number[];

  constructor(o: InstagramClientOptions) {
    this.igUserId = o.igUserId;
    this.token = o.accessToken;
    this.base = `${(o.host ?? "https://graph.instagram.com").replace(/\/$/, "")}/${o.version ?? "v25.0"}`;
    this.f = o.fetchImpl ?? fetch;
    this.pollDelays = o.pollDelaysMs ?? DEFAULT_POLL;
  }

  // ------------------------------------------------------------ transport
  async request<T>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = new URL(`${this.base}/${path.replace(/^\//, "")}`);
    const init: RequestInit = { method, headers: { authorization: `Bearer ${this.token}` } };
    if (method === "GET" || method === "DELETE") {
      for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    } else {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(params);
    }
    let res: Response;
    try {
      res = await this.f(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new TransientError(`Instagram ${method} ${url.pathname}: network error ${(e as Error).message}`);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    const err = (data as { error?: { message?: string; code?: number; error_subcode?: number; type?: string; fbtrace_id?: string } }).error;
    if (!res.ok || err) throw classifyMetaError(res.status, url.pathname, err);
    return data as T;
  }

  // -------------------------------------------------------------- profile
  getProfile(): Promise<IgProfile> {
    return this.request("GET", "me", {
      fields: "id,user_id,username,name,account_type,followers_count,follows_count,media_count,profile_picture_url",
    });
  }

  // ------------------------------------------------------------- comments
  replyToComment(commentId: string, message: string): Promise<{ id: string }> {
    return this.request("POST", `${commentId}/replies`, { message });
  }

  hideComment(commentId: string, hide = true): Promise<{ success: boolean }> {
    return this.request("POST", commentId, { hide });
  }

  getComment(commentId: string): Promise<{ id: string; text?: string; username?: string; timestamp?: string; parent_id?: string }> {
    return this.request("GET", commentId, { fields: "id,text,username,timestamp,parent_id,media{id}" });
  }

  // ------------------------------------------------------------ messaging
  sendDirectMessage(recipientIgsid: string, text: string): Promise<{ recipient_id: string; message_id: string }> {
    return this.request("POST", `${this.igUserId}/messages`, { recipient: { id: recipientIgsid }, message: { text } });
  }

  /** One private DM in reply to a comment (7-day window, once per commenter). */
  sendPrivateReply(commentId: string, text: string): Promise<{ recipient_id: string; message_id: string }> {
    return this.request("POST", `${this.igUserId}/messages`, { recipient: { comment_id: commentId }, message: { text } });
  }

  // ------------------------------------------------------------ publishing
  createImageContainer(o: {
    imageUrl: string;
    caption?: string;
    isCarouselItem?: boolean;
    altText?: string;
    isAiGenerated?: boolean;
  }): Promise<{ id: string }> {
    return this.request("POST", `${this.igUserId}/media`, {
      image_url: o.imageUrl,
      ...(o.isCarouselItem ? { is_carousel_item: true } : { caption: o.caption ?? "" }),
      ...(o.altText ? { alt_text: o.altText.slice(0, 1000) } : {}),
      ...(o.isAiGenerated ? { is_ai_generated: true } : {}),
    });
  }

  async createCarouselContainer(o: { children: string[]; caption: string; isAiGenerated?: boolean }): Promise<{ id: string }> {
    if (o.children.length < 2 || o.children.length > 10) throw new PermanentError(`Carousel needs 2-10 children, got ${o.children.length}`);
    return this.request("POST", `${this.igUserId}/media`, {
      media_type: "CAROUSEL",
      children: o.children.join(","),
      caption: o.caption,
      ...(o.isAiGenerated ? { is_ai_generated: true } : {}),
    });
  }

  async getContainerStatus(containerId: string): Promise<{ status_code: ContainerStatus; status?: string }> {
    return this.request("GET", containerId, { fields: "status_code,status" });
  }

  /**
   * Wait until a container is FINISHED (or already PUBLISHED). ERROR and
   * EXPIRED are permanent for this container; the caller rebuilds it.
   */
  async waitForContainer(containerId: string): Promise<ContainerStatus> {
    for (let i = 0; ; i++) {
      const s = await this.getContainerStatus(containerId);
      if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return s.status_code;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
        throw new PermanentError(`Container ${containerId} ${s.status_code}${s.status ? `: ${s.status}` : ""}`);
      }
      if (i >= this.pollDelays.length) throw new TransientError(`Container ${containerId} still ${s.status_code} after polling`);
      await sleep(this.pollDelays[i]);
    }
  }

  publishContainer(creationId: string): Promise<{ id: string }> {
    return this.request("POST", `${this.igUserId}/media_publish`, { creation_id: creationId });
  }

  async getPublishingLimit(): Promise<{ quota_usage: number; quota_total: number }> {
    const r = await this.request<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(
      "GET",
      `${this.igUserId}/content_publishing_limit`,
      { fields: "quota_usage,config" },
    );
    const row = r.data?.[0];
    return { quota_usage: row?.quota_usage ?? 0, quota_total: row?.config?.quota_total ?? 100 };
  }

  getMedia(mediaId: string): Promise<IgMedia> {
    return this.request("GET", mediaId, {
      fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count",
    });
  }

  async listRecentMedia(limit = 10): Promise<IgMedia[]> {
    const r = await this.request<{ data: IgMedia[] }>("GET", `${this.igUserId}/media`, {
      fields: "id,caption,media_type,permalink,timestamp,like_count,comments_count",
      limit,
    });
    return r.data ?? [];
  }

  // -------------------------------------------------------------- insights
  /**
   * Media insights. Requested one metric at a time on failure so a single
   * unsupported metric (they differ by media type and change across versions)
   * does not lose the rest.
   */
  async getMediaInsights(mediaId: string, metrics: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const read = (r: InsightsResponse) => {
      for (const m of r.data ?? []) out[m.name] = Number(m.values?.[0]?.value ?? m.total_value?.value ?? 0);
    };
    try {
      read(await this.request<InsightsResponse>("GET", `${mediaId}/insights`, { metric: metrics.join(",") }));
      return out;
    } catch (e) {
      if (!(e instanceof PermanentError) && !(e instanceof MetaApiError)) throw e;
    }
    for (const m of metrics) {
      try {
        read(await this.request<InsightsResponse>("GET", `${mediaId}/insights`, { metric: m }));
      } catch (e) {
        if (e instanceof TransientError) throw e;
      }
    }
    return out;
  }

  async getAccountInsights(metrics: string[], since: Date, until: Date): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const m of metrics) {
      try {
        const r = await this.request<InsightsResponse>("GET", `${this.igUserId}/insights`, {
          metric: m,
          period: "day",
          metric_type: "total_value",
          since: Math.floor(since.getTime() / 1000),
          until: Math.floor(until.getTime() / 1000),
        });
        for (const row of r.data ?? []) out[row.name] = Number(row.total_value?.value ?? row.values?.[0]?.value ?? 0);
      } catch (e) {
        if (e instanceof TransientError) throw e;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- tokens
  static async refreshLongLivedToken(
    token: string,
    o: { host?: string; fetchImpl?: FetchLike } = {},
  ): Promise<{ access_token: string; expires_in: number }> {
    const url = new URL(`${(o.host ?? "https://graph.instagram.com").replace(/\/$/, "")}/refresh_access_token`);
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", token);
    const res = await (o.fetchImpl ?? fetch)(url);
    const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: MetaErrorBody };
    if (!res.ok || data.error || !data.access_token) throw classifyMetaError(res.status, "/refresh_access_token", data.error);
    return { access_token: data.access_token, expires_in: data.expires_in ?? 60 * 24 * 3600 };
  }

  /** OAuth code → short-lived token → 60-day token (Instagram Login). */
  static async exchangeCode(
    code: string,
    o: { appId: string; appSecret: string; redirectUri: string; host?: string; fetchImpl?: FetchLike },
  ): Promise<{ accessToken: string; userId: string; expiresIn: number }> {
    const f = o.fetchImpl ?? fetch;
    const short = await f("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: o.appId,
        client_secret: o.appSecret,
        grant_type: "authorization_code",
        redirect_uri: o.redirectUri,
        code,
      }).toString(),
    });
    const s = (await short.json()) as { access_token?: string; user_id?: string | number; error_message?: string };
    if (!short.ok || !s.access_token) throw new PermanentError(`Instagram code exchange failed: ${s.error_message ?? short.status}`);
    const url = new URL(`${(o.host ?? "https://graph.instagram.com").replace(/\/$/, "")}/access_token`);
    url.searchParams.set("grant_type", "ig_exchange_token");
    url.searchParams.set("client_secret", o.appSecret);
    url.searchParams.set("access_token", s.access_token);
    const long = await f(url);
    const l = (await long.json()) as { access_token?: string; expires_in?: number; error?: MetaErrorBody };
    if (!long.ok || !l.access_token) throw classifyMetaError(long.status, "/access_token", l.error);
    return { accessToken: l.access_token, userId: String(s.user_id), expiresIn: l.expires_in ?? 60 * 24 * 3600 };
  }

  static authorizeUrl(o: { appId: string; redirectUri: string; state: string }): string {
    const p = new URLSearchParams({
      client_id: o.appId,
      redirect_uri: o.redirectUri,
      response_type: "code",
      state: o.state,
      scope: [
        "instagram_business_basic",
        "instagram_business_content_publish",
        "instagram_business_manage_comments",
        "instagram_business_manage_messages",
        "instagram_business_manage_insights",
      ].join(","),
    });
    // Instagram Login authorizes on www.instagram.com (api.instagram.com/oauth/authorize 404s).
    return `https://www.instagram.com/oauth/authorize?${p}`;
  }
}

interface InsightsResponse {
  data?: Array<{ name: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }>;
}

interface MetaErrorBody {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
  fbtrace_id?: string;
}

/**
 * Map Meta error codes to retry semantics.
 * https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
export function classifyMetaError(status: number, path: string, err?: MetaErrorBody): Error {
  const code = err?.code ?? status;
  const msg = `Instagram ${path}: ${err?.message ?? `HTTP ${status}`} [code=${code} sub=${err?.error_subcode ?? "-"} trace=${err?.fbtrace_id ?? "-"}]`;
  if (code === 190 || err?.type === "OAuthException" && (err?.error_subcode === 463 || err?.error_subcode === 460)) {
    return new TokenInvalidError(msg);
  }
  if ([4, 17, 32, 368, 613, 80002, 80006].includes(code)) return new RateLimitedError(msg, 15 * 60_000);
  // 9007: media not ready for publishing yet. 1/2: transient API errors.
  if (code === 9007 || code === 1 || code === 2 || status >= 500) return new TransientError(msg);
  return new PermanentError(msg, { code, subcode: err?.error_subcode, status });
}
