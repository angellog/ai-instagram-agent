import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { many, one } from "../../src/db/pool.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { JOBS, queue } from "../../src/queue/queues.js";
import { HANDLERS } from "../../src/queue/worker.js";
import { setStorageFetch } from "../../src/storage/host.js";
import { buildServer } from "../../src/web/server.js";
import { FakeInstagram } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

/** Before approval the operator can fix the caption, reorder or remove slides, change a story's words, or delete it. */
let app: FastifyInstance;
beforeEach(async () => {
  await resetState({ mode: "human_approval", posting_window_start_hour: 0, posting_window_end_hour: 24 });
  setInstagramClient(new FakeInstagram().client());
  const jpeg = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 90, g: 120, b: 140 } } }).jpeg().toBuffer();
  setStorageFetch(async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } }));
  app ??= await buildServer();
});
afterAll(async () => {
  await app?.close();
  setStorageFetch(fetch);
  await teardown();
});

const form = (url: string, body: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const flash = (r: { headers: Record<string, unknown> }) => new URLSearchParams(String(r.headers.location ?? "").split("?")[1]?.split("#")[0] ?? "").get("flash") ?? "";

/** A 3-slide carousel waiting for review, with its review open. */
async function carousel(): Promise<string> {
  const p = (await one<{ id: string }>("INSERT INTO posts (influencer_id, media_type, caption, status, safety_level) VALUES (1, 'CAROUSEL', 'first draft', 'awaiting_review', 'green') RETURNING id"))!;
  for (const i of [0, 1, 2]) await one("INSERT INTO post_assets (post_id, position, public_url, width, height) VALUES ($1, $2, $3, 1080, 1350)", [p.id, i, `https://x/${"abc"[i]}.jpg`]);
  await one(
    "INSERT INTO safety_reviews (influencer_id, subject_type, subject_id, level, categories, proposed, status) VALUES (1, 'post', $1, 'green', '{}', $2, 'pending')",
    [p.id, JSON.stringify({ caption: "first draft", slides: ["https://x/a.jpg", "https://x/b.jpg", "https://x/c.jpg"] })],
  );
  return p.id;
}
const order = async (id: string) => (await many<{ public_url: string }>("SELECT public_url FROM post_assets WHERE post_id = $1 ORDER BY position", [id])).map((r) => r.public_url.slice(-5, -4)).join("");

describe("editing a post before approval", () => {
  it("shows the editor on the post page, and only while it's editable", async () => {
    const id = await carousel();
    const page = (await app.inject({ url: `/admin/posts/${id}` })).body;
    expect(page).toContain(`action="/admin/posts/${id}/caption"`);
    expect(page).toContain(`/admin/posts/${id}/slides/1/move`);
    expect(page).toContain("Make slide 3 the cover");
    expect(page).toContain(`/admin/posts/${id}/delete`);
    await one("UPDATE posts SET status = 'published', ig_media_id = 'm1' WHERE id = $1", [id]);
    const done = (await app.inject({ url: `/admin/posts/${id}` })).body;
    expect(done).not.toContain(`action="/admin/posts/${id}/caption"`);
    expect(done).not.toContain(`/admin/posts/${id}/delete`);
  });

  it("saves a caption, keeps the review in step, and refuses what Instagram or safety would", async () => {
    const id = await carousel();
    expect(flash(await form(`/admin/posts/${id}/caption`, { caption: "  new laces, same me  \n\n#sneakers" }))).toBe("Caption saved");
    expect(await one("SELECT caption FROM posts WHERE id = $1", [id])).toEqual({ caption: "new laces, same me  \n\n#sneakers" });
    const review = await app.inject({ url: "/admin/reviews" });
    expect(review.body).toContain("new laces, same me");
    expect(flash(await form(`/admin/posts/${id}/caption`, { caption: "" }))).toMatch(/can't be empty/);
    expect(flash(await form(`/admin/posts/${id}/caption`, { caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ") }))).toMatch(/30 hashtags/);
    expect(flash(await form(`/admin/posts/${id}/caption`, { caption: "go kill yourself" }))).toMatch(/red/);
    expect(await one("SELECT caption FROM posts WHERE id = $1", [id])).toEqual({ caption: "new laces, same me  \n\n#sneakers" });
    const trail = await many<{ action: string }>("SELECT action FROM agent_decisions WHERE subject_id = $1", [id]);
    expect(trail.map((t) => t.action)).toContain("edit_caption");
  });

  it("reorders slides, makes a cover, and removes one", async () => {
    const id = await carousel();
    expect(flash(await form(`/admin/posts/${id}/slides/0/move`, { to: "1" }))).toBe("Moved slide 1 to position 2");
    expect(await order(id)).toBe("bac");
    expect(flash(await form(`/admin/posts/${id}/slides/2/move`, { to: "0" }))).toBe("Slide 3 is now the cover");
    expect(await order(id)).toBe("cba");
    const snap = await one<{ slides: string[] }>("SELECT proposed->'slides' AS slides FROM safety_reviews WHERE subject_id = $1", [id]);
    expect(snap!.slides).toEqual(["https://x/c.jpg", "https://x/b.jpg", "https://x/a.jpg"]);
    expect(flash(await form(`/admin/posts/${id}/slides/9/move`, { to: "0" }))).toBe("No such slide");
    expect(flash(await form(`/admin/posts/${id}/slides/1/remove`))).toBe("Removed slide 2; 2 left");
    expect(await order(id)).toBe("ca");
  });

  it("won't edit an approved post until it's unscheduled", async () => {
    const id = await carousel();
    await one("UPDATE posts SET status = 'approved' WHERE id = $1", [id]);
    expect(flash(await form(`/admin/posts/${id}/caption`, { caption: "x" }))).toMatch(/unschedule it first/);
    expect(flash(await form(`/admin/posts/${id}/slides/0/move`, { to: "1" }))).toMatch(/unschedule it first/);
  });

  it("deletes a draft (and its schedule) but never something already on Instagram", async () => {
    const id = await carousel();
    await queue("publish").add(JOBS.postPublish, { influencerId: 1, postId: id }, { jobId: `publish-${id}-x`, delay: 3_600_000 });
    const r = await form(`/admin/posts/${id}/delete`);
    expect(flash(r)).toBe("Post deleted");
    expect(String(r.headers.location)).toMatch(/^\/admin\/posts\?/);
    expect(await one("SELECT 1 AS x FROM posts WHERE id = $1", [id])).toBeUndefined();
    expect(await one("SELECT status, reason FROM safety_reviews WHERE subject_id = $1", [id])).toEqual({ status: "rejected", reason: "deleted by operator" });
    expect((await queue("publish").getJobs(["delayed"])).filter((j) => j.data.postId === id)).toHaveLength(0);
    expect((await app.inject({ url: "/admin/reviews?status=all" })).statusCode).toBe(200);
    const live = await carousel();
    await one("UPDATE posts SET status = 'published', ig_media_id = 'm2' WHERE id = $1", [live]);
    expect(flash(await form(`/admin/posts/${live}/delete`))).toMatch(/already on Instagram/);
  });
});

describe("editing a story before approval", () => {
  async function story(): Promise<string> {
    const r = await form("/admin/create", { kind: "story" });
    const runId = String(r.headers.location).split("/").pop()!.split("?")[0];
    await HANDLERS[JOBS.contentCreate]({ name: JOBS.contentCreate, data: { influencerId: 1, runId } } as unknown as Job);
    return (await one<{ post_id: string }>("SELECT post_id FROM create_runs WHERE id = $1", [runId]))!.post_id;
  }

  it("re-renders the image with new words, from the original photo", async () => {
    const id = await story();
    const before = await one<{ public_url: string }>("SELECT public_url FROM post_assets WHERE post_id = $1", [id]);
    expect(flash(await form(`/admin/posts/${id}/story-text`, { text: "Laces first, coffee second" }))).toBe("Story text updated");
    const after = await one<{ public_url: string; width: number; height: number; overlay: { kind: string; heading: string } }>("SELECT public_url, width, height, overlay FROM post_assets WHERE post_id = $1", [id]);
    expect(after).toMatchObject({ width: 1080, height: 1920, overlay: { kind: "story", heading: "Laces first, coffee second" } });
    expect(after!.public_url).not.toBe(before!.public_url);
    expect(flash(await form(`/admin/posts/${id}/story-text`, { text: "" }))).toBe("Text removed from the story");
    expect(flash(await form(`/admin/posts/${id}/story-text`, { text: "Only 2 pairs left" }))).toMatch(/isn't in the business knowledge/);
    expect(flash(await form(`/admin/posts/${id}/caption`, { caption: "hi" }))).toMatch(/Stories have no caption/);
  });

  it("keeps photos of her text-free", async () => {
    await story();
    const her = await story(); // the mock's second story is a mirror fit check
    expect(flash(await form(`/admin/posts/${her}/story-text`, { text: "fit check" }))).toMatch(/No text on photos of her/);
  });

  it("deletes a story back to the Stories page", async () => {
    const id = await story();
    const r = await form(`/admin/posts/${id}/delete`);
    expect(flash(r)).toBe("Story deleted");
    expect(String(r.headers.location)).toMatch(/^\/admin\/stories/);
  });
});
