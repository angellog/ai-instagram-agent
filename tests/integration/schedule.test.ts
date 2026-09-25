import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setControls } from "../../src/config/controls.js";
import { planContent } from "../../src/content/director.js";
import { producePost } from "../../src/content/produce.js";
import { zonedToUtc } from "../../src/content/schedule.js";
import { one } from "../../src/db/pool.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { JOBS, queue } from "../../src/queue/queues.js";
import { HANDLERS } from "../../src/queue/worker.js";
import { buildServer } from "../../src/web/server.js";
import { FakeInstagram } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

let app: FastifyInstance;
let fake: FakeInstagram;
beforeEach(async () => {
  await resetState({ mode: "human_approval" });
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
  app ??= await buildServer();
});
afterAll(async () => {
  await app?.close();
  await teardown();
});

const post = (url: string, body: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const flash = (r: { headers: Record<string, unknown> }) => decodeURIComponent(String(r.headers.location ?? "")).replace(/^.*flash=/, "");

async function draft(): Promise<string> {
  const plan = (await planContent()) as { postId: string };
  await producePost(plan.postId);
  expect(await one("SELECT status FROM posts WHERE id = $1", [plan.postId])).toEqual({ status: "awaiting_review" });
  return plan.postId;
}
const publishJobs = async (id: string) => (await queue("publish").getJobs(["delayed", "waiting"])).filter((j) => j.data.postId === id);

describe("wall-clock conversion", () => {
  it("interprets the schedule in the influencer's timezone, DST included", () => {
    expect(zonedToUtc("2026-09-27T18:30", "Africa/Kampala").toISOString()).toBe("2026-09-27T15:30:00.000Z");
    expect(zonedToUtc("2026-07-10T12:00", "Europe/London").toISOString()).toBe("2026-07-10T11:00:00.000Z");
    expect(zonedToUtc("2026-12-10T12:00", "Europe/London").toISOString()).toBe("2026-12-10T12:00:00.000Z");
    expect(() => zonedToUtc("tomorrow", "UTC")).toThrow();
  });
});

describe("Post now", () => {
  it("publishes immediately, approving the review, even in dry-run mode", async () => {
    const id = await draft();
    await setControls({ mode: "dry_run" });
    const page = await app.inject({ url: `/admin/posts/${id}` });
    expect(page.body).toContain("Post now");
    expect(page.body).toContain('type="datetime-local"');
    const r = await post(`/admin/posts/${id}/post-now`);
    expect(flash(r)).toBe("Posting now");
    const [job] = await publishJobs(id);
    expect(job.delay ?? 0).toBe(0);
    expect(await one("SELECT status FROM safety_reviews WHERE subject_id = $1", [id])).toEqual({ status: "approved" });
    expect(await HANDLERS[JOBS.postPublish]({ name: JOBS.postPublish, data: job.data } as unknown as Job)).toBe("published");
    expect(await one("SELECT status, publish_override FROM posts WHERE id = $1", [id])).toEqual({ status: "published", publish_override: "operator" });
    expect(fake.media.size).toBe(1);
    // Can't post twice.
    expect(flash(await post(`/admin/posts/${id}/post-now`))).toBe("Already published");
  });

  it("applies an edited caption from the review card, but never a RED one", async () => {
    const id = await draft();
    expect(flash(await post(`/admin/posts/${id}/post-now`, { text: "I will hurt you if you skip this drop" }))).toMatch(/Edited caption is red/);
    expect(flash(await post(`/admin/posts/${id}/post-now`, { text: "New caption, same vibe." }))).toBe("Posting now");
    expect(await one("SELECT caption FROM posts WHERE id = $1", [id])).toEqual({ caption: "New caption, same vibe." });
  });

  it("refuses RED posts and development mode", async () => {
    const id = await draft();
    await one("UPDATE posts SET safety_level = 'red' WHERE id = $1", [id]);
    expect(flash(await post(`/admin/posts/${id}/post-now`))).toBe("RED posts are never published");
    await one("UPDATE posts SET safety_level = 'green' WHERE id = $1", [id]);
    await setControls({ mode: "development" });
    expect(flash(await post(`/admin/posts/${id}/post-now`))).toMatch(/Development mode/);
    expect(await publishJobs(id)).toHaveLength(0);
  });
});

describe("Schedule", () => {
  it("schedules at a local time, reschedules without duplicates, and unschedules", async () => {
    const id = await draft();
    const tomorrow = new Date(Date.now() + 86400_000);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala" }).format(tomorrow);
    const r = await post(`/admin/posts/${id}/schedule`, { at: `${day}T18:30` });
    expect(flash(r)).toMatch(/^Scheduled for .* 18:30 \(Africa\/Kampala\)$/);
    const expected = zonedToUtc(`${day}T18:30`, "Africa/Kampala");
    expect(new Date((await one<{ scheduled_for: Date }>("SELECT scheduled_for FROM posts WHERE id = $1", [id]))!.scheduled_for).toISOString()).toBe(expected.toISOString());
    let jobs = await publishJobs(id);
    expect(jobs).toHaveLength(1);
    expect(Math.abs(jobs[0].timestamp + (jobs[0].delay ?? 0) - expected.getTime())).toBeLessThan(5_000);
    expect((await app.inject({ url: `/admin/posts/${id}` })).body).toContain("Unschedule");

    await post(`/admin/posts/${id}/schedule`, { at: `${day}T20:00` });
    jobs = await publishJobs(id);
    expect(jobs).toHaveLength(1);
    expect(flash(await post(`/admin/posts/${id}/unschedule`))).toMatch(/Unscheduled/);
    expect(await publishJobs(id)).toHaveLength(0);
    expect(await one("SELECT status, scheduled_for FROM posts WHERE id = $1", [id])).toEqual({ status: "awaiting_review", scheduled_for: null });
    expect(flash(await post(`/admin/posts/${id}/schedule`, { at: "soon" }))).toMatch(/^Not saved/);
  });
});
