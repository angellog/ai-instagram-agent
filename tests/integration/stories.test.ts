import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setControls } from "../../src/config/controls.js";
import { invalidateInfluencer, withInfluencer } from "../../src/context.js";
import { postingGate } from "../../src/content/director.js";
import { publishPost } from "../../src/content/publish.js";
import { operatorPublish } from "../../src/content/schedule.js";
import { normalizeStory, planStory, storyGate, type StoryPlan } from "../../src/content/stories.js";
import { many, one } from "../../src/db/pool.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { createDevLLM, createDevMockProvider } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { persona } from "../../src/persona/loader.js";
import { JOBS, queue } from "../../src/queue/queues.js";
import { HANDLERS, storySchedulerId, syncInfluencerSchedulers } from "../../src/queue/worker.js";
import { setStorageFetch } from "../../src/storage/host.js";
import { buildServer } from "../../src/web/server.js";
import { FakeInstagram } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

let app: FastifyInstance;
let fake: FakeInstagram;
let jpeg: Buffer;
beforeEach(async () => {
  await resetState({ mode: "human_approval", posting_window_start_hour: 0, posting_window_end_hour: 24 });
  await one("UPDATE influencers SET knowledge_yaml = $1 WHERE id = 1", [readFileSync("config/knowledge.yaml", "utf8")]);
  invalidateInfluencer();
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
  jpeg ??= await sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 140, g: 110, b: 90 } } }).jpeg().toBuffer();
  setStorageFetch(async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } }));
  app ??= await buildServer();
});
afterEach(() => setLLM(createDevLLM()));
afterAll(async () => {
  await app?.close();
  setStorageFetch(fetch);
  await teardown();
});

const form = (url: string, body: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

/** "Create a story now" end to end, the way the console does it. */
async function makeStory(): Promise<string> {
  const r = await form("/admin/create", { kind: "story" });
  const runId = String(r.headers.location).split("/").pop()!.split("?")[0];
  await HANDLERS[JOBS.contentCreate]({ name: JOBS.contentCreate, data: { influencerId: 1, runId } } as unknown as Job);
  return (await one<{ post_id: string }>("SELECT post_id FROM create_runs WHERE id = $1", [runId]))!.post_id;
}

describe("Create a story now", () => {
  it("plans from her day, makes one 1080x1920 frame with its words, and holds it for review", async () => {
    const id = await makeStory();
    const post = await one<{ media_type: string; caption: string; status: string; origin: string }>("SELECT media_type, caption, status, origin FROM posts WHERE id = $1", [id]);
    expect(post).toEqual({ media_type: "STORY", caption: "", status: "awaiting_review", origin: "operator" });
    const assets = await many<{ width: number; height: number; overlay: { kind: string; heading: string } }>("SELECT width, height, overlay FROM post_assets WHERE post_id = $1", [id]);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ width: 1080, height: 1920, overlay: { kind: "story", heading: "Sunday laces ritual" } });
    const gen = await one<{ aspect: string }>("SELECT request->>'aspectRatio' AS aspect FROM generation_requests WHERE post_id = $1 LIMIT 1", [id]);
    expect(gen?.aspect).toBe("9:16");
    // The progress page and the Stories page speak "story".
    const run = await one<{ id: string; kind: string }>("SELECT id, kind FROM create_runs WHERE post_id = $1", [id]);
    expect(run!.kind).toBe("story");
    const progress = (await app.inject({ url: `/admin/api/create/${run!.id}` })).json();
    expect(progress).toMatchObject({ kind: "story", status: "done", pct: 100 });
    expect((await app.inject({ url: `/admin/create/${run!.id}` })).body).toContain("Creating a story for");
    const page = await app.inject({ url: "/admin/stories" });
    expect(page.body).toContain(`/admin/posts/${id}`);
    expect((await app.inject({ url: "/admin/posts" })).body).not.toContain(`/admin/posts/${id}`); // feed list stays feed-only
    expect((await app.inject({ url: `/admin/posts/${id}` })).body).toContain("Words on the image");
  });

  it("never puts text on a photo of her", async () => {
    await makeStory(); // 1st: a detail shot with text
    const second = await makeStory(); // 2nd: a mirror fit check of her
    const a = await one<{ overlay: { kind: string } }>("SELECT overlay FROM post_assets WHERE post_id = $1", [second]);
    expect(a!.overlay.kind).toBe("none");
    expect((await app.inject({ url: `/admin/posts/${second}` })).body).toContain("stays text-free");
  });
});

