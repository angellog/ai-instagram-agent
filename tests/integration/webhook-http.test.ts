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
