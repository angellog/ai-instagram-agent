import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setControls } from "../../src/config/controls.js";
import { runInContext, loadInfluencer } from "../../src/context.js";
import { many, one } from "../../src/db/pool.js";
import { registerAdapter } from "../../src/generation/adapters/index.js";
import { MockAdapter } from "../../src/generation/adapters/mock.js";
import { healthStats, listModels, providerStates, savePolicy, statusFor, syncCatalog, updateHealth, validateProvider } from "../../src/generation/registry.js";
import { generate } from "../../src/generation/service.js";
import { GenerationError, type AdapterJob, type GenerationRequest, type ProviderAdapter } from "../../src/generation/types.js";
import { createInfluencer } from "../../src/influencers/manage.js";
import { activeSoul } from "../../src/souls/souls.js";
import { resetState, teardown } from "../helpers/db.js";

/** A second offline provider so fallback between providers can be exercised. */
class BackupAdapter implements ProviderAdapter {
  readonly id = "backup";
  readonly displayName = "Backup (test)";
  readonly credentialKeys: string[] = [];
  private inner = new MockAdapter();
  calls = 0;
  isConfigured = async () => true;
  validateCredentials = async () => ({ ok: true, detail: "ok" });
  estimateCost = (j: AdapterJob) => Number(j.model.cost_estimate_usd);
  submit = async (j: AdapterJob) => {
    this.calls++;
    return this.inner.submit(j);
  };
  poll = (j: AdapterJob, id: string) => this.inner.poll(j, id);
}

let backup: BackupAdapter;
let mockId: number;
let backupId: number;

beforeEach(async () => {
  await resetState();
  backup = new BackupAdapter();
  registerAdapter(backup);
  await one("INSERT INTO generation_providers (id, display_name) VALUES ('backup', 'Backup (test)') ON CONFLICT DO NOTHING");
  await one(
    `INSERT INTO generation_models (provider_id, model_id, display_name, capabilities, supported_ratios, reference_limit, identity_score, quality_score, speed_score, cost_estimate_usd)
     VALUES ('backup', 'backup-image', 'Backup image', '{text_to_image,reference_image}', '{}', 8, 0.5, 0.5, 0.5, 0) ON CONFLICT DO NOTHING`,
  );
  const models = await listModels();
  mockId = models.find((m) => m.model_id === "mock-image")!.id;
  backupId = models.find((m) => m.model_id === "backup-image")!.id;
  await savePolicy(1, { mode: "preferred_fallback", preferredModelId: mockId, fallbackModelIds: [backupId] });
});
afterAll(() => teardown());

async function faceRef(): Promise<string> {
  return (await activeSoul(1))!.identityRefs[0];
}

const request = async (p: Partial<GenerationRequest> = {}): Promise<GenerationRequest> => ({
  influencerId: 1,
  idempotencyKey: `test:${Math.random()}`,
  purpose: "manual",
  modality: "reference_image",
  prompt: "portrait by the window",
  references: [await faceRef()],
  aspectRatio: "4:5",
  quality: "high",
  identityConsistency: "high",
  ...p,
});

