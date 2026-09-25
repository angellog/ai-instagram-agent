import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/web/server.js";
import { hmacSha256Hex } from "../../src/lib/crypto.js";
import { signRelay } from "../../src/ingest/webhook.js";
import { many, one } from "../../src/db/pool.js";
import { queue } from "../../src/queue/queues.js";
import { commentPayload } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

let app: FastifyInstance;
beforeEach(async () => {
  await resetState();
  app ??= await buildServer();
});
afterAll(async () => {
  await app?.close();
  await teardown();
});

const post = (url: string, body: string, headers: Record<string, string>) =>
  app.inject({ method: "POST", url, payload: body, headers: { "content-type": "application/json", ...headers } });

describe("Meta webhook endpoint", () => {
  it("answers the verification handshake only with the right token", async () => {
    const ok = await app.inject({ url: "/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42" });
    expect([ok.statusCode, ok.body]).toEqual([200, "42"]);
    expect((await app.inject({ url: "/webhooks/instagram?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42" })).statusCode).toBe(403);
  });

  it("stores a signed event, queues it, and treats a redelivery as a duplicate", async () => {
    const body = JSON.stringify(commentPayload({ commentId: "c100", text: "clean pair!" }));
    const sig = `sha256=${hmacSha256Hex("test-ig-secret", body)}`;
    const r1 = await post("/webhooks/instagram", body, { "x-hub-signature-256": sig });
    expect(r1.statusCode).toBe(200);
    const r2 = await post("/webhooks/instagram", body, { "x-hub-signature-256": sig });
    expect(r2.json()).toMatchObject({ duplicate: true });
    const rows = await many("SELECT source FROM webhook_events");
    expect(rows).toEqual([{ source: "meta" }]);
    expect(await queue("events").getJobCounts("waiting")).toMatchObject({ waiting: 1 });
  });

  it("rejects bad signatures and records the attempt", async () => {
    const r = await post("/webhooks/instagram", JSON.stringify({ object: "instagram", entry: [] }), { "x-hub-signature-256": "sha256=deadbeef" });
    expect(r.statusCode).toBe(401);
    expect(await one("SELECT message FROM system_events WHERE source = 'webhook'")).toMatchObject({ message: expect.stringContaining("signature") });
    expect(await many("SELECT 1 FROM webhook_events")).toHaveLength(0);
  });
});

describe("OpenReply relay endpoint", () => {
  it("accepts a correctly signed relay and rejects a forged one", async () => {
    const body = JSON.stringify(commentPayload({ commentId: "c200", text: "which size?" }));
    expect((await post("/webhooks/openreply", body, { "x-openreply-signature": signRelay(body, "relay-secret") })).statusCode).toBe(200);
    expect((await post("/webhooks/openreply", body, { "x-openreply-signature": signRelay(body, "guess") })).statusCode).toBe(401);
    expect(await many("SELECT source FROM webhook_events")).toEqual([{ source: "openreply_relay" }]);
  });
});

describe("health and auth", () => {
  it("reports database and redis health", async () => {
    const r = await app.inject({ url: "/health" });
    expect(r.json()).toMatchObject({ ok: true, checks: { database: "ok", redis: "ok" } });
  });
  it("serves the JSON status API", async () => {
    const r = await app.inject({ url: "/api/status" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mode: "autonomous", account: { igUserId: expect.any(String) } });
  });
  it("renders every dashboard page", async () => {
    for (const url of ["/admin", "/admin/reviews", "/admin/posts", "/admin/content", "/admin/conversations", "/admin/people", "/admin/costs", "/admin/events", "/admin/controls", "/admin/persona"]) {
      const r = await app.inject({ url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body).toContain("<main>");
    }
  });
  it("updates controls from the form and validates them", async () => {
    const ok = await app.inject({ method: "POST", url: "/admin/controls", payload: "mode=dry_run&max_posts_per_day=3", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(ok.statusCode).toBe(303);
    expect(await one("SELECT value FROM controls WHERE key = 'max_posts_per_day'")).toEqual({ value: 3 });
    const bad = await app.inject({ method: "POST", url: "/admin/controls", payload: "mode=yolo", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(decodeURIComponent(bad.headers.location as string)).toMatch(/Not saved/);
  });
});

describe("retry production", () => {
  it("resets a failed post to draft and queues production", async () => {
    await one("INSERT INTO content_ideas (id, format, structure, topic, hook, status) VALUES (1, 'single', 'moment', 't', 'h', 'failed')");
    const p = await one<{ id: string }>("INSERT INTO posts (content_idea_id, media_type, caption, status) VALUES (1, 'IMAGE', 'c', 'qc_failed') RETURNING id");
    const r = await app.inject({ method: "POST", url: `/admin/posts/${p!.id}/retry` });
    expect(decodeURIComponent(r.headers.location as string)).toMatch(/Production restarted/);
    expect(await one("SELECT status FROM posts WHERE id = $1", [p!.id])).toEqual({ status: "draft" });
    expect(await one("SELECT status FROM content_ideas WHERE id = 1")).toEqual({ status: "accepted" });
    expect((await queue("content").getJobs(["waiting"])).map((j) => j.name)).toContain("content.produce");
    const again = await app.inject({ method: "POST", url: `/admin/posts/${p!.id}/retry` });
    expect(decodeURIComponent(again.headers.location as string)).toMatch(/Only failed posts/);
  });
});

describe("remove slide", () => {
  it("removes one slide from a draft and compacts positions; never below one image", async () => {
    const { removeSlide } = await import("../../src/web/admin.js");
    const p = await one<{ id: string }>("INSERT INTO posts (media_type, caption, status) VALUES ('CAROUSEL', 'c', 'awaiting_review') RETURNING id");
    for (const i of [0, 1, 2]) await one("INSERT INTO post_assets (post_id, position, public_url) VALUES ($1, $2, $3)", [p!.id, i, `https://x/${i}.jpg`]);
    expect(await removeSlide(p!.id, 1)).toBe("Removed slide 2; 2 left");
    expect(await many("SELECT position, public_url FROM post_assets WHERE post_id = $1 ORDER BY position", [p!.id])).toEqual([
      { position: 0, public_url: "https://x/0.jpg" },
      { position: 1, public_url: "https://x/2.jpg" },
    ]);
    expect(await removeSlide(p!.id, 0)).toBe("Removed slide 1; 1 left");
    expect(await one("SELECT media_type FROM posts WHERE id = $1", [p!.id])).toEqual({ media_type: "IMAGE" });
    expect(await removeSlide(p!.id, 0)).toBe("A post needs at least one image");
    await one("UPDATE posts SET status = 'published' WHERE id = $1", [p!.id]);
    expect(await removeSlide(p!.id, 0)).toMatch(/can't be changed/);
  });
});
