import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setControls } from "../../src/config/controls.js";
import { withInfluencer } from "../../src/context.js";
import { postingGate } from "../../src/content/director.js";
import { publishPost } from "../../src/content/publish.js";
import { storyGate } from "../../src/content/stories.js";
import { many, one } from "../../src/db/pool.js";
import { evaluate } from "../../src/influencers/standard.js";
import { setInstagramClient, setInstagramFetch } from "../../src/instagram/accounts.js";
import { syncProfile } from "../../src/instagram/profileSync.js";
import { persona } from "../../src/persona/loader.js";
import { buildServer } from "../../src/web/server.js";
import { FakeInstagram } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

/**
 * Regression: overnight Meta ended the sessions of all four accounts (code 190).
 * Posts kept being planned and photographed, then failed to publish, and nobody
 * was told. Now the account is marked disconnected once, everything that needs
 * Instagram stops cleanly, and a reconnect brings held posts back to Reviews.
 */
let app: FastifyInstance;
let fake: FakeInstagram;
beforeEach(async () => {
  await resetState({ mode: "autonomous", posting_window_start_hour: 0, posting_window_end_hour: 24 });
  setInstagramClient(undefined); // the real per-account client…
  fake = new FakeInstagram();
  setInstagramFetch(fake.fetch); // …talking to the fake API
  app ??= await buildServer();
});
afterAll(async () => {
  setInstagramFetch(undefined);
  await app?.close();
  await teardown();
});

const SESSION_ENDED = {
  kind: "http" as const,
  status: 400,
  error: { message: "Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.", code: 190 },
};

async function approvedPost(): Promise<string> {
  const p = (await one<{ id: string }>("INSERT INTO posts (influencer_id, media_type, caption, status, safety_level) VALUES (1, 'IMAGE', 'golden hour > everything', 'approved', 'green') RETURNING id"))!;
  await one("INSERT INTO post_assets (post_id, position, public_url, width, height) VALUES ($1, 0, 'https://x/1.jpg', 1080, 1350)", [p.id]);
  return p.id;
}
const form = (url: string, body: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("when Meta ends an account's session (code 190)", () => {
  it("marks the account disconnected once, holds the post, and stops calling Meta", async () => {
    const first = await approvedPost();
    fake.failNext(/\/media$/, SESSION_ENDED, 5, "POST");
    expect(await withInfluencer(1, () => publishPost(first))).toBe("deferred");
    const acct = await one<{ token_status: string; token_error: string }>("SELECT token_status, token_error FROM ig_accounts WHERE influencer_id = 1");
    expect(acct).toMatchObject({ token_status: "invalid", token_error: expect.stringContaining("session has been invalidated") });
    expect(await one<{ status: string; last_error: string }>("SELECT status, last_error FROM posts WHERE id = $1", [first])).toMatchObject({ status: "failed", last_error: expect.stringMatching(/^Instagram disconnected/) });

    // A second post: no call to Meta at all, and no second alert.
    const calls = fake.calls.length;
    const second = await approvedPost();
    expect(await withInfluencer(1, () => publishPost(second))).toBe("deferred");
    expect(fake.calls.length).toBe(calls);
    const alerts = await many("SELECT 1 FROM system_events WHERE message LIKE 'Instagram disconnected for%'");
    expect(alerts).toHaveLength(1);

    // Nothing is planned or made for an account that can't post; the hourly sync stays quiet.
    await withInfluencer(1, async () => {
      const c = await (await import("../../src/config/controls.js")).getControls(true);
      expect(await postingGate(c, persona(), new Date())).toMatch(/^Instagram disconnected for @zuri\.test/);
      expect(await storyGate(c, persona(), new Date(), false)).toMatch(/^Instagram disconnected/);
      expect(await syncProfile()).toBeUndefined();
    });
    expect(fake.calls.length).toBe(calls);
  });

  it("says so everywhere: a banner on every page, the Instagram card, the influencer card and the Standard", async () => {
    await one("UPDATE ig_accounts SET token_status = 'invalid', token_invalid_at = now(), token_error = 'code 190' WHERE influencer_id = 1");
    for (const url of ["/admin", "/admin/posts", "/admin/stories"]) {
      expect((await app.inject({ url })).body, url).toContain("Instagram is disconnected for Zuri");
    }
    expect((await app.inject({ url: "/admin/persona" })).body).toMatch(/Disconnected [^<]*<\/b> Meta ended this token/);
    expect((await app.inject({ url: "/admin/influencers" })).body).toContain('class="pill bad">disconnected');
    expect((await evaluate(1)).checks.find((c) => c.key === "instagram")).toMatchObject({ ok: false, detail: expect.stringContaining("disconnected") });
  });

  it("a reconnect clears it and brings held posts back to Reviews (never auto-published)", async () => {
    const held = await approvedPost();
    fake.failNext(/\/media$/, SESSION_ENDED, 1, "POST");
    await withInfluencer(1, () => publishPost(held));
    expect((await one<{ token_status: string }>("SELECT token_status FROM ig_accounts WHERE influencer_id = 1"))!.token_status).toBe("invalid");

    // A post that failed on the dead token before disconnections were tracked (raw Meta error).
    const legacy = await approvedPost();
    await one("UPDATE posts SET status = 'failed', last_error = 'TokenInvalidError: Instagram /v25.0/1/media: Error validating access token [code=190 sub=0 trace=X]' WHERE id = $1", [legacy]);
    const r = await form("/admin/instagram/attach", { token: "IGAA-new-token-after-reconnect" });
    expect(r.statusCode).toBe(303);
    expect((await one<{ token_status: string }>("SELECT token_status FROM ig_accounts WHERE influencer_id = 1"))!.token_status).toBe("ok");
    expect(await one("SELECT status, last_error FROM posts WHERE id = $1", [held])).toEqual({ status: "awaiting_review", last_error: null });
    expect(await one("SELECT status FROM posts WHERE id = $1", [legacy])).toEqual({ status: "awaiting_review" });
    const review = await one<{ status: string; categories: string[] }>("SELECT status, categories FROM safety_reviews WHERE subject_id = $1", [held]);
    expect(review).toMatchObject({ status: "pending", categories: ["held_while_disconnected"] });
    expect(fake.containers.size).toBe(0); // nothing went out on its own
    // The banner is gone (the Warnings list keeps the history of what happened).
    expect((await app.inject({ url: "/admin" })).body).not.toContain("Instagram is disconnected for Zuri");
  });
});
