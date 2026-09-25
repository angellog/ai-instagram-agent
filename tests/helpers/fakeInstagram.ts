import { InstagramClient } from "../../src/instagram/client.js";
import { TEST_IG_ID } from "./db.js";

/**
 * In-memory Instagram Graph API (Instagram Login flavour) with failure
 * injection. Models the parts of the real API the agent uses, including the
 * container lifecycle (IN_PROGRESS → FINISHED → PUBLISHED) that duplicate
 * protection depends on.
 */

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, any>;
}

type Failure =
  | { kind: "http"; status: number; error?: { message: string; code: number; error_subcode?: number } }
  | { kind: "network" }
  /** Perform the operation, then drop the response (the lost-ack case). */
  | { kind: "lost_response" };

interface Rule {
  method?: string;
  match: RegExp;
  failure: Failure;
  times: number;
}

export class FakeInstagram {
  calls: Call[] = [];
  containers = new Map<string, { status: "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR"; polls: number; params: Record<string, any>; children?: string[] }>();
  media = new Map<string, { id: string; caption: string; permalink: string; timestamp: string; children?: string[] }>();
  replies: Array<{ commentId: string; message: string; id: string }> = [];
  dms: Array<{ recipient: Record<string, string>; text: string; id: string }> = [];
  hidden: string[] = [];
  quotaUsage = 0;
  insights: Record<string, number> = { reach: 500, views: 900, likes: 60, comments: 8, saved: 12, shares: 5, total_interactions: 85, profile_visits: 20, follows: 3 };
  /** Container polls before FINISHED (0 = finished immediately). */
  processingPolls = 1;
  private rules: Rule[] = [];
  private seq = 0;

  failNext(match: RegExp, failure: Failure, times = 1, method?: string): this {
    this.rules.push({ match, failure, times, method });
    return this;
  }

