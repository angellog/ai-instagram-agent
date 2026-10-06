import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withInfluencer } from "../../src/context.js";
import { planContent } from "../../src/content/director.js";
import { publishPost } from "../../src/content/publish.js";
import { many, one } from "../../src/db/pool.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { ffmpegPath } from "../../src/media/video.js";
import { queue } from "../../src/queue/queues.js";
import { setStorageFetch } from "../../src/storage/host.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";
import { FakeInstagram } from "../helpers/fakeInstagram.js";

let app: FastifyInstance;
let fake: FakeInstagram;
let photo: Buffer;
let video: Buffer;

/** A multipart body like the browser sends. */
function multipart(fields: Record<string, string>, files: Array<{ name: string; type: string; bytes: Buffer }>) {
  const boundary = "----aiatest" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.bytes, Buffer.from("\r\n"));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
const upload = (fields: Record<string, string>, files: Array<{ name: string; type: string; bytes: Buffer }>) => app.inject({ method: "POST", url: "/admin/library", ...multipart(fields, files) });
const flash = (r: { headers: Record<string, unknown> }) => decodeURIComponent(String(r.headers.location).split("flash=")[1] ?? "");

beforeEach(async () => {
  await resetState({ mode: "human_approval", posting_window_start_hour: 0, posting_window_end_hour: 24 });
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
  photo ??= await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg().toBuffer();
  if (!video) {
    execFileSync(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=720x1280:rate=25", "-t", "5", "/tmp/aia-lib-test.mp4"]);
    video = readFileSync("/tmp/aia-lib-test.mp4");
    rmSync("/tmp/aia-lib-test.mp4");
  }
  // Hosted files are read back for the caption's vision check.
  setStorageFetch(async (url) => (String(url).endsWith(".mp4") ? new Response(new Uint8Array(video), { headers: { "content-type": "video/mp4" } }) : new Response(new Uint8Array(photo), { headers: { "content-type": "image/jpeg" } })));
  app ??= await buildServer();
});
afterAll(async () => {
  setStorageFetch(fetch);
  await app?.close();
  await teardown();
});

describe("content library", () => {
  it("takes photos for the influencer to post when it fits, and the director picks them up", async () => {
    const r = await upload({ title: "New shea butter jars", notes: "Restocked today at the shop.", mode: "ai", target: "auto" }, [
      { name: "a.jpg", type: "image/jpeg", bytes: photo },
      { name: "b.jpg", type: "image/jpeg", bytes: photo },
    ]);
    expect(flash(r)).toMatch(/will post it when it fits/);
    const item = await one<{ id: string; kind: string; status: string; files: Array<{ width: number; height: number }> }>("SELECT id, kind, status, files FROM library_items");
    expect(item).toMatchObject({ kind: "image", status: "ready" });
    expect(item!.files.map((f) => [f.width, f.height])).toEqual([[1080, 1350], [1080, 1350]]);

    const plan = await withInfluencer(1, () => planContent(new Date(), { operator: true }));
    expect(plan).toMatchObject({ status: "accepted", library: true });
    const post = await one<{ media_type: string; origin: string; status: string; caption: string }>("SELECT media_type, origin, status, caption FROM posts WHERE id = $1", ["postId" in plan ? plan.postId : ""]);
    expect(post).toMatchObject({ media_type: "CAROUSEL", origin: "library", status: "awaiting_review" });
    expect(post!.caption.length).toBeGreaterThan(5);
    expect(await one("SELECT status FROM library_items WHERE id = $1", [item!.id])).toEqual({ status: "planned" });
    const page = await app.inject({ url: "/admin/library" });
    expect(page.body).toContain("New shea butter jars");
  });

  it("writes the caption now for a set time, holds it for review, and publishes at that time", async () => {
    const at = new Date(Date.now() + 3 * 3600_000);
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at).replace(" ", "T");
    const r = await upload({ title: "Weekend offer poster", notes: "Must include: Saturday only.", mode: "scheduled", at: local, target: "feed" }, [{ name: "p.png", type: "image/png", bytes: photo }]);
    expect(flash(r)).toMatch(/waiting in Reviews for its time/);
    const post = await one<{ id: string; media_type: string; status: string; scheduled_for: Date }>("SELECT id, media_type, status, scheduled_for FROM posts WHERE origin = 'library'");
    expect(post).toMatchObject({ media_type: "IMAGE", status: "awaiting_review" });
    expect(Math.abs(new Date(post!.scheduled_for).getTime() - at.getTime())).toBeLessThan(60_000);
    const review = await one<{ id: number }>("SELECT id FROM safety_reviews WHERE subject_id = $1", [post!.id]);
    const { approveReview } = await import("../../src/web/reviews.js");
    await withInfluencer(1, () => approveReview(review!.id, "tester"));
    const job = (await queue("publish").getJobs(["delayed"])).find((j) => j.data.postId === post!.id)!;
    expect(job.opts.delay!).toBeGreaterThan(2.9 * 3600_000);
  });

  it("turns a video into a reel and publishes it as REELS, then marks the item posted", async () => {
    const r = await upload({ title: "Unboxing in the shop", mode: "ai" }, [{ name: "clip.mov", type: "video/quicktime", bytes: video }]);
    expect(flash(r)).toMatch(/Added/);
    const item = await one<{ id: string; kind: string; files: Array<{ width: number; height: number; duration_s: number }> }>("SELECT id, kind, files FROM library_items");
    expect(item!.files[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(item!.files[0].duration_s).toBeGreaterThan(4);
    const planned = await app.inject({ method: "POST", url: `/admin/library/${item!.id}/plan` });
    const postId = String(planned.headers.location).split("/admin/posts/")[1].split("?")[0];
    const post = await one<{ media_type: string }>("SELECT media_type FROM posts WHERE id = $1", [postId]);
    expect(post).toEqual({ media_type: "REEL" });
    await one("UPDATE posts SET status = 'approved' WHERE id = $1", [postId]);
    expect(await withInfluencer(1, () => publishPost(postId))).toBe("published");
    const m = [...fake.media.values()].at(-1)!;
    expect(m.params).toMatchObject({ media_type: "REELS", share_to_feed: true });
    expect(String(m.params!.video_url)).toMatch(/\.mp4$/);
    expect(m.params!.is_ai_generated).toBeUndefined(); // a real business video is not AI-generated
    expect(await one("SELECT status FROM library_items WHERE id = $1", [item!.id])).toEqual({ status: "posted" });
  });

  it("refuses mixed uploads, past times and reel material on a schedule, with a reason", async () => {
    expect(flash(await upload({ title: "x", mode: "ai" }, [{ name: "a.jpg", type: "image/jpeg", bytes: photo }, { name: "v.mp4", type: "video/mp4", bytes: video }]))).toMatch(/either photos or one video/);
    expect(flash(await upload({ title: "x", mode: "scheduled", at: "2020-01-01T10:00" }, [{ name: "a.jpg", type: "image/jpeg", bytes: photo }]))).toMatch(/already passed/);
    expect(flash(await upload({ title: "", mode: "ai" }, [{ name: "a.jpg", type: "image/jpeg", bytes: photo }]))).toMatch(/short title/);
    expect(await many("SELECT 1 FROM library_items")).toHaveLength(0);
  });

  it("keeps reel material out of the feed: the director never offers it", async () => {
    await upload({ title: "Settings screen recording", mode: "material" }, [{ name: "s.mp4", type: "video/mp4", bytes: video }]);
    expect(await one("SELECT reel_material, mode FROM library_items")).toEqual({ reel_material: true, mode: "ai" });
    const plan = await withInfluencer(1, () => planContent(new Date(), { operator: true }));
    expect("library" in plan && plan.library).toBeFalsy();
  });
});

