import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getControls, setControls } from "../../src/config/controls.js";
import { setSetting } from "../../src/config/settings.js";
import { withInfluencer } from "../../src/context.js";
import { postingGate } from "../../src/content/director.js";
import { publishPost } from "../../src/content/publish.js";
import { operatorPublish } from "../../src/content/schedule.js";
import { many, one } from "../../src/db/pool.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { persona } from "../../src/persona/loader.js";
import { setStorageFetch } from "../../src/storage/host.js";
import { refreshTikTokTokens, setTikTokFetch } from "../../src/tiktok/accounts.js";
import { setTikTokPollDelays } from "../../src/tiktok/publish.js";
import { buildServer } from "../../src/web/server.js";
import { signState } from "../../src/web/pages/tiktok.js";
import { FakeInstagram } from "../helpers/fakeInstagram.js";
import { FakeTikTok } from "../helpers/fakeTikTok.js";
import { resetState, teardown } from "../helpers/db.js";

let app: FastifyInstance;
let tt: FakeTikTok;
beforeEach(async () => {
  await resetState({ mode: "human_approval", posting_window_start_hour: 0, posting_window_end_hour: 24 });
  setInstagramClient(new FakeInstagram().client());
  tt = new FakeTikTok();
  setTikTokFetch(tt.fetch, "https://tiktok.fake");
  setTikTokPollDelays([1, 1]);
  const jpeg = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 120, g: 90, b: 70 } } }).jpeg().toBuffer();
  setStorageFetch(async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } }));
  await setSetting("TIKTOK_CLIENT_KEY", "ck_test");
  await setSetting("TIKTOK_CLIENT_SECRET", "cs_test");
  await setSetting("TIKTOK_MEDIA_BASE_URL", "https://media.salesgen.test");
  await setSetting("TIKTOK_APP_AUDITED", "no");
  await setSetting("LEGAL_COMPANY_NAME", "FeetBit Group");
  app ??= await buildServer();
});
afterAll(async () => {
  setTikTokFetch(undefined);
  setStorageFetch(fetch);
  await app?.close();
  await teardown();
});

