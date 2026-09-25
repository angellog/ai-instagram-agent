import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { invalidateSettings } from "../../src/config/settings.js";
import { setGenerationFetch, classifyHttp } from "../../src/generation/adapters/http.js";
import { FalAdapter } from "../../src/generation/adapters/fal.js";
import { HiggsfieldAdapter } from "../../src/generation/adapters/higgsfield.js";
import { LumaAdapter } from "../../src/generation/adapters/luma.js";
import { ReplicateAdapter } from "../../src/generation/adapters/replicate.js";
import { RunwayAdapter } from "../../src/generation/adapters/runway.js";
import { TopviewAdapter } from "../../src/generation/adapters/topview.js";
import { buildInput } from "../../src/generation/adapters/kie.js";
import { mapInput, urlsFrom } from "../../src/generation/adapters/input.js";
import { CATALOG } from "../../src/generation/catalog.js";
import { setStorageFetch } from "../../src/storage/host.js";
import type { AdapterJob, GenerationRequest, ModelRow } from "../../src/generation/types.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let routes: Array<[RegExp, (c: Call) => unknown, number?]> = [];

function fake(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let body: any = init?.body;
  try {
    body = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    /* binary */
  }
  const c: Call = { url, method: init?.method ?? "GET", headers, body };
  calls.push(c);
  for (const [re, h, status] of routes) {
    if (re.test(url)) {
      const out = h(c);
      if (out instanceof Response) return Promise.resolve(out);
      return Promise.resolve(new Response(JSON.stringify(out), { status: status ?? 200, headers: { "content-type": "application/json" } }));
    }
  }
  return Promise.resolve(new Response(JSON.stringify({ error: "no route" }), { status: 404 }));
}

beforeAll(() => {
  Object.assign(process.env, {
    HIGGSFIELD_API_KEY: "hf-id",
    HIGGSFIELD_API_SECRET: "hf-secret",
    FAL_KEY: "fal-key",
    REPLICATE_API_TOKEN: "r8-token",
    RUNWAY_API_KEY: "rw-key",
    LUMA_API_KEY: "luma-key",
    TOPVIEW_API_KEY: "tv-key",
    TOPVIEW_UID: "tv-uid",
  });
  invalidateSettings();
  setGenerationFetch(fake);
});
afterAll(() => {
  for (const k of ["HIGGSFIELD_API_KEY", "HIGGSFIELD_API_SECRET", "FAL_KEY", "REPLICATE_API_TOKEN", "RUNWAY_API_KEY", "LUMA_API_KEY", "TOPVIEW_API_KEY", "TOPVIEW_UID"]) delete process.env[k];
  invalidateSettings();
  setGenerationFetch(undefined);
});
afterEach(() => {
  calls = [];
  routes = [];
});

let id = 0;
function row(provider: string, model: string): ModelRow {
  const m = CATALOG.find((x) => x.provider === provider && x.model === model)!;
  return {
    id: ++id,
    provider_id: m.provider,
    model_id: m.model,
    display_name: m.displayName,
    capabilities: m.capabilities,
    supported_ratios: m.ratios,
    resolution_options: m.resolutions ?? [],
    max_duration: m.maxDuration ?? null,
    reference_limit: m.referenceLimit,
    identity_score: m.identity,
    quality_score: m.quality,
    speed_score: m.speed,
    cost_estimate_usd: m.costUsd,
    cost_unit: m.costUnit ?? "image",
    enabled: true,
    health_status: "healthy",
    quarantined_until: null,
    deprecated: false,
    config: m.config ?? {},
  };
}
function job(provider: string, model: string, r: Partial<GenerationRequest> = {}): AdapterJob {
  const request: GenerationRequest = {
    influencerId: 1,
    idempotencyKey: "k",
    purpose: "post",
    modality: "reference_image",
    prompt: "a candid photo",
    references: ["https://cdn.test/face.jpg", "https://cdn.test/cover.jpg"],
    aspectRatio: "4:5",
    quality: "high",
    identityConsistency: "high",
    ...r,
  };
  return { model: row(provider, model), request, references: request.references };
}

describe("shared input mapping", () => {
  it("maps source/reference/ratio/duration fields declaratively", () => {
    const j = job("fal", "fal-ai/kling-video/v3/pro/image-to-video", { modality: "image_to_video", durationSeconds: 20, audio: true, negativePrompt: "blur" });
    expect(mapInput(j)).toMatchObject({ prompt: "a candid photo", start_image_url: "https://cdn.test/face.jpg", duration: "15", generate_audio: true, negative_prompt: "blur" });
    expect(buildInput(job("kie", "nano-banana-pro"))).toMatchObject({ image_input: ["https://cdn.test/face.jpg", "https://cdn.test/cover.jpg"], aspect_ratio: "4:5", resolution: "2K", output_format: "jpg" });
    expect(buildInput(job("kie", "bytedance/seedance-2-5", { modality: "image_to_video", durationSeconds: 8 }))).toMatchObject({
      first_frame_url: "https://cdn.test/face.jpg",
      reference_image_urls: ["https://cdn.test/cover.jpg"],
      duration: 8,
    });
  });
  it("finds output URLs in any provider shape", () => {
    expect(urlsFrom([{ url: "https://a/1.jpg" }], { url: "https://a/v.mp4" }, "https://a/2.jpg", { filePath: "https://a/3.jpg" }, "not a url")).toEqual([
      "https://a/1.jpg",
      "https://a/v.mp4",
      "https://a/2.jpg",
      "https://a/3.jpg",
    ]);
  });
  it("classifies HTTP failures for fallback decisions", () => {
    expect(classifyHttp(401, "")).toBe("auth");
    expect(classifyHttp(402, "")).toBe("auth");
    expect(classifyHttp(429, "")).toBe("rate_limit");
    expect(classifyHttp(504, "")).toBe("timeout");
    expect(classifyHttp(400, "nsfw content detected")).toBe("content_policy");
    expect(classifyHttp(422, "bad field")).toBe("validation");
    expect(classifyHttp(500, "")).toBe("provider");
  });
});