describe("generation engine", () => {
  it("routes, submits, stores a durable influencer-owned asset and records everything", async () => {
    const r = await generate(await request());
    expect(r).toMatchObject({ provider: "mock", model: "mock-image", attempts: 1 });
    expect(r.assets[0].url).toMatch(/\/influencers\/zuri\/gen\//);
    const asset = await one<{ influencer_id: number; mime_type: string; request_id: string }>("SELECT influencer_id, mime_type, generation_request_id AS request_id FROM assets WHERE id = $1", [r.assets[0].assetId]);
    expect(asset).toMatchObject({ influencer_id: 1, mime_type: "image/jpeg", request_id: r.requestId });
    const row = await one<{ status: string; route: { candidates: Array<{ model: string }> } }>("SELECT status, route FROM generation_requests WHERE id = $1", [r.requestId]);
    expect(row!.status).toBe("succeeded");
    expect(row!.route.candidates.map((c) => c.model)).toEqual(["mock/mock-image", "backup/backup-image"]);
    expect(await many("SELECT status FROM generation_attempts WHERE request_id = $1", [r.requestId])).toEqual([{ status: "success" }]);
  });

  it("is idempotent: the same key never pays twice", async () => {
    const req = await request({ idempotencyKey: "post:x:slide:0:try:1" });
    const a = await generate(req);
    const b = await generate(req);
    expect(b.assets[0].url).toBe(a.assets[0].url);
    expect(b.warnings[0]).toMatch(/idempotent replay/);
    expect(MockAdapter.submitted).toHaveLength(1);
  });

  it("falls back to the next model on a provider failure", async () => {
    MockAdapter.failNext.push({ errorClass: "provider", message: "upstream 500" });
    const r = await generate(await request());
    expect(r.provider).toBe("backup");
    expect(r.warnings).toEqual(["mock/mock-image: provider"]);
    expect(await many("SELECT provider, status, error_class FROM generation_attempts WHERE request_id = $1 ORDER BY id", [r.requestId])).toEqual([
      { provider: "mock", status: "failed", error_class: "provider" },
      { provider: "backup", status: "success", error_class: null },
    ]);
  });

  it("never falls back on a content-policy refusal", async () => {
    MockAdapter.failNext.push({ errorClass: "content_policy", message: "blocked" });
    await expect(generate(await request())).rejects.toMatchObject({ errorClass: "content_policy" });
    expect(backup.calls).toBe(0);
    expect(await one("SELECT status FROM generation_requests")).toEqual({ status: "failed" });
  });

  it("blocks references the influencer does not own (isolation is a hard failure)", async () => {
    await expect(generate(await request({ references: ["https://evil.example/someone-else.jpg"] }))).rejects.toThrow(/not owned/);
    const other = await createInfluencer({ name: "Amara" });
    await one("INSERT INTO visual_references (influencer_id, kind, url) VALUES ($1, 'identity', 'https://x/amara.jpg')", [other.id]);
    await expect(generate(await request({ references: ["https://x/amara.jpg"] }))).rejects.toThrow(/not owned by influencer 1/);
    expect(MockAdapter.submitted).toHaveLength(0);
  });

  it("refuses to run for one influencer inside another's context", async () => {
    const other = await createInfluencer({ name: "Kofi" });
    const zuri = await loadInfluencer(1);
    await expect(runInContext(zuri, async () => generate(await request({ influencerId: Number(other.id) })))).rejects.toThrow(/context/);
  });

  it("stops at the image budget before submitting", async () => {
    await one("UPDATE generation_models SET cost_estimate_usd = 0.5 WHERE id = $1", [mockId]);
    await one("UPDATE generation_models SET cost_estimate_usd = 0.5 WHERE id = $1", [backupId]);
    await setControls({ daily_image_budget_usd: 0.1 });
    await expect(generate(await request())).rejects.toMatchObject({ errorClass: "budget" });
    expect(MockAdapter.submitted).toHaveLength(0);
  });

  it("excludes models over the policy's per-job ceiling with a reason", async () => {
    await one("UPDATE generation_models SET cost_estimate_usd = 5 WHERE provider_id IN ('mock', 'backup')");
    await expect(generate(await request())).rejects.toMatchObject({ errorClass: "unsupported" });
    const route = (await one<{ route: { excluded: Array<{ reason: string }> } }>("SELECT route FROM generation_requests"))!.route;
    expect(route.excluded.some((x) => /over job budget/.test(x.reason))).toBe(true);
  });
});

describe("health & quarantine", () => {
  it("quarantines a provider after repeated failures and routes around it", async () => {
    for (let i = 0; i < 5; i++) {
      await one(
        "INSERT INTO generation_attempts (influencer_id, provider, model, prompt, status, error_class, latency_ms) VALUES (1, 'mock', 'mock-image', 'p', 'failed', 'provider', 100)",
      );
    }
    const s = await healthStats("provider", "mock");
    expect(s).toMatchObject({ samples: 5, successRate: 0 });
    expect(statusFor(s)).toBe("unavailable");
    await updateHealth("mock", "mock-image", "upstream down");
    const p = (await providerStates()).get("mock")!;
    expect(p.healthStatus).toBe("unavailable");
    expect(p.quarantinedUntil!.getTime()).toBeGreaterThan(Date.now());
    const r = await generate(await request());
    expect(r.provider).toBe("backup");
  });
});

describe("registry", () => {
  it("catalog sync keeps operator/benchmark scores and deprecates removed models", async () => {
    await one("UPDATE generation_models SET quality_score = 0.11, scores_source = 'benchmark' WHERE provider_id = 'kie' AND model_id = 'nano-banana-pro'");
    await one("INSERT INTO generation_models (provider_id, model_id, display_name, capabilities) VALUES ('kie', 'retired-model', 'Old', '{text_to_image}')");
    await syncCatalog();
    expect(await one("SELECT quality_score FROM generation_models WHERE model_id = 'nano-banana-pro' AND provider_id = 'kie'")).toEqual({ quality_score: 0.11 });
    expect(await one("SELECT deprecated FROM generation_models WHERE model_id = 'retired-model'")).toEqual({ deprecated: true });
  });

  it("lists all seven providers, only configured ones are routable, and validation reports missing keys", async () => {
    const ps = await providerStates();
    expect([...ps.keys()].sort()).toEqual(["backup", "fal", "higgsfield", "kie", "luma", "mock", "replicate", "runway", "topview"].sort());
    expect(ps.get("fal")!.configured).toBe(false);
    expect(await validateProvider("fal")).toEqual({ ok: false, detail: "not configured" });
  });

  it("an influencer policy overrides the platform default", async () => {
    const { policyFor } = await import("../../src/generation/registry.js");
    const other = await createInfluencer({ name: "Nia" });
    expect((await policyFor(Number(other.id))).mode).toBe((await policyFor(0)).mode);
    await savePolicy(Number(other.id), { mode: "best_value" });
    expect((await policyFor(Number(other.id))).mode).toBe("best_value");
  });
});

// Keep GenerationError referenced for type-only usage lint.
void GenerationError;