const get = (url: string) => app.inject({ url });
const form = (url: string, body: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const flash = (r: { headers: Record<string, unknown> }) => new URLSearchParams(String(r.headers.location ?? "").split("?")[1]?.split("#")[0] ?? "").get("flash") ?? "";

async function connect(): Promise<void> {
  const r = await get(`/admin/tiktok/callback?code=good-code&state=${encodeURIComponent(signState(1))}`);
  expect(flash(r)).toBe("TikTok connected: @zuri.tt");
}
async function instagramPost(): Promise<string> {
  const p = (await one<{ id: string }>("INSERT INTO posts (influencer_id, media_type, caption, status, safety_level) VALUES (1, 'CAROUSEL', 'golden hour > everything', 'awaiting_review', 'green') RETURNING id"))!;
  for (const i of [0, 1]) await one("INSERT INTO post_assets (post_id, position, public_url, width, height) VALUES ($1, $2, $3, 1080, 1350)", [p.id, i, `https://x/${i}.jpg`]);
  return p.id;
}
async function tiktokPost(): Promise<string> {
  const src = await instagramPost();
  const r = await form(`/admin/posts/${src}/tiktok`);
  return String(r.headers.location).split("/admin/posts/")[1].split("?")[0];
}

describe("Log in with TikTok", () => {
  it("sends the operator to TikTok with a signed state and stores the account (tokens encrypted)", async () => {
    const start = await get("/admin/tiktok/connect");
    const url = new URL(String(start.headers.location));
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("ck_test");
    expect(url.searchParams.get("scope")).toContain("video.publish");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/admin\/tiktok\/callback$/);
    await connect();
    const acct = await one<{ username: string; access_token_enc: string; refresh_token_enc: string; creator_info: { privacy_level_options: string[] } }>("SELECT * FROM tiktok_accounts WHERE influencer_id = 1");
    expect(acct).toMatchObject({ username: "zuri.tt", creator_info: { privacy_level_options: expect.arrayContaining(["SELF_ONLY"]) } });
    expect(acct!.access_token_enc).not.toContain("act.");
    expect((await get("/admin/persona")).body).toMatch(/@zuri\.tt<\/b> <span class="pill ok">connected/);
  });

  it("refuses a forged or stale state and a bad code", async () => {
    expect(flash(await get("/admin/tiktok/callback?code=good-code&state=1.1.abc.deadbeef"))).toMatch(/expired or wasn't started here/);
    expect(flash(await get(`/admin/tiktok/callback?code=good-code&state=${encodeURIComponent(signState(1, Date.now() - 20 * 60_000))}`))).toMatch(/expired/);
    expect(flash(await get(`/admin/tiktok/callback?code=bad&state=${encodeURIComponent(signState(1))}`))).toMatch(/TikTok login failed/);
    expect(await one("SELECT 1 AS x FROM tiktok_accounts")).toBeUndefined();
  });
});

describe("Also post to TikTok", () => {
  it("re-frames the photos to 9:16, rewrites the caption the TikTok way, and waits for review", async () => {
    await connect();
    const src = await instagramPost();
    const r = await form(`/admin/posts/${src}/tiktok`);
    expect(flash(r)).toBe("TikTok version ready for review (2 photos)");
    const id = String(r.headers.location).split("/admin/posts/")[1].split("?")[0];
    const post = await one<{ platform: string; status: string; caption: string; source_post_id: string; tiktok: Record<string, unknown> }>("SELECT platform, status, caption, source_post_id, tiktok FROM posts WHERE id = $1", [id]);
    expect(post).toMatchObject({ platform: "tiktok", status: "awaiting_review", source_post_id: src, tiktok: { title: "New laces, same me", privacy: "PUBLIC_TO_EVERYONE", ai_label: true } });
    expect(post!.caption).toBe("Sunday reset, sneakers first 👟\n\n#sneakers #kampala #fitcheck");
    expect(await many("SELECT width, height FROM post_assets WHERE post_id = $1", [id])).toEqual([{ width: 1080, height: 1920 }, { width: 1080, height: 1920 }]);
    expect(await one("SELECT status FROM safety_reviews WHERE subject_id = $1", [id])).toEqual({ status: "pending" });
    // One TikTok version per post; the page links both ways.
    expect(flash(await form(`/admin/posts/${src}/tiktok`))).toMatch(/Already adapted/);
    expect((await get(`/admin/posts/${src}`)).body).toContain(`/admin/posts/${id}`);
    const page = (await get(`/admin/posts/${id}`)).body;
    expect(page).toContain("TikTok settings");
    expect(page).toContain("AI-generated label (always on)");
  });

  it("serves only TikTok frames on the media domain route", async () => {
    await connect();
    const id = await tiktokPost();
    const a = await one<{ sha256: string }>("SELECT sha256 FROM post_assets WHERE post_id = $1 AND position = 0", [id]);
    const img = await get(`/tiktok-media/${id}/1-${a!.sha256.slice(0, 10)}.jpg`);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/jpeg");
    const ig = await instagramPost();
    expect((await get(`/tiktok-media/${ig}/1-abc.jpg`)).statusCode).toBe(404);
    expect((await get(`/tiktok-media/${id}/../../etc.jpg`)).statusCode).toBe(404);
  });
});

describe("publishing to TikTok", () => {
  it("posts privately until the app is audited, always with the AI label, pulling photos from the verified domain", async () => {
    await connect();
    const id = await tiktokPost();
    expect((await withInfluencer(1, () => operatorPublish(id, "now", "test"))).ok).toBe(true);
    expect(await withInfluencer(1, () => publishPost(id))).toBe("published");
    expect(tt.inits).toHaveLength(1);
    const init = tt.inits[0];
    expect(init).toMatchObject({ post_mode: "DIRECT_POST", media_type: "PHOTO", post_info: { privacy_level: "SELF_ONLY", is_aigc: true, auto_add_music: true, title: "New laces, same me" } });
    expect(init.source_info.source).toBe("PULL_FROM_URL");
    expect(init.source_info.photo_images[0]).toMatch(new RegExp(`^https://media\\.salesgen\\.test/tiktok-media/${id}/1-[0-9a-f]{10}\\.jpg$`));
    const post = await one<{ status: string; permalink: string; note: string }>("SELECT status, permalink, tiktok->>'note' AS note FROM posts WHERE id = $1", [id]);
    expect(post).toMatchObject({ status: "published", permalink: "https://www.tiktok.com/@zuri.tt/photo/7450000000000000001", note: expect.stringMatching(/isn't audited/) });
  });

  it("uses the chosen privacy once audited, and never posts twice when TikTok is still processing", async () => {
    await setSetting("TIKTOK_APP_AUDITED", "yes");
    await connect();
    const id = await tiktokPost();
    await withInfluencer(1, () => operatorPublish(id, "now", "test"));
    tt.processingPolls = 5; // still downloading after our polls
    await expect(withInfluencer(1, () => publishPost(id))).rejects.toThrow(/still processing/);
    expect(await withInfluencer(1, () => publishPost(id))).toBe("published"); // the retry asks for the status…
    expect(tt.inits).toHaveLength(1); // …it doesn't start a second post
    expect(tt.inits[0].post_info.privacy_level).toBe("PUBLIC_TO_EVERYONE");
  });

  it("renews the 24h login automatically before posting", async () => {
    await connect();
    await one("UPDATE tiktok_accounts SET access_expires_at = now() - interval '1 minute'");
    const id = await tiktokPost();
    await withInfluencer(1, () => operatorPublish(id, "now", "test"));
    expect(await withInfluencer(1, () => publishPost(id))).toBe("published");
    expect(tt.refreshes).toBe(1);
    await one("UPDATE tiktok_accounts SET access_expires_at = now() + interval '1 hour'");
    expect(await refreshTikTokTokens()).toEqual({ refreshed: 1, failed: 0 });
  });

  it("marks TikTok disconnected when the login is ended, holds the post, and restores it on reconnect", async () => {
    await connect();
    const id = await tiktokPost();
    await withInfluencer(1, () => operatorPublish(id, "now", "test"));
    tt.revoked = true;
    expect(await withInfluencer(1, () => publishPost(id))).toBe("deferred");
    expect(await one("SELECT token_status FROM tiktok_accounts")).toEqual({ token_status: "invalid" });
    expect(await one<{ status: string; last_error: string }>("SELECT status, last_error FROM posts WHERE id = $1", [id])).toMatchObject({ status: "failed", last_error: expect.stringMatching(/^TikTok disconnected/) });
    expect((await get("/admin")).body).toContain("TikTok is disconnected for Zuri");
    tt.revoked = false;
    await connect();
    expect(await one("SELECT status FROM posts WHERE id = $1", [id])).toEqual({ status: "awaiting_review" });
    expect((await get("/admin")).body).not.toContain("TikTok is disconnected for Zuri");
  });

  it("TikTok posts in the pipeline never hold up Instagram posts", async () => {
    await connect();
    const id = await tiktokPost();
    // The Instagram original is already out; only its TikTok version is waiting.
    await one("UPDATE posts SET status = 'published', published_at = now() - interval '1 day' WHERE id = (SELECT source_post_id FROM posts WHERE id = $1)", [id]);
    await setControls({ mode: "dry_run" });
    await withInfluencer(1, async () => expect(await postingGate(await getControls(true), persona(), new Date())).toBeUndefined());
  });
});

describe("legal pages", () => {
  it("are public and name the company", async () => {
    for (const page of ["terms", "privacy"]) {
      const r = await app.inject({ url: `/legal/${page}`, cookies: {} });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain("FeetBit Group");
    }
    expect((await get("/legal/other")).statusCode).toBe(404);
  });
});