describe("Higgsfield", () => {
  it("uses Key id:secret auth, sends the Soul ID binding, maps statuses", async () => {
    const a = new HiggsfieldAdapter();
    routes.push([/higgsfield-ai\/soul\/v2\/standard$/, () => ({ status: "queued", request_id: "hf-1" })]);
    const j = job("higgsfield", "higgsfield-ai/soul/v2/standard", { modality: "text_to_image", references: [], soul: { soulId: "soul_zuri_v1", bindings: { higgsfield: { soul_id: "3eb3ad49-1111" } } } });
    expect(await a.submit(j)).toEqual({ providerRequestId: "hf-1" });
    expect(calls[0].headers.authorization).toBe("Key hf-id:hf-secret");
    expect(calls[0].body).toMatchObject({ prompt: "a candid photo", custom_reference_id: "3eb3ad49-1111", custom_reference_strength: 0.9, aspect_ratio: "9:16", batch_size: 1 });

    routes.push([/requests\/hf-1\/status/, () => ({ status: "completed", images: [{ url: "https://hf.cdn/1.jpg" }] })]);
    expect(await a.poll(j, "hf-1")).toEqual({ state: "succeeded", urls: ["https://hf.cdn/1.jpg"] });
    routes.unshift([/requests\/hf-2\/status/, () => ({ status: "nsfw" })]);
    expect(await a.poll(j, "hf-2")).toMatchObject({ state: "failed", errorClass: "content_policy" });
  });
  it("trains a Soul ID character and reads its status", async () => {
    const a = new HiggsfieldAdapter();
    routes.push([/custom-references$/, () => ({ id: "c0ffee", status: "queued" })], [/custom-references\/c0ffee$/, () => ({ id: "c0ffee", status: "completed", thumbnail_url: "https://t" })]);
    expect(await a.trainSoul("Zuri", ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"])).toEqual({ id: "c0ffee", status: "queued" });
    expect(calls[0].body).toEqual({ name: "Zuri", model_version: "v2", input_images: [{ type: "image_url", image_url: "https://cdn.test/a.jpg" }, { type: "image_url", image_url: "https://cdn.test/b.jpg" }] });
    expect(await a.soulStatus("c0ffee")).toMatchObject({ status: "completed", thumbnailUrl: "https://t" });
  });
});

describe("fal.ai", () => {
  it("submits to the queue and follows the returned status/response URLs", async () => {
    const a = new FalAdapter();
    routes.push([/queue\.fal\.run\/fal-ai\/nano-banana-pro\/edit$/, () => ({ request_id: "f1", status_url: "https://queue.fal.run/x/requests/f1/status", response_url: "https://queue.fal.run/x/requests/f1" })]);
    const j = job("fal", "fal-ai/nano-banana-pro/edit");
    const s = await a.submit(j);
    expect(calls[0].headers.authorization).toBe("Key fal-key");
    expect(calls[0].body).toMatchObject({ image_urls: ["https://cdn.test/face.jpg", "https://cdn.test/cover.jpg"], aspect_ratio: "4:5", num_images: 1 });
    routes.push([/requests\/f1\/status$/, () => ({ status: "IN_PROGRESS" })]);
    expect(await a.poll(j, s.providerRequestId, s.meta)).toEqual({ state: "processing" });
    routes = [[/requests\/f1\/status$/, () => ({ status: "COMPLETED" })], [/requests\/f1$/, () => ({ images: [{ url: "https://fal.media/1.jpg" }] })]];
    expect(await a.poll(j, s.providerRequestId, s.meta)).toEqual({ state: "succeeded", urls: ["https://fal.media/1.jpg"] });
  });
});

describe("Replicate", () => {
  it("creates an official-model prediction and reads output", async () => {
    const a = new ReplicateAdapter();
    routes.push([/models\/google\/nano-banana-pro\/predictions$/, () => ({ id: "p1", status: "starting" })], [/predictions\/p1$/, () => ({ status: "succeeded", output: "https://replicate.delivery/1.jpg" })]);
    const j = job("replicate", "google/nano-banana-pro");
    await a.submit(j);
    expect(calls[0].headers.authorization).toBe("Bearer r8-token");
    expect(calls[0].body.input).toMatchObject({ image_input: ["https://cdn.test/face.jpg", "https://cdn.test/cover.jpg"], allow_fallback_model: false });
    expect(await a.poll(j, "p1")).toEqual({ state: "succeeded", urls: ["https://replicate.delivery/1.jpg"] });
  });
});

describe("Runway", () => {
  it("tags references for gen4_image, maps ratios and safety failures", async () => {
    const a = new RunwayAdapter();
    routes.push([/\/v1\/text_to_image$/, () => ({ id: "t1" })], [/\/v1\/tasks\/t1$/, () => ({ status: "FAILED", failureCode: "SAFETY.INPUT.TEXT" })]);
    const j = job("runway", "gen4_image", { aspectRatio: "9:16" });
    await a.submit(j);
    expect(calls[0].headers).toMatchObject({ authorization: "Bearer rw-key", "x-runway-version": "2024-11-06" });
    expect(calls[0].body).toMatchObject({ model: "gen4_image", ratio: "1080:1920", referenceImages: [{ uri: "https://cdn.test/face.jpg", tag: "subject" }, { uri: "https://cdn.test/cover.jpg", tag: "ref1" }] });
    expect(calls[0].body.promptText).toMatch(/^@subject/);
    expect(await a.poll(j, "t1")).toMatchObject({ state: "failed", errorClass: "content_policy" });
  });
});

describe("Luma", () => {
  it("sends image_ref objects and maps moderation failures", async () => {
    const a = new LumaAdapter();
    routes.push([/\/v1\/generations$/, () => ({ id: "g1", state: "queued" })], [/\/v1\/generations\/g1$/, () => ({ state: "failed", failure_code: "content_moderated" })]);
    const j = job("luma", "uni-1");
    await a.submit(j);
    expect(calls[0].body).toMatchObject({ type: "image", model: "uni-1", aspect_ratio: "4:5", image_ref: [{ url: "https://cdn.test/face.jpg" }, { url: "https://cdn.test/cover.jpg" }] });
    expect(await a.poll(j, "g1")).toMatchObject({ state: "failed", errorClass: "content_policy" });
    expect(a.estimateCost(j)).toBeCloseTo(0.048);
  });
});

describe("Topview", () => {
  it("uploads references to file ids, submits an image edit and reads results", async () => {
    const a = new TopviewAdapter();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    setStorageFetch(async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } }));
    let n = 0;
    routes.push(
      [/upload\/credential/, () => ({ code: "200", result: { fileId: `file_${++n}`, uploadUrl: `https://s3.test/up/${n}` } })],
      [/s3\.test\/up/, () => new Response("", { status: 200 })],
      [/upload\/check/, () => ({ code: "200", result: true })],
      [/image_edit\/task\/submit$/, () => ({ code: "200", result: { taskId: "tv1", status: "init" } })],
      [/image_edit\/task\/query/, () => ({ code: "200", result: { status: "success", images: [{ status: "success", filePath: "https://tv.cdn/1.jpg" }] } })],
    );
    const j = job("topview", "nano-banana-pro");
    const s = await a.submit(j);
    const submit = calls.find((c) => /task\/submit/.test(c.url))!;
    expect(submit.headers).toMatchObject({ authorization: "Bearer tv-key", "topview-uid": "tv-uid" });
    expect(submit.body).toMatchObject({ model: "Nano Banana Pro", aspectRatio: "4:5", inputImageFileIds: ["file_1", "file_2"] });
    expect(await a.poll(j, s.providerRequestId, s.meta)).toEqual({ state: "succeeded", urls: ["https://tv.cdn/1.jpg"], units: undefined });
    routes.unshift([/image_edit\/task\/submit$/, () => ({ code: "4100", message: "Insufficient credits" })]);
    await expect(a.submit(j)).rejects.toMatchObject({ errorClass: "auth" });
    setStorageFetch(fetch);
  });
});

describe("credential checks are free calls", () => {
  it("validates each provider against its documented account endpoint", async () => {
    routes.push(
      [/custom-references\/list/, () => ({ total: 2 })],
      [/api\.fal\.ai\/v1\/account\/billing/, () => ({ credits: { current_balance: 12.5 } })],
      [/api\.replicate\.com\/v1\/account$/, () => ({ username: "feetbit" })],
      [/v1\/organization$/, () => ({ creditBalance: 1500 })],
      [/agents\.lumalabs\.ai\/v1\/files/, () => ({ data: [] })],
      [/v1\/tts\/list/, () => ({ code: "200", result: [] })],
    );
    expect((await new HiggsfieldAdapter().validateCredentials()).detail).toMatch(/2 Soul ID/);
    expect((await new FalAdapter().validateCredentials()).detail).toBe("balance $12.50");
    expect((await new ReplicateAdapter().validateCredentials()).detail).toMatch(/feetbit/);
    expect((await new RunwayAdapter().validateCredentials()).detail).toMatch(/1500 credits \(≈ \$15\.00\)/);
    expect((await new LumaAdapter().validateCredentials()).ok).toBe(true);
    expect((await new TopviewAdapter().validateCredentials()).ok).toBe(true);
  });
});
