import { maybeInfluencer } from "../context.js";
import sharp from "sharp";
import { assertBudget, recordCost } from "../cost/ledger.js";
import { many, one } from "../db/pool.js";
import { sleep } from "../lib/async.js";
import { sha256 } from "../lib/crypto.js";
import { BudgetExceededError, errorMessage, PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { logger } from "../lib/logger.js";
import { download, hostImage } from "../storage/host.js";
import { adapter } from "./adapters/index.js";
import { MockAdapter } from "./adapters/mock.js";
import { listModels, policyFor, providerStates, updateHealth } from "./registry.js";
import { route, type Candidate, type RouteDecision } from "./router.js";
import {
  FALLBACK_ON,
  GenerationError,
  type AdapterJob,
  type ErrorClass,
  type GeneratedAsset,
  type GenerationRequest,
  type GenerationResult,
} from "./types.js";

/**
 * Generation Service (brief v2 §2 reference flow, §7 lifecycle):
 *   request → ownership check → idempotent request row → route → for each
 *   candidate: budget → submit → persist provider id → poll → retrieve →
 *   durable asset store → cost + health → done, or fall back to the next
 *   eligible model on a qualifying failure.
 */

let pollDelays = [2000, 3000, 4000, 6000, 8000, 10000, 12000, 15000];
export function setPollDelays(d: number[]): void {
  pollDelays = d;
}

interface RequestRow {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  provider_id: string | null;
  model_id: string | null;
  asset_ids: string[];
  cost_usd: number;
  attempts: number;
  error: string | null;
}

export async function generate(req: GenerationRequest): Promise<GenerationResult> {
  const started = Date.now();
  const ctx = maybeInfluencer();
  if (ctx && ctx.id !== req.influencerId) throw new PermanentError(`generation for influencer ${req.influencerId} requested inside influencer ${ctx.id}'s context`);
  await assertReferencesOwned(req.influencerId, req.references);

  const existing = await one<RequestRow>("SELECT * FROM generation_requests WHERE idempotency_key = $1", [req.idempotencyKey]);
  if (existing && existing.status === "succeeded") return finishedResult(existing, started);
  if (existing && Number((existing as unknown as { influencer_id: number }).influencer_id) !== req.influencerId) {
    throw new PermanentError("idempotency key belongs to another influencer");
  }

  const reqRow =
    existing ??
    (await one<RequestRow>(
      `INSERT INTO generation_requests (influencer_id, idempotency_key, post_id, purpose, modality, request, status)
       VALUES ($1,$2,$3,$4,$5,$6,'running')
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now() RETURNING *`,
      [req.influencerId, req.idempotencyKey, req.postId ?? null, req.purpose, req.modality, JSON.stringify(redact(req))],
    ))!;
  await one("UPDATE generation_requests SET status = 'running', updated_at = now() WHERE id = $1 AND status <> 'succeeded'", [reqRow.id]);

  const [policy, models, providers] = await Promise.all([policyFor(req.influencerId), listModels(), providerStates()]);
  const decision = route(req, policy, models, providers);
  await one("UPDATE generation_requests SET route = $2 WHERE id = $1", [reqRow.id, JSON.stringify(summarizeRoute(decision))]);

  // A crashed earlier run may have a paid task in flight: finish it first.
  const inflight = await one<{ id: number; provider: string; model: string; provider_request_id: string; input: Record<string, unknown> }>(
    `SELECT id, provider, model, provider_request_id, input FROM generation_attempts
     WHERE request_id = $1 AND status = 'submitted' AND provider_request_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [reqRow.id],
  );
  const ordered: Candidate[] = [...decision.candidates];
  if (inflight) {
    const m = models.find((x) => x.provider_id === inflight.provider && x.model_id === inflight.model);
    if (m) {
      const idx = ordered.findIndex((c) => c.model.id === m.id);
      const resume = idx >= 0 ? ordered.splice(idx, 1)[0] : { model: m, score: 0, estimatedCostUsd: 0, reason: "resume" };
      ordered.unshift(resume);
    }
  }

  if (!ordered.length) {
    const why = decision.excluded.slice(0, 6).map((x) => `${x.model}: ${x.reason}`).join("; ") || "no models registered";
    await failRequest(reqRow.id, `no eligible model (${why})`);
    throw new GenerationError(`No eligible model for ${req.modality}: ${why}`, "unsupported");
  }

  let lastErr: GenerationError | undefined;
  const warnings: string[] = [];
  for (const cand of ordered) {
    const resumeThis = Boolean(inflight && inflight.provider === cand.model.provider_id && inflight.model === cand.model.model_id);
    try {
      const out = await attempt(req, reqRow.id, cand, resumeThis ? inflight! : undefined);
      await one(
        `UPDATE generation_requests SET status = 'succeeded', provider_id = $2, model_id = $3, asset_ids = $4, cost_usd = cost_usd + $5,
           attempts = attempts + 1, error = NULL, finished_at = now(), updated_at = now() WHERE id = $1`,
        [reqRow.id, cand.model.provider_id, cand.model.model_id, out.assets.map((a) => a.assetId), out.costUsd],
      );
      return {
        requestId: reqRow.id,
        provider: cand.model.provider_id,
        model: cand.model.model_id,
        providerRequestId: out.providerRequestId,
        assets: out.assets,
        costUsd: out.costUsd,
        latencyMs: Date.now() - started,
        attempts: (await one<{ attempts: number }>("SELECT attempts FROM generation_requests WHERE id = $1", [reqRow.id]))!.attempts,
        warnings,
      };
    } catch (e) {
      const ge = e instanceof GenerationError ? e : e instanceof BudgetExceededError ? new GenerationError(e.message, "budget") : new GenerationError(errorMessage(e), "provider", true);
      lastErr = ge;
      await one("UPDATE generation_requests SET attempts = attempts + 1, updated_at = now() WHERE id = $1", [reqRow.id]);
      const next = FALLBACK_ON.includes(ge.errorClass);
      warnings.push(`${cand.model.provider_id}/${cand.model.model_id}: ${ge.errorClass}`);
      await recordEvent(next ? "warn" : "error", "generation", next ? "Generation attempt failed; falling back" : "Generation failed", {
        requestId: reqRow.id,
        provider: cand.model.provider_id,
        model: cand.model.model_id,
        errorClass: ge.errorClass,
        error: ge.message.slice(0, 300),
      });
      if (!next) break;
    }
  }
  await failRequest(reqRow.id, lastErr?.message ?? "all candidates failed");
  throw lastErr ?? new GenerationError("all candidates failed", "provider");
}

async function attempt(
  req: GenerationRequest,
  requestId: string,
  cand: Candidate,
  resume?: { id: number; provider_request_id: string; input: Record<string, unknown> },
): Promise<{ assets: GeneratedAsset[]; costUsd: number; providerRequestId: string }> {
  const a = adapter(cand.model.provider_id);
  const job: AdapterJob = { model: cand.model, request: req, references: req.references };
  const t0 = Date.now();
  let attemptId: number;
  let providerRequestId: string;
  let meta: Record<string, unknown> | undefined;

  if (resume) {
    attemptId = resume.id;
    providerRequestId = resume.provider_request_id;
    meta = (resume.input?.meta as Record<string, unknown> | undefined) ?? undefined;
  } else {
    const est = a.estimateCost(job);
    if (req.maxCostUsd !== undefined && est > req.maxCostUsd) throw new GenerationError(`estimate $${est} over job ceiling $${req.maxCostUsd}`, "budget");
    if (est > 0) await assertBudget("image", est);
    const row = await one<{ id: number }>(
      `INSERT INTO generation_attempts (influencer_id, request_id, post_id, position, provider, model, prompt, input, attempt, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT count(*) + 1 FROM generation_attempts WHERE request_id = $2),'queued') RETURNING id`,
      [req.influencerId, requestId, req.postId ?? null, (req.metadata?.position as number | undefined) ?? null, cand.model.provider_id, cand.model.model_id, req.prompt, JSON.stringify({ references: req.references, route: cand.reason })],
    );
    attemptId = row!.id;
    try {
      const sub = await a.submit(job);
      providerRequestId = sub.providerRequestId;
      meta = sub.meta;
    } catch (e) {
      await closeAttempt(attemptId, "failed", e, Date.now() - t0);
      await updateHealth(cand.model.provider_id, cand.model.model_id, errorMessage(e));
      throw e;
    }
    // Persist immediately: a crash from here on resumes this task instead of paying again.
    await one("UPDATE generation_attempts SET status = 'submitted', provider_request_id = $2, key_index = $3, input = input || $4, updated_at = now() WHERE id = $1", [
      attemptId,
      providerRequestId,
      typeof meta?.keyIndex === "number" ? meta.keyIndex : null,
      JSON.stringify({ meta: meta ?? {} }),
    ]);
  }

  const deadline = Date.now() + (req.timeoutSeconds ?? (req.modality.includes("video") ? 1200 : 600)) * 1000;
  for (let i = 0; ; i++) {
    let st;
    try {
      st = await a.poll(job, providerRequestId, meta);
    } catch (e) {
      const ge = e instanceof GenerationError ? e : new GenerationError(errorMessage(e), "provider", true);
      if (ge.retryable && Date.now() < deadline) {
        await sleep(pollDelays[Math.min(i, pollDelays.length - 1)]);
        continue;
      }
      // Leave it `submitted`: a later run resumes it rather than paying again.
      throw ge;
    }
    if (st.state === "succeeded") {
      const assets = await storeAssets(req, requestId, cand, st.urls);
      const cost = st.costUsd ?? a.estimateCost(job);
      await one(
        "UPDATE generation_attempts SET status = 'success', result_urls = $2, cost_usd = $3, credits = $4, latency_ms = $5, error = NULL, updated_at = now() WHERE id = $1",
        [attemptId, st.urls, cost, st.units?.credits ?? null, Date.now() - t0],
      );
      await recordCost({
        category: "image",
        provider: cand.model.provider_id,
        model: cand.model.model_id,
        operation: `${req.purpose}.${req.modality}${(req.metadata?.retry as number | undefined) ? ".retry" : ""}`,
        units: { ...(st.units ?? {}), assets: assets.length },
        costUsd: cost,
        refType: req.postId ? "post" : "generation",
        refId: req.postId ?? requestId,
        influencerId: req.influencerId,
      });
      await updateHealth(cand.model.provider_id, cand.model.model_id);
      return { assets, costUsd: cost, providerRequestId };
    }
    if (st.state === "failed" || st.state === "cancelled") {
      const ge = new GenerationError(`${cand.model.provider_id}/${cand.model.model_id}: ${st.message}`, st.errorClass);
      await closeAttempt(attemptId, "failed", ge, Date.now() - t0);
      await updateHealth(cand.model.provider_id, cand.model.model_id, st.message);
      throw ge;
    }
    if (Date.now() > deadline) {
      const ge = new GenerationError(`${cand.model.provider_id}/${cand.model.model_id} still ${st.state} at timeout`, "timeout");
      await closeAttempt(attemptId, "failed", ge, Date.now() - t0);
      await updateHealth(cand.model.provider_id, cand.model.model_id, ge.message);
      throw ge;
    }
    await sleep(pollDelays[Math.min(i, pollDelays.length - 1)]);
  }
}

async function closeAttempt(id: number, status: "failed" | "cancelled", e: unknown, latency: number): Promise<void> {
  const cls: ErrorClass = e instanceof GenerationError ? e.errorClass : "provider";
  await one("UPDATE generation_attempts SET status = $2, error = $3, error_class = $4, latency_ms = $5, updated_at = now() WHERE id = $1", [
    id,
    status,
    errorMessage(e).slice(0, 500),
    cls,
    latency,
  ]);
}

async function failRequest(id: string, error: string): Promise<void> {
  await one("UPDATE generation_requests SET status = 'failed', error = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND status <> 'succeeded'", [
    id,
    error.slice(0, 1000),
  ]);
}

/** Copy provider output to durable storage immediately (provider URLs expire). */
async function storeAssets(req: GenerationRequest, requestId: string, cand: Candidate, urls: string[]): Promise<GeneratedAsset[]> {
  const out: GeneratedAsset[] = [];
  const slug = (await one<{ slug: string }>("SELECT slug FROM influencers WHERE id = $1", [req.influencerId]))?.slug ?? String(req.influencerId);
  for (const [i, url] of urls.entries()) {
    const isVideo = req.modality.includes("video");
    const bytes = url.startsWith("mock://") ? MockAdapter.images.get(url.slice(7)) : await download(url, isVideo ? 300 * 1024 * 1024 : 30 * 1024 * 1024, isVideo ? "video/" : "image/");
    if (!bytes) throw new GenerationError(`could not retrieve ${url}`, "provider", true);
    let width: number | undefined;
    let height: number | undefined;
    let mime = isVideo ? "video/mp4" : "image/jpeg";
    if (!isVideo) {
      const meta = await sharp(bytes).metadata().catch(() => undefined);
      if (!meta?.format) throw new GenerationError(`provider returned an undecodable image`, "provider", true);
      width = meta.width;
      height = meta.height;
      mime = meta.format === "png" ? "image/png" : meta.format === "webp" ? "image/webp" : "image/jpeg";
    }
    const ext = isVideo ? "mp4" : mime.split("/")[1].replace("jpeg", "jpg");
    const digest = sha256(bytes);
    const hosted = await hostImage(bytes, `influencers/${slug}/gen/${requestId}/${i}-${digest.slice(0, 10)}.${ext}`, { contentType: mime });
    const row = await one<{ id: string }>(
      `INSERT INTO assets (influencer_id, kind, url, storage_provider, storage_key, mime_type, width, height, sha256, provider, model, generation_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [req.influencerId, isVideo ? "video" : "image", hosted.url, hosted.provider, null, mime, width ?? null, height ?? null, digest, cand.model.provider_id, cand.model.model_id, requestId],
    );
    out.push({ assetId: row!.id, url: hosted.url, sourceUrl: url, bytes, mimeType: mime, width, height });
  }
  return out;
}

