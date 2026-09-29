import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setControls } from "../../src/config/controls.js";
import { clearSetting, setSetting } from "../../src/config/settings.js";
import { withInfluencer } from "../../src/context.js";
import { recordCost } from "../../src/cost/ledger.js";
import { many, one } from "../../src/db/pool.js";
import { RateLimitedError } from "../../src/lib/errors.js";
import { HANDLERS } from "../../src/queue/worker.js";
import { JOBS } from "../../src/queue/queues.js";
import { setXFetch } from "../../src/x/accounts.js";
import { XCreditsError } from "../../src/x/client.js";
import { collectXMetrics } from "../../src/x/metrics.js";
import { pollMentions } from "../../src/x/poll.js";
import { buildServer } from "../../src/web/server.js";
import { FakeX } from "../helpers/fakeX.js";
import { resetState, teardown } from "../helpers/db.js";

let app: FastifyInstance;
let fx: FakeX;
beforeEach(async () => {
  await resetState({ mode: "human_approval" });
  fx = new FakeX();
  setXFetch(fx.fetch, "https://x.fake");
  await setSetting("X_BEARER_TOKEN", "bearer-test");
  app ??= await buildServer();
});
afterAll(async () => {
  setXFetch(undefined);
  await app?.close();
  await teardown();
});

const get = (url: string) => app.inject({ url });
const form = (url: string, body: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const flash = (r: { headers: Record<string, unknown> }) => new URLSearchParams(String(r.headers.location ?? "").split("?")[1]?.split("#")[0] ?? "").get("flash") ?? "";
const poll = () => withInfluencer(1, pollMentions);
const mention = (id: string, text = "@feetbitsneakers do you have AJ1s in 42?", author = "900") => ({ id, text, author_id: author });

async function connect(): Promise<void> {
  const r = await form("/admin/x/connect", { username: "@feetbitsneakers" });
  expect(flash(r)).toMatch(/^Watching @feetbitsneakers/);
}

describe("connecting an X account", () => {
  it("asks for the bearer token first, then a username", async () => {
    await clearSetting("X_BEARER_TOKEN");
    expect((await get("/admin/x")).body).toContain("Add your X bearer token");
    await setSetting("X_BEARER_TOKEN", "bearer-test");
    expect((await get("/admin/x")).body).toContain("Connect an account");
  });

  it("looks the account up by username and records the read", async () => {
    await connect();
    const acct = await one<{ x_user_id: string; username: string; stats: { followers: number } }>("SELECT * FROM x_accounts WHERE influencer_id = 1");
    expect(acct).toMatchObject({ x_user_id: "1500000000000000001", username: "feetbitsneakers", stats: { followers: 1200 } });
    const cost = await one<{ operation: string; cost_usd: number }>("SELECT operation, cost_usd FROM cost_ledger WHERE provider = 'x'");
    expect(cost).toMatchObject({ operation: "x.read.user", cost_usd: 0.01 });
  });

  it("explains an unknown username instead of failing silently", async () => {
    const r = await form("/admin/x/connect", { username: "nobody_here" });
    expect(flash(r)).toMatch(/no account @nobody_here/);
    expect(await one("SELECT 1 FROM x_accounts")).toBeUndefined();
  });
});

describe("polling mentions", () => {
  it("does nothing, and calls nothing, for an influencer without an X account", async () => {
    expect(await poll()).toEqual({ skipped: "No X account connected" });
    expect(fx.calls).toHaveLength(0);
  });

  it("stores new mentions, skips our own posts, and moves the since_id cursor forward", async () => {
    await connect();
    fx.mentions = [mention("1600000000000000003"), mention("1600000000000000002", "@feetbitsneakers self tag", fx.account.id), mention("1600000000000000001", "@feetbitsneakers love the Voodoos")];
    expect(await poll()).toMatchObject({ fetched: 3, inserted: 2 });
    const rows = await many<{ tweet_id: string; author_username: string; status: string }>("SELECT tweet_id, author_username, status FROM x_mentions ORDER BY tweet_id");
    expect(rows.map((r) => r.tweet_id)).toEqual(["1600000000000000001", "1600000000000000003"]);
    expect(rows[0]).toMatchObject({ author_username: "sneakerfan", status: "new" });
    expect((await one<{ mentions_since_id: string }>("SELECT mentions_since_id FROM x_accounts"))!.mentions_since_id).toBe("1600000000000000003");

    fx.mentions.unshift(mention("1600000000000000004", "@feetbitsneakers delivery to Entebbe?"));
    expect(await poll()).toMatchObject({ fetched: 1, inserted: 1 });
    expect(fx.callsTo(/mentions$/).at(-1)!.query.since_id).toBe("1600000000000000003");
  });

  it("is idempotent: the same mention twice is stored once", async () => {
    await connect();
    fx.mentions = [mention("1600000000000000001")];
    await poll();
    await one("UPDATE x_accounts SET mentions_since_id = NULL");
    expect(await poll()).toMatchObject({ fetched: 1, inserted: 0 });
    expect((await many("SELECT 1 FROM x_mentions")).length).toBe(1);
  });

  it("backfills a single page on the first poll, then pages through everything new", async () => {
    await connect();
    const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => mention(String(1600000000000000000n + BigInt(from + count - i))));
    fx.mentions = ids(0, 45);
    expect(await poll()).toMatchObject({ fetched: 20, pages: 1 });
    fx.mentions = [...ids(45, 30), ...fx.mentions];
    expect(await poll()).toMatchObject({ fetched: 30, inserted: 30, pages: 2, truncated: false });
  });

  it("skips quietly when X is switched off, the token is missing, or the day's read cap is used up", async () => {
    await connect();
    fx.calls = [];
    await setControls({ x_enabled: false }, "test");
    expect(await poll()).toEqual({ skipped: "X is switched off in Controls" });
    await setControls({ x_enabled: true, x_daily_read_cap: 1 }, "test");
    expect(await poll()).toMatchObject({ skipped: expect.stringMatching(/read cap reached/) });
    expect(fx.calls).toHaveLength(0);
    expect((await one<{ last_poll_note: string }>("SELECT last_poll_note FROM x_accounts"))!.last_poll_note).toMatch(/^Skipped: X daily read cap/);
  });

  it("stops at the daily X budget", async () => {
    await connect();
    await setControls({ daily_x_api_budget_usd: 0.05 }, "test");
    await withInfluencer(1, () => recordCost({ category: "api", provider: "x", operation: "x.read.mentions", units: { posts: 0 }, costUsd: 0.049 }));
    fx.calls = [];
    expect(await poll()).toMatchObject({ skipped: expect.stringMatching(/Daily X API budget/) });
    expect(fx.calls).toHaveLength(0);
  });

  it("backs off until X's rate-limit reset, and fails loudly on depleted credits", async () => {
    await connect();
    fx.rateLimitUntil = Math.floor(Date.now() / 1000) + 120;
    const e = await poll().catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitedError);
    expect(e.retryAfterMs).toBeGreaterThan(100_000);
    fx.creditsDepleted = true;
    await expect(poll()).rejects.toBeInstanceOf(XCreditsError);
  });

  it("runs as a scheduled job across influencers without failing for those with no X", async () => {
    await connect();
    fx.mentions = [mention("1600000000000000001")];
    const out = (await HANDLERS[JOBS.xPoll]({ data: {} } as never)) as Record<string, unknown>;
    expect(Object.values(out)).toEqual([expect.objectContaining({ inserted: 1 })]);
  });
});

