import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setControls } from "../../src/config/controls.js";
import { createProgress } from "../../src/content/create.js";
import { createDevLLM, createDevMockProvider } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { many, one } from "../../src/db/pool.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { JOBS, queue } from "../../src/queue/queues.js";
import { HANDLERS } from "../../src/queue/worker.js";
import { buildServer } from "../../src/web/server.js";
import { FakeInstagram } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

let app: FastifyInstance;
let fake: FakeInstagram;
beforeEach(async () => {
  // Autonomous + a closed posting window + a post already in the pipeline:
  // none of that may stop an operator's "create now", and it must still stop for review.
  await resetState({ mode: "autonomous", posting_window_start_hour: 3, posting_window_end_hour: 4 });
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
  app ??= await buildServer();
});
afterAll(async () => {
  await app?.close();
  await teardown();
});

const form = (b: Record<string, string>) => ({ payload: new URLSearchParams(b).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const run = async (runId: string) => HANDLERS[JOBS.contentCreate]({ name: JOBS.contentCreate, data: { influencerId: 1, runId } } as unknown as Job);

describe("Create a post now", () => {
  it("runs the whole pipeline on one tap, reports real progress, and holds the post for review", async () => {
    await one("INSERT INTO posts (influencer_id, media_type, caption, status) VALUES (1, 'IMAGE', 'already queued', 'approved')");
    const r = await app.inject({ method: "POST", url: "/admin/create" });
    expect(r.statusCode).toBe(303);
    const id = String(r.headers.location).split("/").pop()!.split("?")[0];
    const queued = await createProgress(id);
    expect(queued).toMatchObject({ status: "queued", pct: 2 });
    // A second tap while it runs opens the same run instead of starting another.
    const again = await app.inject({ method: "POST", url: "/admin/create", headers: { accept: "application/json" } });
    expect(again.json()).toMatchObject({ id, existing: true });
    const job = (await queue("content").getJobs(["waiting"])).find((j) => j.name === JOBS.contentCreate)!;
    expect(job.data).toMatchObject({ influencerId: 1, runId: id });

    expect(await run(id)).toBe("awaiting_review");
    const p = (await app.inject({ url: `/admin/api/create/${id}` })).json();
    expect(p).toMatchObject({ status: "done", stage: "ready", pct: 100, outcome: "awaiting_review" });
    expect(p.steps.every((s: { state: string }) => s.state === "done")).toBe(true);
    expect(p.slides.done).toBe(p.slides.total);
    expect(p.slides.urls.length).toBeGreaterThan(0);
    const post = await one<{ origin: string; status: string }>("SELECT origin, status FROM posts WHERE id = $1", [p.postId]);
    expect(post).toEqual({ origin: "operator", status: "awaiting_review" });
    expect(await one("SELECT status FROM safety_reviews WHERE subject_id = $1", [p.postId])).toEqual({ status: "pending" });
    // Nothing was queued for publishing: the operator decides.
    expect((await queue("publish").getJobs(["delayed", "waiting"])).filter((j) => j.data.postId === p.postId)).toHaveLength(0);
    const page = await app.inject({ url: `/admin/create/${id}` });
    expect(page.body).toContain('role="progressbar"');
    expect(page.body).toContain("cr-postnow");
  });

  it("carries the operator's direction into the director, the run and the retry", async () => {
    const mock = createDevMockProvider();
    setLLM(new LLM(mock, 90_000));
    try {
      const r = await app.inject({ method: "POST", url: "/admin/create", ...form({ direction: "  Jordan 4 Black Cat\n at the shop  " }) });
      const id = String(r.headers.location).split("/").pop()!.split("?")[0];
      expect(await one("SELECT direction FROM create_runs WHERE id = $1", [id])).toEqual({ direction: "Jordan 4 Black Cat at the shop" });
      expect(await run(id)).toBe("awaiting_review");
      const plan = mock.calls.find((c) => c.operation === "content.plan")!;
      const prompt = plan.messages.map((m) => m.content).join("\n");
      expect(prompt).toContain('OPERATOR DIRECTION (must follow): the operator asked for this post to be about: "Jordan 4 Black Cat at the shop"');
      const page = await app.inject({ url: `/admin/create/${id}` });
      expect(page.body).toContain("Your direction:");
      expect(page.body).toContain('name="direction" value="Jordan 4 Black Cat at the shop"'); // Try again keeps it
      const list = await app.inject({ url: "/admin/create" });
      expect(list.body).toContain('id="direction"');
      expect(list.body).toContain("Jordan 4 Black Cat at the shop");

      // Stories take a direction too.
      const s = await app.inject({ method: "POST", url: "/admin/create", ...form({ kind: "story", direction: "rainy evening" }) });
      const sid = String(s.headers.location).split("/").pop()!.split("?")[0];
      await run(sid);
      const story = mock.calls.find((c) => c.operation === "story.plan")!;
      expect(story.messages.map((m) => m.content).join("\n")).toContain('about: "rainy evening"');
      // Empty direction means none.
      const e = await app.inject({ method: "POST", url: "/admin/create", payload: new URLSearchParams({ direction: "   " }).toString(), headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" } });
      expect(await one("SELECT direction FROM create_runs WHERE id = $1", [e.json().id])).toEqual({ direction: null });
    } finally {
      setLLM(createDevLLM());
    }
  });

  it("is refused while paused or with image generation off, and reports planner failures", async () => {
    await setControls({ paused: true });
    const r = await app.inject({ method: "POST", url: "/admin/create" });
    expect(decodeURIComponent(String(r.headers.location))).toMatch(/Can't create a post: paused/);
    await setControls({ paused: false, content_enabled: false });
    expect(decodeURIComponent(String((await app.inject({ method: "POST", url: "/admin/create" })).headers.location))).toMatch(/content generation is disabled/);
    expect(await many("SELECT 1 FROM create_runs")).toHaveLength(0);
  });

  it("marks the run failed with a readable message when production fails", async () => {
    await setControls({ daily_image_budget_usd: 0.0001 });
    await one("UPDATE generation_models SET cost_estimate_usd = 0.2 WHERE provider_id = 'mock'");
    const r = await app.inject({ method: "POST", url: "/admin/create", headers: { accept: "application/json" } });
    const id = r.json().id;
    expect(await run(id)).toBe("failed");
    const p = await createProgress(id);
    expect(p).toMatchObject({ status: "failed", outcome: "failed" });
    expect(p!.steps.find((s) => s.state === "failed")).toBeDefined();
  });
});

describe("Instagram profile sync", () => {
  it("pulls live followers into the influencer card and Overview", async () => {
    const r = await app.inject({ method: "POST", url: "/admin/influencers/1/sync" });
    expect(decodeURIComponent(String(r.headers.location))).toMatch(/1234 followers/);
    expect(await one("SELECT followers FROM account_metrics WHERE influencer_id = 1")).toEqual({ followers: 1234 });
    const cards = await app.inject({ url: "/admin/influencers" });
    expect(cards.body).toContain("<b>1,234</b><span>Followers</span>");
    expect((await app.inject({ url: "/admin" })).body).toContain("1,234");
  });
});