async function finishedResult(r: RequestRow, started: number): Promise<GenerationResult> {
  const assets = await many<{ id: string; url: string; mime_type: string; width: number | null; height: number | null }>(
    "SELECT id, url, mime_type, width, height FROM assets WHERE id = ANY($1)",
    [r.asset_ids],
  );
  const attempt = await one<{ provider_request_id: string }>(
    "SELECT provider_request_id FROM generation_attempts WHERE request_id = $1 AND status = 'success' ORDER BY id DESC LIMIT 1",
    [r.id],
  );
  return {
    requestId: r.id,
    provider: r.provider_id ?? "",
    model: r.model_id ?? "",
    providerRequestId: attempt?.provider_request_id ?? "",
    assets: assets.map((a) => ({ assetId: a.id, url: a.url, sourceUrl: a.url, mimeType: a.mime_type, width: a.width ?? undefined, height: a.height ?? undefined })),
    costUsd: Number(r.cost_usd),
    latencyMs: Date.now() - started,
    attempts: r.attempts,
    warnings: ["idempotent replay: returned the stored result"],
  };
}

/** Load bytes for a stored asset (idempotent replays return URLs only). */
export async function assetBytes(a: GeneratedAsset): Promise<Buffer> {
  return a.bytes ?? download(a.url);
}

