import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { setControls } from "../../src/config/controls.js";
import { invalidateInfluencer, withInfluencer } from "../../src/context.js";
import { publishPost } from "../../src/content/publish.js";
import { many, one } from "../../src/db/pool.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { createDevLLM, createDevMockProvider } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { probeVideo } from "../../src/media/video.js";
import { makesExplainers, normalizeReel, planReel, type ReelPlan } from "../../src/reels/plan.js";
import { persona } from "../../src/persona/loader.js";
import { JOBS } from "../../src/queue/queues.js";
import { HANDLERS } from "../../src/queue/worker.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";
import { FakeInstagram } from "../helpers/fakeInstagram.js";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let app: FastifyInstance;
let fake: FakeInstagram;
beforeEach(async () => {
  await resetState({ mode: "human_approval", posting_window_start_hour: 0, posting_window_end_hour: 24 });
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
  setLLM(createDevLLM());
  app ??= await buildServer();
});
afterAll(async () => {
  await app?.close();
  await teardown();
});

const form = (url: string, body: Record<string, string>) => app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const runCreate = async (kind: string) => {
  const r = await form("/admin/create", { kind });
  const runId = String(r.headers.location).split("/").pop()!.split("?")[0];
  await HANDLERS[JOBS.contentCreate]({ name: JOBS.contentCreate, data: { influencerId: 1, runId } } as unknown as Job);
  return (await one<{ post_id: string | null; status: string; message: string | null }>("SELECT post_id, status, message FROM create_runs WHERE id = $1", [runId]))!;
};
async function makeTipsCreator() {
  const row = await one<{ persona_yaml: string }>("SELECT persona_yaml FROM influencers WHERE id = 1");
  const p = parse(row!.persona_yaml) as any;
  p.identity.occupation = "AI iPhone tips and tech explainer creator";
  await one("UPDATE influencers SET persona_yaml = $1 WHERE id = 1", [stringify(p)]);
  invalidateInfluencer();
}
async function videoInfo(url: string) {
  const local = url.replace(/^http:\/\/localhost:3999\/media\//, "output/test-media/");
  const dir = mkdtempSync(join(tmpdir(), "reeltest-"));
  writeFileSync(join(dir, "v.mp4"), readFileSync(local));
  return probeVideo(join(dir, "v.mp4"));
}

describe("reels", () => {
  it("makes a moment reel on request: AI clips joined into one 1080x1920 video with a cover, held for review", async () => {
    const run = await runCreate("reel");
    expect(run.status).toBe("done");
    const post = await one<{ media_type: string; status: string; caption: string }>("SELECT media_type, status, caption FROM posts WHERE id = $1", [run.post_id]);
    expect(post).toMatchObject({ media_type: "REEL", status: "awaiting_review" });
    const assets = await many<{ media_kind: string; width: number; height: number; public_url: string; duration_s: string | null }>("SELECT media_kind, width, height, public_url, duration_s FROM post_assets WHERE post_id = $1 ORDER BY position", [run.post_id]);
    expect(assets.map((a) => a.media_kind)).toEqual(["video", "image"]);
    expect(assets.every((a) => a.width === 1080 && a.height === 1920)).toBe(true);
    const v = await videoInfo(assets[0].public_url);
    expect(v).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(v.durationS).toBeGreaterThan(5); // intro 4s + clip 3s
    expect(await one("SELECT structure FROM content_ideas WHERE id = (SELECT content_idea_id FROM posts WHERE id = $1)", [run.post_id])).toEqual({ structure: "moment" });
  });

  it("makes an explainer for a tips creator: steps are research-checked, rendered on a phone screen, and always reviewed", async () => {
    await makeTipsCreator();
    await setControls({ mode: "autonomous" });
    const mock = createDevMockProvider();
    setLLM(new LLM(mock, 90_000));
    const plan = await withInfluencer(1, () => planReel(new Date()));
    expect(plan.status).toBe("accepted");
    expect(mock.calls.map((c) => c.operation)).toEqual(expect.arrayContaining(["reel.plan", "reel.verify"]));
    const postId = "postId" in plan ? plan.postId : "";
    await HANDLERS[JOBS.contentProduce]({ name: JOBS.contentProduce, data: { influencerId: 1, postId } } as unknown as Job);
    // Autonomous mode, green caption: an explainer still waits for a person.
    expect(await one("SELECT status FROM posts WHERE id = $1", [postId])).toEqual({ status: "awaiting_review" });
    const a = await one<{ public_url: string }>("SELECT public_url FROM post_assets WHERE post_id = $1 AND media_kind = 'video'", [postId]);
    expect((await videoInfo(a!.public_url)).durationS).toBeGreaterThan(9); // 4s intro + ~7s of steps
    const idea = await one<{ plan: { verified?: string; steps: unknown[] } }>("SELECT plan FROM content_ideas WHERE id = (SELECT content_idea_id FROM posts WHERE id = $1)", [postId]);
    expect(idea!.plan.verified).toMatch(/iOS 18/);
    expect(idea!.plan.steps).toHaveLength(2);
  }, 120_000);

  it("publishes a reel as REELS with the AI label", async () => {
    const run = await runCreate("reel");
    await one("UPDATE posts SET status = 'approved' WHERE id = $1", [run.post_id]);
    expect(await withInfluencer(1, () => publishPost(run.post_id!))).toBe("published");
    const m = [...fake.media.values()].at(-1)!;
    expect(m.params).toMatchObject({ media_type: "REELS", is_ai_generated: true, share_to_feed: true });
    expect(String(m.params!.cover_url)).toMatch(/cover-.*\.jpg$/);
  });

  it("keeps to reels_per_week and the gap between reels", async () => {
    await setControls({ reels_per_week: 1 });
    const first = await withInfluencer(1, () => planReel(new Date()));
    expect(first.status).toBe("accepted");
    expect(await withInfluencer(1, () => planReel(new Date()))).toMatchObject({ status: "skipped", reason: expect.stringMatching(/already being made|reels_per_week/) });
  });

  it("trims a plan to the length cap and only lets tips creators make explainers", async () => {
    await withInfluencer(1, async () => {
      const p = persona();
      expect(makesExplainers(p)).toBe(false);
      const step = { say: "x", tap: "A", screen: { title: "S", back: null, footer: null, rows: [{ label: "A", section: null, icon_color: null, value: null, toggle: null, chevron: true }] } };
      const clip = { shot: "x", motion: "y", composition: "medium" as const, include_character: true, location_id: "nowhere", time_of_day: "morning" as const, seconds: 6 };
      const plan: ReelPlan = { kind: "explainer", format: null, topic: "t", hook: "h".repeat(60), caption: "c", hashtags: [], os: "ios", intro: clip, clips: [], steps: Array(6).fill(step), material_id: "missing", featured_item: "" };
      const out = normalizeReel(plan, p, false, [], { max_reel_seconds: 55 });
      expect(out).toMatchObject({ kind: "moment", steps: [], material_id: null });
      expect(out.intro.location_id).toBeNull();
      expect(out.hook).toHaveLength(40);
      const tips = normalizeReel(plan, p, true, [], { max_reel_seconds: 12 });
      expect(tips.kind).toBe("explainer");
      expect(tips.steps.length).toBe(2);
    });
  });
});
