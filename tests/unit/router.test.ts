import { describe, expect, it } from "vitest";
import { estimateCost, incompatibility, requiredCapabilities, route, type Policy, type ProviderState } from "../../src/generation/router.js";
import type { GenerationRequest, ModelRow } from "../../src/generation/types.js";

let seq = 0;
function model(p: Partial<ModelRow> & Pick<ModelRow, "provider_id" | "model_id">): ModelRow {
  return {
    id: ++seq,
    display_name: p.model_id,
    capabilities: ["text_to_image", "reference_image"],
    supported_ratios: ["4:5", "1:1", "9:16"],
    resolution_options: [],
    max_duration: null,
    reference_limit: 8,
    identity_score: 0.8,
    quality_score: 0.8,
    speed_score: 0.5,
    cost_estimate_usd: 0.1,
    cost_unit: "image",
    enabled: true,
    health_status: "healthy",
    quarantined_until: null,
    deprecated: false,
    config: {},
    ...p,
  };
}

const providers = (ids: string[], over: Partial<ProviderState> = {}) =>
  new Map(ids.map((id) => [id, { id, enabled: true, configured: true, quarantinedUntil: null, healthStatus: "healthy", ...over } as ProviderState]));

const policy = (p: Partial<Policy> = {}): Policy => ({
  mode: "auto",
  preferredModelId: null,
  fallbackModelIds: [],
  allowedModalities: ["text_to_image", "reference_image", "image_edit", "upscale", "image_to_video"],
  qualityTier: "high",
  maxCostPerJobUsd: 1,
  ...p,
});

const req = (p: Partial<GenerationRequest> = {}): GenerationRequest => ({
  influencerId: 1,
  idempotencyKey: "k",
  purpose: "post",
  modality: "reference_image",
  prompt: "a photo",
  references: ["https://x/face.jpg"],
  aspectRatio: "4:5",
  quality: "high",
  identityConsistency: "high",
  ...p,
});

describe("router: eligibility", () => {
  it("text_to_image with references needs reference_image; audio adds a capability", () => {
    expect(requiredCapabilities(req({ modality: "text_to_image" }))).toEqual(["reference_image"]);
    expect(requiredCapabilities(req({ modality: "image_to_video", audio: true }))).toEqual(["image_to_video", "audio"]);
  });

  it("explains every exclusion", () => {
    const now = new Date();
    const ps = providers(["a"]);
    expect(incompatibility(model({ provider_id: "a", model_id: "m", enabled: false }), req(), ps.get("a"), now)).toBe("model disabled");
    expect(incompatibility(model({ provider_id: "a", model_id: "m", deprecated: true }), req(), ps.get("a"), now)).toBe("model deprecated");
    expect(incompatibility(model({ provider_id: "b", model_id: "m" }), req(), undefined, now)).toBe("provider not registered");
    expect(incompatibility(model({ provider_id: "a", model_id: "m" }), req(), { ...ps.get("a")!, configured: false }, now)).toBe("provider has no credentials");
    expect(incompatibility(model({ provider_id: "a", model_id: "m" }), req(), { ...ps.get("a")!, quarantinedUntil: new Date(now.getTime() + 60_000) }, now)).toBe("provider quarantined");
    expect(incompatibility(model({ provider_id: "a", model_id: "m", capabilities: ["text_to_image"] }), req(), ps.get("a"), now)).toBe("lacks reference_image");
    expect(incompatibility(model({ provider_id: "a", model_id: "m", supported_ratios: ["16:9"] }), req(), ps.get("a"), now)).toBe("no 4:5 ratio");
    expect(incompatibility(model({ provider_id: "a", model_id: "m", capabilities: ["image_to_video"], max_duration: 5 }), req({ modality: "image_to_video", durationSeconds: 10 }), ps.get("a"), now)).toBe("max duration 5s");
  });

  it("a soul-capable model with the influencer's provider binding needs no reference capability and gets identity ≥ 0.95", () => {
    const soulModel = model({ provider_id: "higgsfield", model_id: "soul", capabilities: ["text_to_image", "soul"], identity_score: 0.5, reference_limit: 0 });
    const plain = model({ provider_id: "kie", model_id: "nb", identity_score: 0.8 });
    const soul = { soulId: "soul_zuri_v1", bindings: { higgsfield: { soul_id: "c0ffee" } } };
    const d = route(req({ soul }), policy(), [soulModel, plain], providers(["higgsfield", "kie"]));
    expect(d.candidates[0].model.model_id).toBe("soul");
    expect(d.candidates[0].reason).toBe("soul binding");
    // Without the binding the soul model cannot take a reference job.
    const d2 = route(req(), policy(), [soulModel, plain], providers(["higgsfield", "kie"]));
    expect(d2.candidates.map((c) => c.model.model_id)).toEqual(["nb"]);
    expect(d2.excluded).toContainEqual({ model: "higgsfield/soul", reason: "lacks reference_image" });
  });

  it("drops models over the job budget and refuses modalities the policy does not allow", () => {
    const cheap = model({ provider_id: "a", model_id: "cheap", cost_estimate_usd: 0.05 });
    const pricey = model({ provider_id: "a", model_id: "pricey", cost_estimate_usd: 2 });
    const d = route(req(), policy({ maxCostPerJobUsd: 0.5 }), [cheap, pricey], providers(["a"]));
    expect(d.candidates.map((c) => c.model.model_id)).toEqual(["cheap"]);
    expect(d.excluded[0].reason).toMatch(/over job budget/);
    expect(route(req({ modality: "text_to_video" }), policy(), [cheap], providers(["a"])).excluded[0].reason).toMatch(/not allowed by policy/);
  });

  it("per-second models are costed by duration", () => {
    const v = model({ provider_id: "a", model_id: "v", cost_unit: "second", cost_estimate_usd: 0.1, max_duration: 10 });
    expect(estimateCost(v, req({ durationSeconds: 8 }))).toBeCloseTo(0.8);
    expect(estimateCost(v, req())).toBeCloseTo(1);
  });
});