/**
 * Isolation (brief v2 §14): every reference must be an asset or visual
 * reference owned by this influencer. A cross-influencer reference is a
 * critical failure, never a warning.
 */
export async function assertReferencesOwned(influencerId: number, refs: string[]): Promise<void> {
  if (!refs.length) return;
  const owned = await many<{ url: string }>(
    `SELECT url FROM visual_references WHERE influencer_id = $1 AND url = ANY($2)
     UNION SELECT url FROM assets WHERE influencer_id = $1 AND url = ANY($2)`,
    [influencerId, refs],
  );
  const set = new Set(owned.map((o) => o.url));
  const foreign = refs.filter((r) => !set.has(r));
  if (foreign.length) {
    logger.error({ influencerId, foreign }, "cross-influencer or unregistered reference blocked");
    await recordEvent("error", "generation", "Blocked a reference this influencer does not own", { influencerId, count: foreign.length });
    throw new PermanentError(`Reference not owned by influencer ${influencerId}: ${foreign[0].slice(0, 80)}`);
  }
}

function redact(req: GenerationRequest): Record<string, unknown> {
  return { ...req, prompt: req.prompt.slice(0, 4000) };
}

function summarizeRoute(d: RouteDecision) {
  return {
    mode: d.mode,
    candidates: d.candidates.map((c) => ({ model: `${c.model.provider_id}/${c.model.model_id}`, score: c.score, estimatedCostUsd: c.estimatedCostUsd, reason: c.reason })),
    excluded: d.excluded.slice(0, 30),
  };
}
