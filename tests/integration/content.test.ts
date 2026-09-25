import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { many, one } from "../../src/db/pool.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { planContent } from "../../src/content/director.js";
import { producePost } from "../../src/content/produce.js";
import { publishPost } from "../../src/content/publish.js";
import { setControls } from "../../src/config/controls.js";
import { setStorageFetch } from "../../src/storage/host.js";
import { setLLM, LLM } from "../../src/llm/llm.js";
import { createDevMockProvider } from "../../src/llm/devMock.js";
import { queue } from "../../src/queue/queues.js";
import { collectEngagement, processAnalytics, learningsForPrompt } from "../../src/analytics/learnings.js";
import { FakeInstagram } from "../helpers/fakeInstagram.js";
import { FakeKie } from "../helpers/fakeKie.js";
import { resetState, teardown, useFakeKie } from "../helpers/db.js";

let fake: FakeInstagram;
beforeEach(async () => {
  await resetState();
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
  setStorageFetch(fetch);
});
afterAll(() => teardown());

async function planAndProduce(): Promise<string> {
  const plan = await planContent();
  expect(plan.status).toBe("accepted");
  const postId = (plan as { postId: string }).postId;
  await producePost(postId);
  return postId;
}

describe("content planning", () => {
  it("builds the day plan and accepts a non-repetitive idea", async () => {
    const postId = await planAndProduce();
    expect((await many("SELECT 1 FROM activities")).length).toBeGreaterThan(3);
    const post = await one<{ status: string; media_type: string; visual_state: Record<string, unknown> }>("SELECT status, media_type, visual_state FROM posts WHERE id = $1", [postId]);
    expect(post!.status).toBe("approved");
    expect(post!.visual_state).toMatchObject({ hairstyle: expect.stringContaining("braids"), local_day: expect.any(String) });
  });

  it("does not plan while a post is in the pipeline, when paused, or past the daily cap", async () => {
    await planAndProduce();
    expect(await planContent()).toMatchObject({ status: "skipped", reason: "a post is already in the pipeline" });
    await one("UPDATE posts SET status = 'published', published_at = now()");
    await setControls({ max_posts_per_day: 1 });
    expect(await planContent()).toMatchObject({ status: "skipped", reason: expect.stringContaining("max_posts_per_day") });
    await setControls({ paused: true });
    expect(await planContent()).toMatchObject({ status: "skipped", reason: "paused" });
  });

  it("honours a director decision to wait", async () => {
    setLLM(new LLM(createDevMockProvider().on("content.plan", () => ({ decision: "wait", reason: "Nothing new worth posting this morning.", idea: null }))));
    expect(await planContent()).toMatchObject({ status: "waited" });
    expect(await many("SELECT 1 FROM posts")).toHaveLength(0);
    expect((await many<{ decision: string }>("SELECT decision FROM activities WHERE decision = 'skip' AND reason LIKE 'director%'")).length).toBeGreaterThan(0);
  });

  it("rejects a repetitive concept and asks for an alternative", async () => {
    await planAndProduce();
    await one("UPDATE posts SET status = 'published', published_at = now() - interval '1 day'");
    // A director that proposes the same topic first, then something new.
    let n = 0;
    const base = createDevMockProvider();
    const sameTopic = (await import("../../src/db/pool.js")).one<{ topic: string; hook: string; caption: string }>("SELECT topic, hook, caption FROM content_ideas LIMIT 1");
    const prev = (await sameTopic)!;
    const mock = base.on("content.plan", async (req) => {
      n++;
      const idea = JSON.parse(String((await createDevMockProvider().complete(req)).text));
      if (n === 1) Object.assign(idea.idea, { topic: prev.topic, hook: prev.hook, caption: prev.caption });
      else Object.assign(idea.idea, { topic: "Sunrise run on the airstrip", hook: "5:40am, still quiet", caption: "First light and fresh legs." });
      return idea;
    });
    setLLM(new LLM(mock));
    const r = await planContent();
    expect(r).toMatchObject({ status: "accepted", attempts: 2 });
    const ideas = await many<{ status: string; reject_reason: string | null }>("SELECT status, reject_reason FROM content_ideas ORDER BY id");
    expect(ideas[1]).toMatchObject({ status: "rejected", reject_reason: expect.stringContaining("too similar") });
    // The rejection reasons are fed back to the director on the next attempt.
    const second = mock.calls.filter((c) => c.operation === "content.plan")[1];
    expect(second.messages[0].content).toContain("REJECTED as repetitive");
  });
});

