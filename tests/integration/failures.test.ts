import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";
import { closeDb, db, many, one } from "../../src/db/pool.js";
import { resetEnvCache } from "../../src/config/env.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { processWebhookEvent } from "../../src/ingest/process.js";
import { storeWebhookEvent } from "../../src/ingest/webhook.js";
import { processInteraction } from "../../src/conversation/agent.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { createDevMockProvider } from "../../src/llm/devMock.js";
import { MockProvider } from "../../src/llm/providers.js";
import { runJob, backoffStrategy } from "../../src/queue/worker.js";
import { closeQueues, JOBS } from "../../src/queue/queues.js";
import { sweep } from "../../src/queue/sweeper.js";
import { setControls } from "../../src/config/controls.js";
import { RateLimitedError } from "../../src/lib/errors.js";
import { buildServer } from "../../src/web/server.js";
import { hmacSha256Hex } from "../../src/lib/crypto.js";
import { FakeInstagram, commentPayload, dmPayload } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

let fake: FakeInstagram;
beforeEach(async () => {
  await resetState();
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
});
afterAll(() => teardown());

async function ingest(payload: object): Promise<number> {
  const raw = JSON.stringify(payload);
  const ev = await storeWebhookEvent("meta", raw, payload);
  await processWebhookEvent(ev!.id);
  return (await one<{ id: number }>("SELECT id FROM interactions WHERE webhook_event_id = $1", [ev!.id]))!.id;
}

const job = (name: string, data: object) => ({ name, data, id: "t", attemptsMade: 0, opts: {} }) as unknown as Job;

describe("Instagram API failure", () => {
  it("retries a reply Meta rejected with 5xx, and sends exactly once", async () => {
    fake.failNext(/replies/, { kind: "http", status: 500, error: { message: "Service temporarily unavailable", code: 2 } });
    const id = await ingest(commentPayload({ commentId: "c1", text: "what are you reading this week?" }));
    await expect(processInteraction(id)).rejects.toThrow(/Service temporarily unavailable/);
    expect(await one("SELECT status, error FROM messages WHERE direction = 'out'")).toMatchObject({ status: "failed", error: expect.stringMatching(/^retryable/) });
    expect(await processInteraction(id)).toBe("replied");
    expect(fake.replies).toHaveLength(1);
  });

  it("does not resend when the outcome of a send is unknown (network drop)", async () => {
    fake.failNext(/replies/, { kind: "lost_response" });
    const id = await ingest(commentPayload({ commentId: "c2", text: "is that the rooftop in Kololo?" }));
    expect(await processInteraction(id)).toBe("failed");
    await one("UPDATE interactions SET status = 'processing' WHERE id = $1", [id]);
    await processInteraction(id);
    expect(fake.replies).toHaveLength(1); // the one that went through; never a duplicate
  });

  it("backs off for Meta rate limits instead of hammering", () => {
    expect(backoffStrategy(1, "smart", new RateLimitedError("x", 900_000))).toBe(900_000);
    expect(backoffStrategy(3, "smart", new Error("x"))).toBe(40_000);
  });
});

describe("LLM failures", () => {
  it("a timed-out model leaves the interaction retryable; the sweeper re-queues it", async () => {
    setLLM(new LLM(new MockProvider(() => new Promise(() => {})), 50));
    const id = await ingest(dmPayload({ mid: "mid.t1", text: "hello there" }));
    await expect(processInteraction(id)).rejects.toThrow(/timed out/);
    expect(await one("SELECT status FROM interactions WHERE id = $1", [id])).toEqual({ status: "processing" });
    await one("UPDATE interactions SET updated_at = now() - interval '20 minutes' WHERE id = $1", [id]);
    expect(await sweep()).toMatchObject({ interactions: 1 });
    setLLM(new LLM(createDevMockProvider()));
    expect(await processInteraction(id)).toBe("replied");
  });

  it("malformed output twice becomes an unrecoverable job, not endless retries", async () => {
    setLLM(new LLM(createDevMockProvider().on("conversation.classify", () => "not json at all").on("conversation.classify.repair", () => "still not json")));
    const id = await ingest(dmPayload({ mid: "mid.m1", text: "yo" + " what's up" }));
    await expect(runJob(job(JOBS.conversationProcess, { interactionId: id }))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("budget exhaustion stops LLM spend before the call", async () => {
    const mock = createDevMockProvider();
    setLLM(new LLM(mock));
    await setControls({ daily_llm_budget_usd: 0 });
    const id = await ingest(dmPayload({ mid: "mid.b1", text: "hey, quick question about suede" }));
    await expect(runJob(job(JOBS.conversationProcess, { interactionId: id }))).rejects.toThrow(/budget/i);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("duplicate webhooks", () => {
  it("the same event twice creates one interaction and one reply", async () => {
    const payload = commentPayload({ commentId: "dup1", text: "clean pair!" });
    const a = await storeWebhookEvent("meta", JSON.stringify(payload), payload);
    const b = await storeWebhookEvent("meta", JSON.stringify(payload), payload);
    expect(b).toBeUndefined();
    // Same comment, different envelope (e.g. relayed by OpenReply): deduped at the interaction level.
    const relayed = { ...payload, entry: [{ ...payload.entry[0], time: payload.entry[0].time + 5 }] };
    const c = await storeWebhookEvent("openreply_relay", JSON.stringify(relayed), relayed);
    await processWebhookEvent(a!.id);
    expect(await processWebhookEvent(c!.id)).toEqual({ queued: 0, skipped: 1 });
    expect(await many("SELECT 1 FROM interactions")).toHaveLength(1);
  });
});

describe("infrastructure failures", () => {
  it("Redis down: the webhook answers 503 so Meta retries, and nothing half-stored remains", async () => {
    await closeQueues();
    process.env.REDIS_URL = "redis://localhost:6399/0";
    resetEnvCache();
    const app = await buildServer();
    try {
      const body = JSON.stringify(commentPayload({ commentId: "r1", text: "hi" }));
      const r = await app.inject({ method: "POST", url: "/webhooks/instagram", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${hmacSha256Hex("test-ig-secret", body)}` } });
      expect(r.statusCode).toBe(503);
      expect(await many("SELECT 1 FROM webhook_events")).toHaveLength(0);
      expect((await app.inject({ url: "/health" })).statusCode).toBe(503);
    } finally {
      await app.close();
      await closeQueues();
      process.env.REDIS_URL = "redis://localhost:6379/6";
      resetEnvCache();
    }
  });

  it("Database down: health reports 503 and webhooks fail loudly (Meta retries)", async () => {
    await closeDb();
    process.env.DATABASE_URL = "postgresql://localhost:5999/nope";
    resetEnvCache();
    const app = await buildServer();
    try {
      expect((await app.inject({ url: "/health" })).json()).toMatchObject({ ok: false, checks: { database: expect.any(String), redis: "ok" } });
      const body = JSON.stringify(commentPayload({ commentId: "d1", text: "hi" }));
      const r = await app.inject({ method: "POST", url: "/webhooks/instagram", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${hmacSha256Hex("test-ig-secret", body)}` } });
      expect(r.statusCode).toBe(500);
    } finally {
      await app.close();
      await closeDb();
      process.env.DATABASE_URL = "postgresql://localhost:5432/aia_test";
      resetEnvCache();
      await db().query("SELECT 1");
    }
  });
});