  client(): InstagramClient {
    return new InstagramClient({ accessToken: "test-token", igUserId: TEST_IG_ID, fetchImpl: this.fetch, pollDelaysMs: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
  }

  callsTo(method: string, path: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v[\d.]+/, "");
    const query = Object.fromEntries(url.searchParams.entries());
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call = { method, path, query, body };
    this.calls.push(call);

    const rule = this.rules.find((r) => r.times > 0 && r.match.test(path) && (!r.method || r.method === method));
    if (rule) {
      rule.times--;
      if (rule.failure.kind === "network") throw new TypeError("fetch failed (simulated network error)");
      if (rule.failure.kind === "http") {
        return json({ error: rule.failure.error ?? { message: "simulated failure", code: 1, type: "OAuthException", fbtrace_id: "T" } }, rule.failure.status);
      }
      if (rule.failure.kind === "lost_response") {
        this.route(method, path, query, body);
        throw new TypeError("fetch failed (response lost after the operation)");
      }
    }
    const out = this.route(method, path, query, body);
    return json(out.body, out.status);
  };

  private route(method: string, path: string, query: Record<string, string>, body: Record<string, any>): { status: number; body: unknown } {
    const id = () => String(++this.seq);
    const seg = path.split("/").filter(Boolean);

    if (method === "GET" && seg[0] === "me") return ok({ id: TEST_IG_ID, user_id: TEST_IG_ID, username: "zuri.test", followers_count: 1234, media_count: this.media.size, account_type: "BUSINESS" });

    if (seg[0] === TEST_IG_ID) {
      const sub = seg[1];
      if (method === "POST" && sub === "messages") {
        const mid = `mid_${id()}`;
        this.dms.push({ recipient: body.recipient, text: body.message?.text, id: mid });
        return ok({ recipient_id: body.recipient?.id ?? "x", message_id: mid });
      }
      if (method === "POST" && sub === "media") {
        // Real API rule (observed 2026-09-25): AI label only on the carousel container.
        if (body.is_carousel_item && body.is_ai_generated) {
          return err(400, 100, "AI Label for Carousels should be set at the container and not on individual carousel items");
        }
        const cid = `c_${id()}`;
        const children = body.children ? String(body.children).split(",") : undefined;
        if (children) {
          for (const ch of children) if (!this.containers.has(ch)) return err(400, 100, `child container ${ch} does not exist`);
        }
        this.containers.set(cid, { status: this.processingPolls ? "IN_PROGRESS" : "FINISHED", polls: 0, params: body, children });
        return ok({ id: cid });
      }
      if (method === "POST" && sub === "media_publish") {
        const c = this.containers.get(body.creation_id);
        if (!c) return err(400, 100, "invalid creation_id");
        if (c.status === "PUBLISHED") return err(400, 9007, "The media has already been published");
        if (c.status !== "FINISHED") return err(400, 9007, "Media ID is not available");
        c.status = "PUBLISHED";
        const mid = `m_${id()}`;
        this.media.set(mid, { id: mid, caption: c.params.caption ?? "", permalink: `https://www.instagram.com/p/${mid}/`, timestamp: new Date().toISOString(), children: c.children });
        this.quotaUsage++;
        return ok({ id: mid });
      }
      if (method === "GET" && sub === "content_publishing_limit") return ok({ data: [{ quota_usage: this.quotaUsage, config: { quota_total: 100 } }] });
      if (method === "GET" && sub === "media") return ok({ data: [...this.media.values()].reverse() });
      if (method === "GET" && sub === "insights") return ok({ data: [{ name: query.metric, total_value: { value: 1000 } }] });
    }

    const target = seg[0];
    if (method === "GET" && seg[1] === "insights") {
      if (!this.media.has(target)) return err(400, 100, "unknown media");
      const names = (query.metric ?? "").split(",");
      return ok({ data: names.filter((n) => n in this.insights).map((n) => ({ name: n, values: [{ value: this.insights[n] }] })) });
    }
    if (method === "POST" && seg[1] === "replies") {
      const rid = `r_${id()}`;
      this.replies.push({ commentId: target, message: body.message, id: rid });
      return ok({ id: rid });
    }
    if (method === "GET" && this.containers.has(target)) {
      const c = this.containers.get(target)!;
      if (c.status === "IN_PROGRESS" && ++c.polls > this.processingPolls - 1) c.status = "FINISHED";
      return ok({ status_code: c.status === "IN_PROGRESS" ? "IN_PROGRESS" : c.status, id: target });
    }
    if (method === "GET" && this.media.has(target)) {
      const m = this.media.get(target)!;
      return ok({ ...m, media_type: m.children ? "CAROUSEL_ALBUM" : "IMAGE", like_count: 60, comments_count: 8 });
    }
    if (method === "POST" && seg.length === 1 && "hide" in body) {
      this.hidden.push(target);
      return ok({ success: true });
    }
    if (method === "GET" && seg.length === 1) return ok({ id: target, caption: "An older post made by hand", permalink: `https://www.instagram.com/p/${target}/` });
    return err(404, 803, `fake graph: no route for ${method} ${path}`);
  }
}

const ok = (body: unknown) => ({ status: 200, body });
const err = (status: number, code: number, message: string) => ({ status, body: { error: { message, code, type: "OAuthException", fbtrace_id: "FAKE" } } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function commentPayload(o: { commentId: string; text: string; fromId?: string; username?: string; mediaId?: string; parentId?: string; accountId?: string }) {
  return {
    object: "instagram",
    entry: [
      {
        id: o.accountId ?? TEST_IG_ID,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "comments",
            value: {
              id: o.commentId,
              text: o.text,
              from: { id: o.fromId ?? "9001", username: o.username ?? "kampala_kicks" },
              media: { id: o.mediaId ?? "m_existing", media_product_type: "FEED" },
              ...(o.parentId ? { parent_id: o.parentId } : {}),
            },
          },
        ],
      },
    ],
  };
}

export function dmPayload(o: { mid: string; text: string; senderId?: string; timestamp?: number; echo?: boolean }) {
  return {
    object: "instagram",
    entry: [
      {
        id: TEST_IG_ID,
        time: Math.floor(Date.now() / 1000),
        messaging: [
          {
            sender: { id: o.echo ? TEST_IG_ID : (o.senderId ?? "9002") },
            recipient: { id: o.echo ? (o.senderId ?? "9002") : TEST_IG_ID },
            timestamp: o.timestamp ?? Date.now(),
            message: { mid: o.mid, text: o.text, ...(o.echo ? { is_echo: true } : {}) },
          },
        ],
      },
    ],
  };
}