describe("router: modes", () => {
  const a = model({ provider_id: "a", model_id: "a", quality_score: 0.95, identity_score: 0.9, speed_score: 0.2, cost_estimate_usd: 0.3 });
  const b = model({ provider_id: "b", model_id: "b", quality_score: 0.7, identity_score: 0.7, speed_score: 0.9, cost_estimate_usd: 0.02 });
  const c = model({ provider_id: "c", model_id: "c", quality_score: 0.4, identity_score: 0.4, speed_score: 1, cost_estimate_usd: 0.01 });
  const ps = providers(["a", "b", "c"]);
  const ids = (mode: Policy["mode"], p: Partial<Policy> = {}) => route(req(), policy({ mode, ...p }), [a, b, c], ps).candidates.map((x) => x.model.model_id);

  it("fixed uses exactly the preferred model", () => {
    expect(ids("fixed", { preferredModelId: b.id })).toEqual(["b"]);
    expect(ids("fixed", { preferredModelId: 9999 })).toEqual([]);
  });
  it("preferred_fallback follows the chain, and falls back to auto when the chain is empty", () => {
    expect(ids("preferred_fallback", { preferredModelId: c.id, fallbackModelIds: [a.id] })).toEqual(["c", "a"]);
    expect(ids("preferred_fallback", { preferredModelId: 9999 })).toHaveLength(3);
  });
  it("best_quality, best_value, fastest", () => {
    expect(ids("best_quality")[0]).toBe("a");
    expect(ids("best_value")[0]).toBe("c");
    expect(ids("fastest")).toEqual(["b", "a"]); // fastest first; c is below the quality floor
  });
  it("a request-level preferred model jumps the queue; never more than 4 candidates", () => {
    expect(route(req({ preferred: { provider: "c", model: "c" } }), policy(), [a, b, c], ps).candidates[0].model.model_id).toBe("c");
    const many = Array.from({ length: 9 }, (_, i) => model({ provider_id: "a", model_id: `m${i}` }));
    expect(route(req(), policy(), many, providers(["a"])).candidates).toHaveLength(4);
  });
  it("is deterministic", () => {
    expect(ids("auto")).toEqual(ids("auto"));
  });
});
