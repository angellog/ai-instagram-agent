import { describe, expect, it } from "vitest";
import { PermanentError, RateLimitedError, TransientError } from "../../src/lib/errors.js";
import { classifyXError, readCostUsd, XAuthError, XClient, XCreditsError } from "../../src/x/client.js";
import { FakeX } from "../helpers/fakeX.js";

describe("classifyXError", () => {
  it("maps depleted credits to a permanent, actionable error", () => {
    const e = classifyXError(402, "/2/users/1/mentions", { type: "https://api.x.com/2/problems/credits-depleted", detail: "credits depleted" });
    expect(e).toBeInstanceOf(XCreditsError);
    expect(e).toBeInstanceOf(PermanentError);
    expect(e.message).toMatch(/console\.x\.com/);
  });

  it("maps 401 and 403 to an auth error", () => {
    expect(classifyXError(401, "/p", undefined)).toBeInstanceOf(XAuthError);
    expect(classifyXError(403, "/p", { detail: "client-not-enrolled" })).toBeInstanceOf(XAuthError);
  });

  it("waits until x-rate-limit-reset on 429", () => {
    const now = 1_790_000_000_000;
    const e = classifyXError(429, "/p", undefined, now / 1000 + 90, now) as RateLimitedError;
    expect(e).toBeInstanceOf(RateLimitedError);
    expect(e.retryAfterMs).toBe(90_000);
  });

  it("falls back to 15 minutes when X sends no reset header", () => {
    expect((classifyXError(429, "/p", undefined) as RateLimitedError).retryAfterMs).toBe(15 * 60_000);
  });

  it("retries server errors and gives up on other client errors", () => {
    expect(classifyXError(503, "/p", undefined)).toBeInstanceOf(TransientError);
    const e = classifyXError(400, "/p", { detail: "bad query" });
    expect(e).toBeInstanceOf(PermanentError);
    expect(e).not.toBeInstanceOf(TransientError);
  });
});

describe("readCostUsd", () => {
  it("prices posts and accounts separately", () => {
    expect(readCostUsd({ posts: 20, users: 5 })).toBeCloseTo(0.15, 10);
    expect(readCostUsd({})).toBe(0);
  });
});

describe("XClient", () => {
  it("only ever sends GET requests with the bearer token", async () => {
    const fx = new FakeX();
    fx.mentions = [{ id: "1600000000000000002", text: "@feetbitsneakers hi", author_id: "900" }];
    const c = new XClient("bearer-test", fx.fetch, "https://x.fake");
    await c.userByUsername("@FeetBitSneakers");
    await c.mentions(fx.account.id);
    await c.posts(fx.account.id, { startTime: new Date("2026-09-23T10:00:00.123Z") });
    expect(fx.calls.every((x) => x.method === "GET" && x.auth === "Bearer bearer-test")).toBe(true);
    expect(fx.callsTo(/tweets$/)[0].query.start_time).toBe("2026-09-23T10:00:00Z");
  });

  it("keeps 19-digit ids exact", async () => {
    const fx = new FakeX();
    fx.mentions = [{ id: "1799999999999999999", text: "x", author_id: "900" }];
    const page = await new XClient("b", fx.fetch, "https://x.fake").mentions(fx.account.id);
    expect(page.data[0].id).toBe("1799999999999999999");
    expect(page.newestId).toBe("1799999999999999999");
  });

  it("rejects an invalid username before calling X", async () => {
    const fx = new FakeX();
    await expect(new XClient("b", fx.fetch, "https://x.fake").userByUsername("not a handle!")).rejects.toThrow(/not a valid X username/);
    expect(fx.calls).toHaveLength(0);
  });
});