describe("story house rules", () => {
  const base: StoryPlan = {
    kind: "moment", activity_id: null, shot: "x", composition: "detail", include_character: false, location_id: null,
    time_of_day: "morning", featured_item: "", text: "Morning laces", alt_text: "x",
  };
  it("strips text from photos of her, adds the true shop line, and drops unverified numbers", async () => {
    await withInfluencer(1, async () => {
      const p = persona();
      expect(normalizeStory({ ...base, include_character: true }, p, undefined).text).toBe("");
      const shop = normalizeStory({ ...base, kind: "brand", include_character: true, text: "Fresh drop" }, p, "Pioneer Mall, Level 5, Shop PH-100, Kampala");
      expect(shop).toMatchObject({ include_character: false, text: "Fresh drop", footer: "Pioneer Mall, Level 5, Shop PH-100, Kampala" });
      expect(normalizeStory({ ...base, text: "Only 3 pairs left at 250k" }, p, undefined)).toMatchObject({ text: "", adjustments: [expect.stringMatching(/unverified numbers/)] });
      // Off a naming turn (no shop line passed) a brand story keeps the brand's world but carries no store line.
      expect(normalizeStory({ ...base, kind: "brand" }, p, undefined)).toMatchObject({ kind: "brand", footer: "" });
    });
  });
});

describe("story publishing", () => {
  it("publishes as STORIES with the AI label, once, and skips feed engagement tracking", async () => {
    const id = await makeStory();
    const res = await withInfluencer(1, () => operatorPublish(id, "now", "test"));
    expect(res.ok).toBe(true);
    expect(await withInfluencer(1, () => publishPost(id))).toBe("published");
    expect(fake.stories.size).toBe(1);
    const container = fake.callsTo("POST", /\/media$/)[0];
    expect(container.body).toMatchObject({ media_type: "STORIES", is_ai_generated: true });
    expect(container.body.caption).toBeUndefined();
    const post = await one<{ status: string; permalink: string }>("SELECT status, permalink FROM posts WHERE id = $1", [id]);
    expect(post).toMatchObject({ status: "published", permalink: expect.stringContaining("/stories/") });
    const analytics = (await queue("analytics").getJobs(["delayed", "waiting"])).filter((j) => j.data.postId === id);
    expect(analytics).toHaveLength(0);
    expect(await withInfluencer(1, () => publishPost(id))).toBe("already_published");
  });

  it("recovers a story whose publish response was lost, without posting twice", async () => {
    const id = await makeStory();
    await withInfluencer(1, () => operatorPublish(id, "now", "test"));
    fake.failNext(/media_publish/, { kind: "lost_response" });
    await expect(withInfluencer(1, () => publishPost(id))).rejects.toThrow();
    expect(await withInfluencer(1, () => publishPost(id))).toBe("published");
    expect(fake.stories.size).toBe(1);
  });

  it("goes out without the per-media AI label if Instagram refuses it on stories", async () => {
    const id = await makeStory();
    await withInfluencer(1, () => operatorPublish(id, "now", "test"));
    fake.failNext(/\/media$/, { kind: "http", status: 400, error: { message: "Param is_ai_generated is not supported for this media type", code: 100 } }, 1, "POST");
    expect(await withInfluencer(1, () => publishPost(id))).toBe("published");
    expect(fake.callsTo("POST", /\/media$/).at(-1)!.body.is_ai_generated).toBeUndefined();
    expect(await one("SELECT 1 AS x FROM system_events WHERE message LIKE 'Instagram refused the AI label on a story%'")).toEqual({ x: 1 });
  });
});

describe("story cadence", () => {
  it("respects the off switch, the daily cap, the gap and the window; feed posts aren't blocked by stories", async () => {
    await withInfluencer(1, async () => {
      const p = persona();
      const now = new Date();
      await setControls({ stories_enabled: false });
      expect(await storyGate(await import("../../src/config/controls.js").then((m) => m.getControls(true)), p, now, false)).toBe("stories disabled");
      expect(await planStory(now, { operator: true })).toEqual({ status: "skipped", reason: "stories are turned off in Controls" });
      await setControls({ stories_enabled: true, stories_per_day: 1 });
      await one("INSERT INTO posts (influencer_id, media_type, caption, status, published_at) VALUES (1, 'STORY', '', 'published', now() - interval '1 hour')");
      expect(await planStory(now)).toEqual({ status: "skipped", reason: "stories_per_day (1) reached" });
      await setControls({ stories_per_day: 5, min_hours_between_stories: 3 });
      expect(await planStory(now)).toEqual({ status: "skipped", reason: "last story was less than 3h ago" });
      // A story in review doesn't hold up feed posts.
      await one("INSERT INTO posts (influencer_id, media_type, caption, status) VALUES (1, 'STORY', '', 'awaiting_review')");
      await setControls({ mode: "dry_run" });
      expect(await postingGate(await import("../../src/config/controls.js").then((m) => m.getControls(true)), p, now)).toBeUndefined();
    });
  });

  it("is scheduled per influencer in their timezone", async () => {
    await syncInfluencerSchedulers();
    const s = await queue("content").getJobScheduler(storySchedulerId(1));
    expect(s).toMatchObject({ name: JOBS.storyPlan, tz: "Africa/Kampala" });
  });
});
