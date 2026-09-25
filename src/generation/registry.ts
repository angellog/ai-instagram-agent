import { many, one } from "../db/pool.js";
import { adapters, adapter } from "./adapters/index.js";
import { CATALOG, CATALOG_VERSION, PROVIDERS } from "./catalog.js";
import type { Policy, ProviderState } from "./router.js";
import type { ModelRow } from "./types.js";

/**
 * Model & Provider Registry (brief v2 §5). The code catalog seeds rows; the
 * database is the source of truth afterwards, so operators can enable,
 * disable, reorder and re-score models without a deploy. A catalog sync never
 * overwrites operator choices (enabled flag) or benchmark-measured scores.
 */

export async function syncCatalog(): Promise<{ providers: number; models: number }> {
  for (const p of PROVIDERS) {
    await one(
      `INSERT INTO generation_providers (id, display_name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
      [p.id, p.displayName],
    );
  }
  for (const m of CATALOG) {
    await one(
      `INSERT INTO generation_models (provider_id, model_id, display_name, capabilities, supported_ratios, resolution_options, max_duration,
         reference_limit, identity_score, quality_score, speed_score, cost_estimate_usd, cost_unit, enabled, version, catalog_version, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (provider_id, model_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         capabilities = EXCLUDED.capabilities,
         supported_ratios = EXCLUDED.supported_ratios,
         resolution_options = EXCLUDED.resolution_options,
         max_duration = EXCLUDED.max_duration,
         reference_limit = EXCLUDED.reference_limit,
         cost_estimate_usd = EXCLUDED.cost_estimate_usd,
         cost_unit = EXCLUDED.cost_unit,
         version = EXCLUDED.version,
         catalog_version = EXCLUDED.catalog_version,
         config = EXCLUDED.config,
         -- scores only follow the catalog until a benchmark or operator sets them
         identity_score = CASE WHEN generation_models.scores_source = 'catalog' THEN EXCLUDED.identity_score ELSE generation_models.identity_score END,
         quality_score  = CASE WHEN generation_models.scores_source = 'catalog' THEN EXCLUDED.quality_score  ELSE generation_models.quality_score END,
         speed_score    = CASE WHEN generation_models.scores_source = 'catalog' THEN EXCLUDED.speed_score    ELSE generation_models.speed_score END,
         updated_at = now()`,
      [
        m.provider,
        m.model,
        m.displayName,
        m.capabilities,
        m.ratios,
        m.resolutions ?? [],
        m.maxDuration ?? null,
        m.referenceLimit,
        m.identity,
        m.quality,
        m.speed,
        m.costUsd,
        m.costUnit ?? "image",
        m.enabledByDefault ?? true,
        m.version ?? null,
        CATALOG_VERSION,
        JSON.stringify(m.config ?? {}),
      ],
    );
  }
  // Models removed from the catalog are deprecated, not deleted (history keeps pointing at them).
  await one(
    `UPDATE generation_models SET deprecated = true, updated_at = now()
     WHERE NOT ((provider_id, model_id) IN (SELECT * FROM unnest($1::text[], $2::text[])))`,
    [CATALOG.map((m) => m.provider), CATALOG.map((m) => m.model)],
  );
  return { providers: PROVIDERS.length, models: CATALOG.length };
}

export async function listModels(): Promise<ModelRow[]> {
  const rows = await many<ModelRow>("SELECT * FROM generation_models ORDER BY provider_id, id");
  return rows.map((r) => ({ ...r, cost_estimate_usd: Number(r.cost_estimate_usd) }));
}

export async function providerStates(): Promise<Map<string, ProviderState>> {
  const rows = await many<{ id: string; enabled: boolean; quarantined_until: Date | null; health_status: string }>(
    "SELECT id, enabled, quarantined_until, health_status FROM generation_providers",
  );
  const out = new Map<string, ProviderState>();
  for (const r of rows) {
    const a = adapters().get(r.id);
    out.set(r.id, {
      id: r.id,
      enabled: r.enabled,
      configured: a ? await a.isConfigured() : false,
      quarantinedUntil: r.quarantined_until,
      healthStatus: r.health_status,
    });
  }
  return out;
}

interface PolicyRow {
  mode: Policy["mode"];
  preferred_model_id: number | null;
  fallback_model_ids: number[];
  allowed_modalities: string[];
  quality_tier: Policy["qualityTier"];
  max_cost_per_job_usd: number;
}

/** Influencer policy, falling back to the platform default (influencer 0). */
export async function policyFor(influencerId: number): Promise<Policy> {
  const row =
    (await one<PolicyRow>("SELECT * FROM generation_policies WHERE influencer_id = $1", [influencerId])) ??
    (await one<PolicyRow>("SELECT * FROM generation_policies WHERE influencer_id = 0"));
  if (!row) {
    return { mode: "auto", preferredModelId: null, fallbackModelIds: [], allowedModalities: ["text_to_image", "reference_image", "image_edit", "upscale"], qualityTier: "high", maxCostPerJobUsd: 0.5 };
  }
  return {
    mode: row.mode,
    preferredModelId: row.preferred_model_id === null ? null : Number(row.preferred_model_id),
    fallbackModelIds: (row.fallback_model_ids ?? []).map(Number),
    allowedModalities: row.allowed_modalities,
    qualityTier: row.quality_tier,
    maxCostPerJobUsd: Number(row.max_cost_per_job_usd),
  };
}

export async function savePolicy(influencerId: number, p: Partial<Policy>): Promise<void> {
  const cur = await policyFor(influencerId);
  const next = { ...cur, ...p };
  await one(
    `INSERT INTO generation_policies (influencer_id, mode, preferred_model_id, fallback_model_ids, allowed_modalities, quality_tier, max_cost_per_job_usd, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (influencer_id) DO UPDATE SET mode = EXCLUDED.mode, preferred_model_id = EXCLUDED.preferred_model_id,
       fallback_model_ids = EXCLUDED.fallback_model_ids, allowed_modalities = EXCLUDED.allowed_modalities,
       quality_tier = EXCLUDED.quality_tier, max_cost_per_job_usd = EXCLUDED.max_cost_per_job_usd, updated_at = now()`,
    [influencerId, next.mode, next.preferredModelId, next.fallbackModelIds, next.allowedModalities, next.qualityTier, next.maxCostPerJobUsd],
  );
}

/** The KIE default the system shipped with: preferred for fresh installs (brief §17 step 12). */
export async function ensureDefaultPolicy(): Promise<void> {
  const cur = await one<{ preferred_model_id: number | null }>("SELECT preferred_model_id FROM generation_policies WHERE influencer_id = 0");
  if (cur?.preferred_model_id) return;
  const kie = await one<{ id: number }>("SELECT id FROM generation_models WHERE provider_id = 'kie' AND model_id = 'nano-banana-pro'");
  const fallbacks = await many<{ id: number }>(
    "SELECT id FROM generation_models WHERE (provider_id, model_id) IN (('kie','nano-banana-2'), ('fal','fal-ai/nano-banana-pro/edit'), ('replicate','google/nano-banana-pro')) ORDER BY id",
  );
  if (kie) await savePolicy(0, { mode: "preferred_fallback", preferredModelId: kie.id, fallbackModelIds: fallbacks.map((f) => f.id) });
}

// ------------------------------------------------------------------ health

const WINDOW = 20;
const MIN_SAMPLES = 5;
const QUARANTINE_MINUTES = 30;

export interface HealthStats {
  samples: number;
  successRate: number;
  timeoutRate: number;
  p50LatencyMs: number | null;
}

export async function healthStats(column: "provider" | "model", value: string): Promise<HealthStats> {
  const rows = await many<{ status: string; error_class: string | null; latency_ms: number | null }>(
    `SELECT status, error_class, latency_ms FROM generation_attempts
     WHERE ${column} = $1 AND status IN ('success','failed') AND created_at > now() - interval '24 hours'
     ORDER BY id DESC LIMIT ${WINDOW}`,
    [value],
  );
  const n = rows.length;
  const ok = rows.filter((r) => r.status === "success").length;
  const timeouts = rows.filter((r) => r.error_class === "timeout").length;
  const lat = rows.map((r) => r.latency_ms).filter((x): x is number => x !== null).sort((a, b) => a - b);
  return { samples: n, successRate: n ? ok / n : 1, timeoutRate: n ? timeouts / n : 0, p50LatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : null };
}

export function statusFor(s: HealthStats): "unknown" | "healthy" | "degraded" | "unavailable" {
  if (s.samples < MIN_SAMPLES) return s.samples === 0 ? "unknown" : s.successRate >= 0.5 ? "healthy" : "degraded";
  if (s.successRate >= 0.8) return "healthy";
  if (s.successRate >= 0.4) return "degraded";
  return "unavailable";
}

/**
 * Recompute rolling health after every attempt. A provider/model crossing the
 * failure threshold is quarantined for a while so routing skips it
 * automatically; it re-enters on its own when the quarantine lapses.
 */
export async function updateHealth(providerId: string, modelId: string, lastError?: string): Promise<void> {
  for (const [kind, id] of [["provider", providerId], ["model", modelId]] as const) {
    const s = await healthStats(kind, id);
    const status = statusFor(s);
    const quarantine = status === "unavailable" && s.samples >= MIN_SAMPLES;
    if (kind === "provider") {
      await one(
        `UPDATE generation_providers SET health_status = $2,
           quarantined_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE quarantined_until END,
           last_success_at = CASE WHEN $5::text IS NULL THEN now() ELSE last_success_at END,
           last_error = coalesce($5, last_error), last_error_at = CASE WHEN $5::text IS NULL THEN last_error_at ELSE now() END,
           verified = verified OR $5::text IS NULL, updated_at = now()
         WHERE id = $1`,
        [id, status, quarantine, String(QUARANTINE_MINUTES), lastError ?? null],
      );
    } else {
      await one(
        `UPDATE generation_models SET health_status = $3,
           quarantined_until = CASE WHEN $4 THEN now() + ($5 || ' minutes')::interval ELSE quarantined_until END, updated_at = now()
         WHERE provider_id = $1 AND model_id = $2`,
        [providerId, id, status, quarantine, String(QUARANTINE_MINUTES)],
      );
    }
  }
}

export async function validateProvider(id: string): Promise<{ ok: boolean; detail: string }> {
  const a = adapter(id);
  if (!(await a.isConfigured())) return { ok: false, detail: "not configured" };
  const r = await a.validateCredentials().catch((e) => ({ ok: false, detail: (e as Error).message }));
  await one("UPDATE generation_providers SET last_verified_at = now(), last_error = CASE WHEN $2 THEN last_error ELSE $3 END, updated_at = now() WHERE id = $1", [
    id,
    r.ok,
    r.detail,
  ]);
  return r;
}
