/**
 * In-memory TikTok Open API (Login Kit tokens, user info, Content Posting API
 * photo posts and status), with the knobs the tests need: a revoked login, a
 * refused renewal, and a publish that is still processing when first polled.
 */
export class FakeTikTok {
  calls: Array<{ method: string; path: string; body: any; auth?: string }> = [];
  inits: any[] = [];
  refreshes = 0;
  /** Bearer calls fail with access_token_invalid. */
  revoked = false;
  /** Refresh-token grants fail with invalid_grant. */
  refuseRefresh = false;
  /** Status polls that answer PROCESSING_DOWNLOAD before PUBLISH_COMPLETE. */
  processingPolls = 1;
  privacyOptions = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];
  private seq = 0;
  private polls = new Map<string, number>();

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body ? String(init.body) : "";
    const body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    this.calls.push({ method, path: url.pathname, body, auth });

    if (url.pathname === "/v2/oauth/token/") {
      if (body.grant_type === "refresh_token") {
        this.refreshes++;
        if (this.refuseRefresh) return json({ error: "invalid_grant", error_description: "Refresh token is invalid or expired.", log_id: "L" }, 400);
      } else if (body.code !== "good-code") {
        return json({ error: "invalid_grant", error_description: "Authorization code is expired.", log_id: "L" }, 400);
      }
      const n = ++this.seq;
      return json({ access_token: `act.${n}`, expires_in: 86400, open_id: "open-zuri", refresh_token: `rft.${n}`, refresh_expires_in: 31536000, scope: "user.info.basic,video.publish", token_type: "Bearer" });
    }
    if (this.revoked) return json({ data: {}, error: { code: "access_token_invalid", message: "The access token is invalid or not found in the request.", log_id: "L" } }, 401);

    if (url.pathname === "/v2/user/info/") {
      return ok({ user: { open_id: "open-zuri", display_name: "Zuri", username: "zuri.tt", avatar_url: "https://x/a.jpg", follower_count: 12, following_count: 3, likes_count: 40, video_count: 2 } });
    }
    if (url.pathname === "/v2/post/publish/creator_info/query/") {
      return ok({ creator_username: "zuri.tt", creator_nickname: "Zuri", privacy_level_options: this.privacyOptions, comment_disabled: false, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 600 });
    }
    if (url.pathname === "/v2/post/publish/content/init/") {
      this.inits.push(body);
      return ok({ publish_id: `p_pub.${++this.seq}` });
    }
    if (url.pathname === "/v2/post/publish/status/fetch/") {
      const n = (this.polls.get(body.publish_id) ?? 0) + 1;
      this.polls.set(body.publish_id, n);
      if (n <= this.processingPolls) return ok({ status: "PROCESSING_DOWNLOAD" });
      // Sent as a raw 19-digit JSON number, exactly as TikTok does (JavaScript can't hold it).
      return new Response('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7450000000000000001]},"error":{"code":"ok","message":"","log_id":"L"}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return json({ data: {}, error: { code: "not_found", message: `fake tiktok: no route ${method} ${url.pathname}` } }, 404);
  };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const ok = (data: unknown) => json({ data, error: { code: "ok", message: "", log_id: "L" } });