describe("metrics", () => {
  it("snapshots followers and recent posts once per day, updating on rerun", async () => {
    await connect();
    fx.posts = [{ id: "1700000000000000001", text: "We went quiet for a while.", created_at: "2026-09-29T21:03:00.000Z", public_metrics: { impression_count: 812, like_count: 31, reply_count: 9, retweet_count: 4, quote_count: 1, bookmark_count: 6 } }];
    expect(await withInfluencer(1, collectXMetrics)).toEqual({ posts: 1, followers: 1200 });
    fx.posts[0].public_metrics.like_count = 40;
    fx.account.followers = 1210;
    await withInfluencer(1, collectXMetrics);
    const rows = await many<{ likes: number; impressions: number }>("SELECT likes, impressions FROM x_post_metrics");
    expect(rows).toEqual([{ likes: 40, impressions: 812 }]);
    expect((await one<{ followers: number }>("SELECT followers FROM x_account_metrics"))!.followers).toBe(1210);
  });
});

describe("the X page", () => {
  it("shows mentions, post metrics and today's read spend, and marks mentions seen", async () => {
    await connect();
    fx.mentions = [mention("1600000000000000001", "@feetbitsneakers restock Kayanos please")];
    fx.posts = [{ id: "1700000000000000001", text: "Kayano 14 face-off", created_at: "2026-09-29T21:03:00.000Z", public_metrics: { impression_count: 500, like_count: 12, reply_count: 7, retweet_count: 1, quote_count: 0, bookmark_count: 2 } }];
    expect(flash(await form("/admin/x/poll"))).toBe("1 new mention");
    expect(flash(await form("/admin/x/metrics"))).toBe("Measured 1 post");
    const page = (await get("/admin/x")).body;
    expect(page).toContain("restock Kayanos please");
    expect(page).toContain("@sneakerfan");
    expect(page).toContain("Kayano 14 face-off");
    expect(page).toMatch(/X reads today/);
    expect(flash(await form("/admin/x/seen"))).toBe("1 marked seen");
  });

  it("never sends anything but reads to X", async () => {
    await connect();
    fx.mentions = [mention("1600000000000000001")];
    await form("/admin/x/poll");
    await form("/admin/x/metrics");
    expect(fx.calls.length).toBeGreaterThan(0);
    expect(fx.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
