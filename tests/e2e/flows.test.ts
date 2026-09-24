import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import type { FastifyInstance } from "fastify";
import { many, one } from "../../src/db/pool.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { signRelay } from "../../src/ingest/webhook.js";
import { JOBS, jobId, queue } from "../../src/queue/queues.js";
import { startWorkers } from "../../src/queue/worker.js";
import { buildServer } from "../../src/web/server.js";
import { KieClient } from "../../src/kie/client.js";
import { KieImageGenerator, setImageGenerator } from "../../src/kie/generator.js";
import { setStorageFetch } from "../../src/storage/host.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { createDevMockProvider } from "../../src/llm/devMock.js";
import { FakeInstagram, commentPayload } from "../helpers/fakeInstagram.js";
import { FakeKie } from "../helpers/fakeKie.js";
import { resetState, teardown, waitFor } from "../helpers/db.js";

let workers: Worker[] = [];
let app: FastifyInstance;
let fake: FakeInstagram;

beforeEach(async () => {
  await resetState();
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
  workers = startWorkers();
  app ??= await buildServer();
});
afterEach(async () => {
  await Promise.all(workers.map((w) => w.close()));
});
afterAll(async () => {
  await app?.close();
  await teardown();
});

/** Exactly what OpenReply's relay sends (see openreply lib/agent-relay.ts). */
function relay(payload: object) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: "POST",
    url: "/webhooks/openreply",
    payload: body,
    headers: { "content-type": "application/json", "x-openreply-signature": signRelay(body, "relay-secret") },
  });
}

describe("E2E: Instagram comment → event → OpenReply → worker → memory → LLM → response → Instagram API → memory update", () => {
  it("answers, remembers, and uses the memory next time", async () => {
    const mock = createDevMockProvider();
    setLLM(new LLM(mock));

    const r = await relay(commentPayload({ commentId: "e2e_c1", fromId: "5551", username: "kampala_kicks", text: "I love Air Max 90s, what should I pair them with?" }));
    expect(r.statusCode).toBe(200);

    await waitFor(() => (fake.replies.length === 1 ? true : undefined), { label: "public reply" });
    expect(fake.replies[0]).toMatchObject({ commentId: "e2e_c1" });

    // memory.extract runs as a delayed follow-up job
    const mem = await waitFor(() => one<{ id: number; content: string }>("SELECT id, content FROM memories WHERE layer = 'relationship'"), { label: "memory", timeoutMs: 20_000 });
    expect(mem.content).toMatch(/Air Max 90s/i);
    const user = await one<{ interaction_count: number; known_interests: string[] }>("SELECT interaction_count, known_interests FROM ig_users WHERE ig_scoped_id = '5551'");
    expect(user).toMatchObject({ interaction_count: 1, known_interests: [mem.content] });

    await relay(commentPayload({ commentId: "e2e_c2", fromId: "5551", username: "kampala_kicks", text: "Back again! Any new fit ideas?" }));
    await waitFor(() => (fake.replies.length === 2 ? true : undefined), { label: "second reply" });
    const decide = mock.calls.filter((c) => c.operation === "conversation.decide")[1];
    expect(decide.messages[0].content).toContain(`[${mem.id}] (interest)`);
    expect(await one("SELECT interaction_count FROM ig_users WHERE ig_scoped_id = '5551'")).toEqual({ interaction_count: 2 });

    const runs = await many<{ job_name: string; status: string }>("SELECT job_name, status FROM job_runs WHERE status = 'completed'");
    expect(new Set(runs.map((x) => x.job_name))).toEqual(new Set([JOBS.instagramEvent, JOBS.conversationProcess, JOBS.memoryExtract]));
  });
});

describe("E2E: daily planner → content idea → image generation → carousel → quality check → publish → engagement → analytics", () => {
  it("runs the whole content loop on the queues", async () => {
    const fk = new FakeKie();
    setStorageFetch(fk.fetch);
    setImageGenerator(new KieImageGenerator(new KieClient({ keys: ["k1"], fetchImpl: fk.fetch, pollDelaysMs: [1] }), "nano-banana-pro"));

    await queue("content").add(JOBS.contentPlan, {}, { jobId: jobId("plan", "e2e") });

    const published = await waitFor(
      () => one<{ id: string; ig_media_id: string; media_type: string }>("SELECT id, ig_media_id, media_type FROM posts WHERE status = 'published'"),
      { label: "published post", timeoutMs: 30_000 },
    );
    const slides = await many<{ public_url: string; width: number; height: number }>("SELECT public_url, width, height FROM post_assets WHERE post_id = $1", [published.id]);
    expect(slides.every((s) => s.width === 1080 && s.height === 1350 && s.public_url)).toBe(true);
    expect(fk.createCalls).toHaveLength(slides.length);
    expect(fake.media.get(published.ig_media_id)).toBeDefined();
    if (published.media_type === "CAROUSEL") expect(fake.media.get(published.ig_media_id)!.children).toHaveLength(slides.length);

    // engagement checkpoints are delayed jobs; promote them instead of waiting 24h
    // (they are enqueued right after the status flips to published)
    const delayed = await waitFor(async () => {
      const jobs = await queue("analytics").getJobs(["delayed"]);
      return jobs.length === 3 ? jobs : undefined;
    }, { label: "3 delayed engagement jobs" });
    expect(delayed.map((j) => j.data.checkpoint).sort()).toEqual(["24h", "72h", "7d"]);
    await Promise.all(delayed.map((j) => j.promote()));
    await waitFor(async () => ((await many("SELECT 1 FROM engagement_metrics")).length === 3 ? true : undefined), { label: "engagement metrics" });

    await queue("analytics").add(JOBS.analyticsProcess, {}, { jobId: jobId("analytics", "e2e") });
    const learnings = await waitFor(async () => {
      const rows = await many<{ dimension: string }>("SELECT dimension FROM learnings");
      return rows.length ? rows : undefined;
    }, { label: "learnings" });
    expect(learnings.map((l) => l.dimension)).toEqual(expect.arrayContaining(["format", "structure"]));

    // the audit trail covers every stage
    const agents = (await many<{ agent: string; action: string }>("SELECT agent, action FROM agent_decisions")).map((d) => `${d.agent}:${d.action}`);
    expect(agents).toEqual(expect.arrayContaining(["content_director:accept", "safety:send", "publisher:published"]));
    const costs = await many<{ category: string }>("SELECT DISTINCT category FROM cost_ledger");
    expect(costs.map((c) => c.category).sort()).toEqual(["image", "llm"]);
  });
});
