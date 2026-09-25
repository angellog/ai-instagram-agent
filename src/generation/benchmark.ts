import sharp from "sharp";
import { z } from "zod";
import { influencerId } from "../context.js";
import { many, one } from "../db/pool.js";
import { errorMessage, PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { llm } from "../llm/llm.js";
import { persona } from "../persona/loader.js";
import { activeSoul, soulContext } from "../souls/souls.js";
import { download } from "../storage/host.js";
import { listModels, providerStates } from "./registry.js";
import { estimateCost, incompatibility } from "./router.js";
import { assetBytes, generate } from "./service.js";
import type { GenerationRequest, ModelRow } from "./types.js";

/**
 * Benchmarks (brief v2 §11): the same small suite through several models,
 * judged by the vision model against the influencer's soul, budget-capped.
 * Measured scores are blended into the registry (scores_source = benchmark),
 * so the router's "auto"/"best_*" modes learn from real results.
 */

export interface BenchCase {
  id: string;
  prompt: (name: string, location: string) => string;
  identity: boolean;
}

export const SUITE: BenchCase[] = [
  {
    id: "portrait",
    identity: true,
    prompt: (n, loc) => `Candid iPhone photo of ${n}, head and shoulders, laughing naturally at a café table in ${loc}, soft window light, realistic skin texture.`,
  },
  {
    id: "outfit",
    identity: true,
    prompt: (n, loc) => `Full-body street-style photo of ${n} walking on a sidewalk in ${loc}, relaxed outfit and clean sneakers, late-afternoon light, shot on a phone.`,
  },
  {
    id: "detail",
    identity: false,
    prompt: (_n, loc) => `Close-up phone photo of a pair of white sneakers on a wooden bench in ${loc}, shallow depth of field, natural light, no people.`,
  },
];

export const judgeSchema = z.object({
  identity: z.number().min(0).max(10).describe("same person as REFERENCE (10 = unmistakably the same); 0 if not applicable"),
  photorealism: z.number().min(0).max(10),
  adherence: z.number().min(0).max(10).describe("matches the brief"),
  notes: z.string().max(300),
});

async function judge(image: Buffer, reference: Buffer | undefined, brief: string, identity: boolean, refId: string) {
  const small = async (b: Buffer) => (await sharp(b).resize(768, 960, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer()).toString("base64");
  const images = [];
  if (identity && reference) images.push({ mediaType: "image/jpeg" as const, data: await small(reference), label: "REFERENCE" });
  images.push({ mediaType: "image/jpeg" as const, data: await small(image), label: "CANDIDATE" });
  return llm().structured(judgeSchema, {
    operation: "benchmark.judge",
    tier: "smart",
    maxTokens: 300,
    images,
    ref: { type: "benchmark", id: refId },
    system: "You grade AI-generated photos for a realistic lifestyle Instagram account. Be strict and consistent. Return JSON.",
    prompt: `${identity && reference ? "Images: REFERENCE (the person) and CANDIDATE." : "Image: CANDIDATE."}\nBrief: ${brief}\nScore 0–10 each: identity (${identity ? "is the CANDIDATE the same person as the REFERENCE" : "not applicable: answer 0"}), photorealism (would pass as a real phone photo), adherence (matches the brief).`,
  });
}

export interface BenchPlan {
  models: Array<{ model: ModelRow; estimate: number }>;
  skipped: Array<{ model: string; reason: string }>;
  estimate: number;
}

/** Which models can run the suite and what it would cost (shown before running). */
export async function planBenchmark(modelIds: number[]): Promise<BenchPlan> {
  const [models, providers] = await Promise.all([listModels(), providerStates()]);
  const soul = await activeSoul();
  const out: BenchPlan = { models: [], skipped: [], estimate: 0 };
  for (const id of modelIds) {
    const m = models.find((x) => x.id === id);
    if (!m) continue;
    const probe = request(m, SUITE[0], soul?.identityRefs ?? [], "plan");
    const why = incompatibility(m, probe, providers.get(m.provider_id));
    if (why) {
      out.skipped.push({ model: `${m.provider_id}/${m.model_id}`, reason: why });
      continue;
    }
    const est = SUITE.reduce((s, c) => s + estimateCost(m, request(m, c, soul?.identityRefs ?? [], "plan")), 0);
    out.models.push({ model: m, estimate: est });
    out.estimate += est;
  }
  return out;
}

function request(m: ModelRow, c: BenchCase, refs: string[], tag: string, soul?: ReturnType<typeof soulContext>): GenerationRequest {
  const p = persona();
  return {
    influencerId: influencerId(),
    idempotencyKey: `bench:${tag}:${m.id}:${c.id}`,
    purpose: "benchmark",
    modality: c.identity && refs.length ? "reference_image" : "text_to_image",
    prompt: c.prompt(p.identity.name, p.identity.location),
    references: c.identity ? refs : [],
    soul: c.identity ? soul : undefined,
    aspectRatio: "4:5",
    resolution: "1K",
    quality: "standard",
    identityConsistency: c.identity ? "high" : "low",
    pinModelId: m.id,
  };
}

/** `generation.benchmark` job: run the suite for the given models inside the current influencer. */
export async function runBenchmark(modelIds: number[], maxUsd: number, tag = String(Date.now())): Promise<{ runs: number; failed: number; spent: number }> {
  const plan = await planBenchmark(modelIds);
  if (!plan.models.length) throw new PermanentError(`nothing to benchmark (${plan.skipped.map((s) => `${s.model}: ${s.reason}`).join("; ") || "no models selected"})`);
  if (plan.estimate > maxUsd) throw new PermanentError(`suite would cost ~$${plan.estimate.toFixed(2)}, over the $${maxUsd.toFixed(2)} cap`);
  const soul = await activeSoul();
  const reference = soul?.primaryRef ? await download(soul.primaryRef).catch(() => undefined) : undefined;
  let runs = 0;
  let failed = 0;
  let spent = 0;
  for (const { model: m } of plan.models) {
    const scores: Array<{ identity: number; photorealism: number; adherence: number; latency: number }> = [];
    for (const c of SUITE) {
      const req = request(m, c, soul?.identityRefs ?? [], tag, soulContext(soul));
      const started = Date.now();
      try {
        const r = await generate(req);
        spent += r.costUsd;
        const bytes = await assetBytes(r.assets[0]);
        const j = await judge(bytes, reference, req.prompt, c.identity, `${tag}:${m.id}:${c.id}`);
        scores.push({ identity: j.identity, photorealism: j.photorealism, adherence: j.adherence, latency: r.latencyMs });
        await one(
          `INSERT INTO benchmark_runs (influencer_id, model_row_id, suite, case_id, prompt, asset_url, scores, cost_usd, latency_ms, status)
           VALUES ($1,$2,'core-v1',$3,$4,$5,$6,$7,$8,'succeeded')`,
          [influencerId(), m.id, c.id, req.prompt, r.assets[0].url, JSON.stringify({ ...j, overall: overall(j, c.identity) }), r.costUsd, Date.now() - started],
        );
      } catch (e) {
        failed++;
        await one(
          `INSERT INTO benchmark_runs (influencer_id, model_row_id, suite, case_id, prompt, cost_usd, latency_ms, status, error) VALUES ($1,$2,'core-v1',$3,$4,0,$5,'failed',$6)`,
          [influencerId(), m.id, c.id, req.prompt, Date.now() - started, errorMessage(e).slice(0, 500)],
        );
      }
      runs++;
    }
    if (scores.length >= 2) await applyScores(m, scores);
  }
  await recordEvent("info", "benchmark", `Benchmark ${tag} finished`, { runs, failed, spent });
  return { runs, failed, spent };
}

function overall(j: { identity: number; photorealism: number; adherence: number }, identity: boolean): number {
  const v = identity ? j.identity * 0.45 + j.photorealism * 0.35 + j.adherence * 0.2 : j.photorealism * 0.6 + j.adherence * 0.4;
  return Math.round(v * 10) / 10;
}

/** Blend measured scores (0..1) into the registry: half old, half new; speed from median latency. */
async function applyScores(m: ModelRow, s: Array<{ identity: number; photorealism: number; adherence: number; latency: number }>): Promise<void> {
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
  const ids = s.filter((x) => x.identity > 0).map((x) => x.identity / 10);
  const quality = avg(s.map((x) => (x.photorealism * 0.6 + x.adherence * 0.4) / 10));
  const lat = [...s.map((x) => x.latency)].sort((a, b) => a - b)[Math.floor(s.length / 2)];
  const speed = Math.max(0.1, Math.min(1, 1 - (lat - 15_000) / 180_000));
  const blend = (old: number, now: number) => Math.round((old * 0.5 + now * 0.5) * 1000) / 1000;
  await one(
    `UPDATE generation_models SET identity_score = $2, quality_score = $3, speed_score = $4, scores_source = 'benchmark', updated_at = now() WHERE id = $1`,
    [m.id, ids.length ? blend(m.identity_score, avg(ids)) : m.identity_score, blend(m.quality_score, quality), blend(m.speed_score, speed)],
  );
}

export async function benchmarkResults(limit = 60) {
  return many<{ id: number; model: string; case_id: string; asset_url: string | null; scores: Record<string, number>; cost_usd: number; latency_ms: number | null; status: string; error: string | null; created_at: Date }>(
    `SELECT b.id, m.provider_id || '/' || m.model_id AS model, b.case_id, b.asset_url, b.scores, b.cost_usd::float, b.latency_ms, b.status, b.error, b.created_at
     FROM benchmark_runs b JOIN generation_models m ON m.id = b.model_row_id
     WHERE b.influencer_id = $1 ORDER BY b.id DESC LIMIT $2`,
    [influencerId(), limit],
  );
}
