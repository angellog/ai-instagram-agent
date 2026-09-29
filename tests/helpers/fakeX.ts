/**
 * In-memory X API v2 (read endpoints only), with the knobs the tests need:
 * rate limiting with a reset header, depleted credits, a revoked token, and a
 * mention timeline that honours since_id and paginates newest-first.
 */
export interface FakeMention {
  id: string;
  text: string;
  author_id: string;
  created_at?: string;
}

export class FakeX {
  calls: Array<{ method: string; path: string; query: Record<string, string>; auth?: string }> = [];
  account = { id: "1500000000000000001", username: "feetbitsneakers", name: "FeetBit", followers: 1200 };
  users = new Map<string, { id: string; username: string; name: string }>([["900", { id: "900", username: "sneakerfan", name: "Sneaker Fan" }]]);
  /** Newest first, like the API. */
  mentions: FakeMention[] = [];
  posts: Array<{ id: string; text: string; created_at: string; public_metrics: Record<string, number> }> = [];
  /** Next call answers 429 with this x-rate-limit-reset (epoch seconds). */
  rateLimitUntil?: number;
  creditsDepleted = false;
  revoked = false;

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    this.calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth });

    if (method !== "GET") return json({ title: "Forbidden", detail: "fake x: read-only" }, 403);
    if (this.revoked) return json({ title: "Unauthorized", type: "about:blank", status: 401, detail: "Unauthorized" }, 401);
    if (this.creditsDepleted) return json({ title: "CreditsDepleted", type: "https://api.x.com/2/problems/credits-depleted", detail: "credits depleted", status: 402 }, 402);
    if (this.rateLimitUntil) {
      const reset = this.rateLimitUntil;
      this.rateLimitUntil = undefined;
      return json({ title: "Too Many Requests", detail: "Too Many Requests", status: 429 }, 429, { "x-rate-limit-reset": String(reset) });
    }

    let m: RegExpMatchArray | null;
    if ((m = url.pathname.match(/^\/2\/users\/by\/username\/(\w+)$/))) {
      if (m[1].toLowerCase() !== this.account.username) return json({ errors: [{ detail: `Could not find user with username: [${m[1]}].`, title: "Not Found Error" }] });
      return json({ data: this.userObj() });
    }
    if ((m = url.pathname.match(/^\/2\/users\/(\d+)\/mentions$/))) {
      const since = url.searchParams.get("since_id");
      const size = Number(url.searchParams.get("max_results") ?? 10);
      const start = Number(url.searchParams.get("pagination_token") ?? 0);
      // Snowflakes compare as numbers; BigInt keeps all 19 digits.
      const all = this.mentions.filter((x) => !since || BigInt(x.id) > BigInt(since));
      const page = all.slice(start, start + size);
      if (!page.length) return json({ meta: { result_count: 0 } });
      const authors = [...new Set(page.map((x) => x.author_id))].map((id) => (id === this.account.id ? { id, username: this.account.username, name: this.account.name } : this.users.get(id))).filter(Boolean);
      return json({
        data: page.map((x) => ({ ...x, created_at: x.created_at ?? "2026-09-30T10:00:00.000Z", conversation_id: x.id, lang: "en" })),
        includes: { users: authors },
        meta: { newest_id: page[0].id, oldest_id: page[page.length - 1].id, result_count: page.length, ...(start + size < all.length ? { next_token: String(start + size) } : {}) },
      });
    }
    if ((m = url.pathname.match(/^\/2\/users\/(\d+)\/tweets$/))) {
      if (!this.posts.length) return json({ meta: { result_count: 0 } });
      return json({ data: this.posts, meta: { newest_id: this.posts[0].id, result_count: this.posts.length } });
    }
    if ((m = url.pathname.match(/^\/2\/users\/(\d+)$/))) {
      return json({ data: this.userObj() });
    }
    return json({ title: "Not Found", detail: `fake x: no route ${method} ${url.pathname}` }, 404);
  };

  private userObj() {
    return {
      id: this.account.id,
      username: this.account.username,
      name: this.account.name,
      profile_image_url: "https://pbs.twimg.com/a.jpg",
      public_metrics: { followers_count: this.account.followers, following_count: 80, tweet_count: 340, listed_count: 2 },
    };
  }

  callsTo(path: RegExp) {
    return this.calls.filter((c) => path.test(c.path));
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