describe("production with kie.ai", () => {
  it("generates each slide through kie, records credits, composes and hosts", async () => {
    const fk = new FakeKie();
    await useFakeKie(fk);
    const postId = await planAndProduce();
    const jobs = await many<{ status: string; task_id: string; credits: number; provider: string }>(
      "SELECT status, provider_request_id AS task_id, credits, provider FROM generation_attempts WHERE post_id = $1",
      [postId],
    );
    const slides = (await many("SELECT 1 FROM post_assets WHERE post_id = $1", [postId])).length;
    expect(jobs).toHaveLength(slides);
    expect(jobs.every((j) => j.provider === "kie" && j.status === "success" && j.task_id.startsWith("task_") && j.credits === 18)).toBe(true);
    // Every slide is a durable, influencer-owned asset linked to its generation request.
    const assets = await many<{ influencer_id: number }>("SELECT a.influencer_id FROM post_assets pa JOIN assets a ON a.id = pa.asset_id WHERE pa.post_id = $1", [postId]);
    expect(assets).toHaveLength(slides);
    // The soul's identity references go into every character shot; the cover is the environment reference for later slides.
    const { activeSoul } = await import("../../src/souls/souls.js");
    const soul = await activeSoul(1);
    expect(soul!.soul.soul_id).toMatch(/^soul_zuri/);
    expect(fk.createCalls[0].input.image_input).toEqual(soul!.identityRefs);
    // …as our durable, influencer-scoped copy, never the provider's expiring URL.
    expect(fk.createCalls[1].input.image_input.at(-1)).toMatch(/\/influencers\/zuri\/gen\//);
    expect(fk.createCalls[0].input).toMatchObject({ aspect_ratio: "4:5", output_format: "jpg" });
    const cost = await one<{ usd: number }>("SELECT sum(cost_usd)::float AS usd FROM cost_ledger WHERE category = 'image' AND ref_id = $1", [postId]);
    expect(cost!.usd).toBeCloseTo(slides * 18 * 0.005, 6);
  });

  it("retries a failed kie task with a fresh one and continues", async () => {
    const fk = new FakeKie();
    fk.failNextTasks = 1;
    await useFakeKie(fk);
    const postId = await planAndProduce();
    expect(await one("SELECT status FROM posts WHERE id = $1", [postId])).toEqual({ status: "approved" });
    const first = await many<{ status: string; error_class: string | null }>("SELECT status, error_class FROM generation_attempts WHERE post_id = $1 AND position = 0 ORDER BY id", [postId]);
    // content_policy never falls back to another provider; production retries with a fresh request instead.
    expect(first).toEqual([{ status: "failed", error_class: "content_policy" }, { status: "success", error_class: null }]);
  });

  it("stops production when the image budget is exhausted", async () => {
    const fk = new FakeKie();
    await useFakeKie(fk);
    await setControls({ daily_image_budget_usd: 0.01 });
    const plan = await planContent();
    expect(await producePost((plan as { postId: string }).postId)).toBe("failed");
    expect(fk.createCalls).toHaveLength(0);
    expect(await one("SELECT last_error FROM posts")).toMatchObject({ last_error: expect.stringContaining("budget") });
  });

  it("sends posts to human review in human-approval mode", async () => {
    await setControls({ mode: "human_approval" });
    const postId = await planAndProduce();
    expect(await one("SELECT status FROM posts WHERE id = $1", [postId])).toEqual({ status: "awaiting_review" });
    expect(await one("SELECT subject_type, status FROM safety_reviews")).toEqual({ subject_type: "post", status: "pending" });
  });
});

describe("publishing", () => {
  it("publishes a carousel: children, parent, AI label, permalink, analytics scheduled", async () => {
    const postId = await planAndProduce();
    expect(await publishPost(postId)).toBe("published");
    const p = await one<{ status: string; ig_media_id: string; permalink: string; media_type: string }>("SELECT status, ig_media_id, permalink, media_type FROM posts WHERE id = $1", [postId]);
    expect(p).toMatchObject({ status: "published", ig_media_id: expect.stringMatching(/^m_/), permalink: expect.stringContaining("instagram.com/p/") });
    const creates = fake.callsTo("POST", /\/media$/);
    const children = creates.filter((c) => c.body.is_carousel_item);
    const parent = creates.find((c) => c.body.media_type === "CAROUSEL")!;
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(parent.body.children.split(",")).toHaveLength(children.length);
    // AI label on the carousel container, never on the items (Meta rejects that).
    expect(parent.body.is_ai_generated).toBe(true);
    expect(children.every((c) => c.body.is_ai_generated === undefined)).toBe(true);
    expect(fake.callsTo("POST", /media_publish/)).toHaveLength(1);
    const delayed = await queue("analytics").getJobs(["delayed"]);
    expect(delayed.map((j) => j.data.checkpoint).sort()).toEqual(["24h", "72h", "7d"]);
    expect(await one("SELECT kind FROM memories WHERE layer = 'world'")).toEqual({ kind: "published" });
  });

  it("never publishes twice: repeated and concurrent attempts produce one media", async () => {
    const postId = await planAndProduce();
    await Promise.all([publishPost(postId).catch(() => "locked"), publishPost(postId).catch(() => "locked")]);
    await publishPost(postId);
    expect(fake.callsTo("POST", /media_publish/)).toHaveLength(1);
    expect(fake.media.size).toBe(1);
  });

  it("recovers when the media_publish response is lost (no duplicate)", async () => {
    const postId = await planAndProduce();
    fake.failNext(/media_publish/, { kind: "lost_response" });
    await expect(publishPost(postId)).rejects.toThrow(/network error/);
    expect(fake.media.size).toBe(1); // it did go out
    expect(await publishPost(postId)).toBe("published");
    expect(fake.callsTo("POST", /media_publish/)).toHaveLength(1);
    expect(fake.media.size).toBe(1);
    expect(await one("SELECT ig_media_id FROM posts WHERE id = $1", [postId])).toEqual({ ig_media_id: [...fake.media.keys()][0] });
  });

  it("resumes after a crash mid-carousel without recreating containers", async () => {
    const postId = await planAndProduce();
    fake.failNext(/\/media$/, { kind: "http", status: 500 }, 1, "POST");
    // The 3rd container create fails after two children exist.
    let creates = 0;
    const orig = fake.fetch;
    fake.fetch = async (u, init) => {
      if (String(u).endsWith("/media") && init?.method === "POST" && ++creates === 3) throw new TypeError("socket hang up");
      return orig(u, init);
    };
    setInstagramClient(fake.client());
    await expect(publishPost(postId)).rejects.toThrow();
    const before = await one<{ ig_child_container_ids: string[] }>("SELECT ig_child_container_ids FROM posts WHERE id = $1", [postId]);
    fake.fetch = orig;
    setInstagramClient(fake.client());
    expect(await publishPost(postId)).toBe("published");
    const parent = fake.callsTo("POST", /\/media$/).find((c) => c.body.media_type === "CAROUSEL")!;
    expect(parent.body.children.split(",").slice(0, before!.ig_child_container_ids.length)).toEqual(before!.ig_child_container_ids);
  });

  it("rebuilds an expired container instead of failing", async () => {
    const postId = await planAndProduce();
    fake.failNext(/media_publish/, { kind: "http", status: 500 });
    await expect(publishPost(postId)).rejects.toThrow();
    const { ig_container_id } = (await one<{ ig_container_id: string }>("SELECT ig_container_id FROM posts WHERE id = $1", [postId]))!;
    fake.containers.get(ig_container_id)!.status = "ERROR";
    expect(await publishPost(postId)).toBe("published");
    expect(fake.media.size).toBe(1);
  });

  it("waits when the 24h publishing quota is used up", async () => {
    const postId = await planAndProduce();
    fake.quotaUsage = 100;
    await expect(publishPost(postId)).rejects.toThrow(/quota/);
    expect(fake.callsTo("POST", /\/media/)).toHaveLength(0);
    expect(await one("SELECT status FROM posts WHERE id = $1", [postId])).toEqual({ status: "publishing" });
  });

  it("records a dry run instead of publishing in dry-run mode", async () => {
    const postId = await planAndProduce();
    await one("UPDATE posts SET status = 'approved' WHERE id = $1", [postId]);
    await setControls({ mode: "dry_run" });
    expect(await publishPost(postId)).toBe("dry_run");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("engagement and learning loop", () => {
  it("collects insights, scores posts and turns them into learnings", async () => {
    const postId = await planAndProduce();
    await publishPost(postId);
    const m = await collectEngagement(postId, "24h");
    expect(m).toMatchObject({ reach: 500, saves: 12, shares: 5, follows: 3 });
    const row = await one<{ score: number }>("SELECT score FROM engagement_metrics WHERE post_id = $1", [postId]);
    expect(row!.score).toBeGreaterThan(0);
    expect(await processAnalytics()).toMatchObject({ posts: 1 });
    expect(await learningsForPrompt()).toMatch(/format: (carousel|single)=/);
  });
});

describe("no connected account", () => {
  it("does not plan (or spend) until an Instagram account is connected", async () => {
    setInstagramClient(undefined);
    await one("DELETE FROM ig_accounts");
    expect(await planContent()).toMatchObject({ status: "skipped", reason: "no Instagram account connected" });
    const { collectAccount } = await import("../../src/analytics/learnings.js");
    await expect(collectAccount()).resolves.toBeUndefined();
  });
});
