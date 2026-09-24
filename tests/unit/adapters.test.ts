import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { classifyMetaError, InstagramClient, TokenInvalidError } from "../../src/instagram/client.js";
import { KieClient, parseRecord } from "../../src/kie/client.js";
import { MODELS } from "../../src/kie/models.js";
import { normalizeWebhook, signRelay, verifyMetaSignature, verifyRelaySignature } from "../../src/ingest/webhook.js";
import { PermanentError, RateLimitedError, TransientError } from "../../src/lib/errors.js";
import { hmacSha256Hex } from "../../src/lib/crypto.js";
import { composeSlide, fit, inspectImage, sanitizeOverlayText, SLIDE_H, SLIDE_W } from "../../src/render/compose.js";
import { engagementScore } from "../../src/analytics/learnings.js";
import { FakeInstagram, commentPayload, dmPayload } from "../helpers/fakeInstagram.js";
import { FakeKie } from "../helpers/fakeKie.js";
import { TEST_IG_ID } from "../helpers/db.js";

describe("webhook normalization", () => {
  it("normalizes comments, replies and DMs", () => {
    const c = normalizeWebhook(commentPayload({ commentId: "c1", text: "fire", mediaId: "m1" }));
    expect(c).toEqual([expect.objectContaining({ kind: "comment", igObjectId: "c1", senderIgId: "9001", senderUsername: "kampala_kicks", mediaId: "m1" })]);
    expect(normalizeWebhook(commentPayload({ commentId: "c2", text: "yes", parentId: "c1" }))[0].kind).toBe("comment_reply");
    expect(normalizeWebhook(dmPayload({ mid: "mid.1", text: "hi" }))[0]).toEqual(expect.objectContaining({ kind: "dm", igObjectId: "mid.1", senderIgId: "9002" }));
  });
  it("drops echoes, own comments and unrelated objects", () => {
    expect(normalizeWebhook(dmPayload({ mid: "mid.2", text: "my own reply", echo: true }))).toEqual([]);
    expect(normalizeWebhook(commentPayload({ commentId: "c3", text: "x", fromId: TEST_IG_ID }))).toEqual([]);
    expect(normalizeWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(normalizeWebhook(null)).toEqual([]);
  });
});

describe("webhook signatures", () => {
  const body = JSON.stringify(commentPayload({ commentId: "c1", text: "x" }));
  it("accepts Meta's HMAC with the app secret and rejects tampering", () => {
    const sig = `sha256=${hmacSha256Hex("test-ig-secret", body)}`;
    expect(verifyMetaSignature(body, sig)).toBe(true);
    expect(verifyMetaSignature(body + " ", sig)).toBe(false);
    expect(verifyMetaSignature(body, undefined)).toBe(false);
  });
  it("accepts a fresh OpenReply relay signature and rejects replays", () => {
    expect(verifyRelaySignature(body, signRelay(body, "relay-secret"))).toBe(true);
    expect(verifyRelaySignature(body, signRelay(body, "wrong-secret"))).toBe(false);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyRelaySignature(body, signRelay(body, "relay-secret", old))).toBe(false);
  });
});

describe("Instagram client", () => {
  it("sends Bearer auth and JSON bodies, never tokens in URLs", async () => {
    const fake = new FakeInstagram();
    await fake.client().replyToComment("c1", "thanks!");
    const call = fake.calls[0];
    expect(call.path).toBe("/c1/replies");
    expect(call.body).toEqual({ message: "thanks!" });
    expect(JSON.stringify(call.query)).not.toContain("token");
  });
  it("classifies Meta errors into retry semantics", () => {
    expect(classifyMetaError(400, "/x", { code: 190, message: "expired" })).toBeInstanceOf(TokenInvalidError);
    expect(classifyMetaError(400, "/x", { code: 4 })).toBeInstanceOf(RateLimitedError);
    expect(classifyMetaError(400, "/x", { code: 9007 })).toBeInstanceOf(TransientError);
    expect(classifyMetaError(500, "/x")).toBeInstanceOf(TransientError);
    expect(classifyMetaError(400, "/x", { code: 100 })).toBeInstanceOf(PermanentError);
  });
  it("polls a container to FINISHED and fails on ERROR", async () => {
    const fake = new FakeInstagram();
    fake.processingPolls = 3;
    const ig = fake.client();
    const { id } = await ig.createImageContainer({ imageUrl: "https://x/1.jpg", caption: "c", isAiGenerated: true });
    expect(fake.calls[0].body).toMatchObject({ image_url: "https://x/1.jpg", caption: "c", is_ai_generated: true });
    expect(await ig.waitForContainer(id)).toBe("FINISHED");
    fake.containers.get(id)!.status = "ERROR";
    await expect(ig.waitForContainer(id)).rejects.toBeInstanceOf(PermanentError);
  });
  it("refuses carousels outside 2-10 children", async () => {
    await expect(new FakeInstagram().client().createCarouselContainer({ children: ["a"], caption: "" })).rejects.toBeInstanceOf(PermanentError);
  });
  it("falls back to per-metric insight requests when a metric is unsupported", async () => {
    const calls: string[] = [];
    const f = async (u: string | URL) => {
      const url = new URL(String(u));
      const m = url.searchParams.get("metric")!;
      calls.push(m);
      if (m.includes(",") || m === "views") return new Response(JSON.stringify({ error: { code: 100, message: "bad metric" } }), { status: 400 });
      return new Response(JSON.stringify({ data: [{ name: m, values: [{ value: 7 }] }] }));
    };
    const ig = new InstagramClient({ accessToken: "t", igUserId: "1", fetchImpl: f });
    expect(await ig.getMediaInsights("m1", ["reach", "views", "likes"])).toEqual({ reach: 7, likes: 7 });
    expect(calls).toEqual(["reach,views,likes", "reach", "views", "likes"]);
  });
});

describe("kie client", () => {
  it("treats an error envelope on HTTP 200 as an error", async () => {
    const fake = new FakeKie();
    fake.envelopeErrors = 1;
    const k = new KieClient({ keys: ["k1"], fetchImpl: fake.fetch });
    await expect(k.createTask("nano-banana-pro", {})).rejects.toBeInstanceOf(PermanentError);
  });
  it("fails over to the next key when one is out of credits", async () => {
    const fake = new FakeKie();
    fake.brokeKeys.add("k1");
    const k = new KieClient({ keys: ["k1", "k2"], fetchImpl: fake.fetch, pollDelaysMs: [1] });
    const t = await k.createTask("nano-banana-pro", { prompt: "x" });
    expect(t.keyIndex).toBe(1);
    const done = await k.waitForTask(t.taskId, t.keyIndex);
    expect(done.state).toBe("success");
    expect(done.resultUrls[0]).toMatch(/^https:\/\/files\.fake-kie\.test\//);
    expect(done.creditsConsumed).toBe(18);
  });
  it("is permanent when every key is out of credits", async () => {
    const fake = new FakeKie();
    fake.brokeKeys.add("k1").add("k2");
    await expect(new KieClient({ keys: ["k1", "k2"], fetchImpl: fake.fetch }).createTask("m", {})).rejects.toThrow(/All kie.ai keys/);
  });
  it("surfaces a failed task as permanent", async () => {
    const fake = new FakeKie();
    fake.failNextTasks = 1;
    const k = new KieClient({ keys: ["k1"], fetchImpl: fake.fetch, pollDelaysMs: [1] });
    const t = await k.createTask("nano-banana-pro", {});
    await expect(k.waitForTask(t.taskId, t.keyIndex)).rejects.toThrow(/content policy/);
  });
  it("parses resultJson whether it is a string or an object", () => {
    expect(parseRecord("t", { state: "success", resultJson: '{"resultUrls":["a"]}' }).resultUrls).toEqual(["a"]);
    expect(parseRecord("t", { state: "success", resultJson: { resultUrls: ["b"] } }).resultUrls).toEqual(["b"]);
  });
  it("maps reference images to each model's field name", () => {
    const r = { prompt: "p", referenceUrls: ["u1", "u2"], aspectRatio: "4:5" as const };
    expect(MODELS["nano-banana-pro"].build(r)).toMatchObject({ image_input: ["u1", "u2"], aspect_ratio: "4:5", output_format: "jpg" });
    expect(MODELS["google/nano-banana-edit"].build(r)).toMatchObject({ image_urls: ["u1", "u2"] });
    expect(MODELS["gpt-image-2-5-flare-image-to-image"].build(r)).toMatchObject({ input_urls: ["u1", "u2"], aspect_ratio: "3:4" });
  });
});

describe("slide composer", () => {
  const brand = { primary: "#FF5A1F", text: "#FFFFFF", shadow: "#000000" };
  it("outputs a 1080x1350 sRGB JPEG under 8 MB from any input aspect", async () => {
    const src = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#3366aa" } }).png().toBuffer();
    const { jpeg } = await composeSlide(src, { kind: "cover", heading: "Five things nobody tells you", counter: "1/5", handle: "@zuri" }, brand);
    const meta = await sharp(jpeg).metadata();
    expect([meta.format, meta.width, meta.height, meta.space]).toEqual(["jpeg", SLIDE_W, SLIDE_H, "srgb"]);
    expect(jpeg.length).toBeLessThan(8 * 1024 * 1024);
  });
  it("fits long headings by shrinking, then clipping with an ellipsis", () => {
    const f = fit("word ".repeat(80).trim(), [90, 60], 0.6, 900, 3);
    expect(f.lines).toHaveLength(3);
    expect(f.lines[2].endsWith("...")).toBe(true);
  });
  it("strips characters the bundled fonts cannot draw", () => {
    expect(sanitizeOverlayText("Rotation “check” — 🔥 go")).toBe('Rotation "check" - go');
  });
  it("flags blank or tiny generated images", async () => {
    const blank = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    expect((await inspectImage(blank)).problems).toContain("near-uniform image (blank or flat)");
    const tiny = await sharp({ create: { width: 200, height: 250, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    expect((await inspectImage(tiny)).ok).toBe(false);
    expect((await inspectImage(Buffer.from("not an image"))).ok).toBe(false);
  });
});

describe("engagement score", () => {
  it("rewards saves, shares and follows over likes, normalized by reach", () => {
    const likes = engagementScore({ reach: 1000, likes: 100 });
    const saves = engagementScore({ reach: 1000, likes: 40, saves: 20, shares: 10 });
    expect(saves).toBeGreaterThan(likes);
    expect(engagementScore({ reach: 100, likes: 20 })).toBeGreaterThan(engagementScore({ reach: 10000, likes: 20 }));
    expect(engagementScore({})).toBeGreaterThanOrEqual(0);
  });
});
