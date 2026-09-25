import type { GenerationRequest, ModelRow, RoutingMode } from "./types.js";

/**
 * Intelligent Generation Router (brief v2 §6). Pure and deterministic: given
 * the request, the policy and the registry it returns an ordered candidate
 * list with a reason for every inclusion and exclusion. The LLM never picks a
 * provider; it only states intent and constraints.
 */

export interface Policy {
  mode: RoutingMode;
  preferredModelId: number | null;
  fallbackModelIds: number[];
  allowedModalities: string[];
  qualityTier: "draft" | "standard" | "high" | "max";
  maxCostPerJobUsd: number;
}

export interface ProviderState {
  id: string;
  enabled: boolean;
  configured: boolean;
  quarantinedUntil: Date | null;
  healthStatus: string;
}

export interface Candidate {
  model: ModelRow;
  score: number;
  estimatedCostUsd: number;
  reason: string;
}

export interface RouteDecision {
  mode: RoutingMode;
  candidates: Candidate[];
  excluded: Array<{ model: string; reason: string }>;
}

const MAX_CANDIDATES = 4;

export function requiredCapabilities(req: GenerationRequest): string[] {
  const caps: string[] = [req.modality];
  // Identity work needs a model that accepts references (or a provider-side soul).
  if (req.modality === "text_to_image" && req.references.length > 0) caps[0] = "reference_image";
  if (req.audio) caps.push("audio");
  return caps;
}

export function estimateCost(model: ModelRow, req: GenerationRequest): number {
  const unit = Number(model.cost_estimate_usd);
  if (model.cost_unit === "second") return unit * (req.durationSeconds ?? model.max_duration ?? 5);
  return unit;
}

/** Can this model take the request at all? Returns a reason when it cannot. */
export function incompatibility(model: ModelRow, req: GenerationRequest, provider: ProviderState | undefined, now = new Date()): string | undefined {
  if (!model.enabled) return "model disabled";
  if (model.deprecated) return "model deprecated";
  if (!provider) return "provider not registered";
  if (!provider.enabled) return "provider disabled";
  if (!provider.configured) return "provider has no credentials";
  if (provider.quarantinedUntil && provider.quarantinedUntil > now) return "provider quarantined";
  if (model.quarantined_until && new Date(model.quarantined_until) > now) return "model quarantined";
  const caps = requiredCapabilities(req);
  const usesSoul = Boolean(req.soul?.bindings?.[model.provider_id]?.soul_id) && model.capabilities.includes("soul");
  for (const c of caps) {
    if (c === "reference_image" && usesSoul) continue;
    if (!model.capabilities.includes(c)) return `lacks ${c}`;
  }
  if (req.references.length > 0 && !usesSoul && model.reference_limit < Math.min(req.references.length, 1)) return "accepts no reference images";
  if (model.supported_ratios.length && !model.supported_ratios.includes(req.aspectRatio)) return `no ${req.aspectRatio} ratio`;
  if (req.durationSeconds && model.max_duration && req.durationSeconds > model.max_duration) return `max duration ${model.max_duration}s`;
  return undefined;
}

function weights(req: GenerationRequest, tier: string) {
  const identity = req.identityConsistency === "high" ? 0.45 : req.identityConsistency === "medium" ? 0.25 : 0.1;
  const draft = req.quality === "draft" || tier === "draft";
  return {
    identity,
    quality: draft ? 0.2 : 0.35,
    speed: draft ? 0.25 : 0.1,
    cost: draft ? 0.3 : 0.15,
    health: 0.1,
  };
}

function healthScore(status: string): number {
  return status === "healthy" ? 1 : status === "unknown" ? 0.7 : status === "degraded" ? 0.35 : 0;
}

export function route(
  req: GenerationRequest,
  policy: Policy,
  models: ModelRow[],
  providers: Map<string, ProviderState>,
  now = new Date(),
): RouteDecision {
  const mode = req.mode ?? policy.mode;
  const budget = Math.min(req.maxCostUsd ?? Infinity, policy.maxCostPerJobUsd > 0 ? policy.maxCostPerJobUsd : Infinity);
  const excluded: RouteDecision["excluded"] = [];
  const eligible: Candidate[] = [];

  if (!policy.allowedModalities.includes(req.modality)) {
    return { mode, candidates: [], excluded: [{ model: "*", reason: `modality ${req.modality} not allowed by policy` }] };
  }

  const maxCost = Math.max(0.0001, ...models.map((m) => estimateCost(m, req)));
  const w = weights(req, policy.qualityTier);
  for (const m of models) {
    const label = `${m.provider_id}/${m.model_id}`;
    const why = incompatibility(m, req, providers.get(m.provider_id), now);
    if (why) {
      excluded.push({ model: label, reason: why });
      continue;
    }
    const cost = estimateCost(m, req);
    if (cost > budget) {
      excluded.push({ model: label, reason: `estimated $${cost.toFixed(3)} over job budget $${budget.toFixed(3)}` });
      continue;
    }
    const usesSoul = Boolean(req.soul?.bindings?.[m.provider_id]?.soul_id) && m.capabilities.includes("soul");
    const identity = usesSoul ? Math.max(m.identity_score, 0.95) : m.identity_score;
    const health = healthScore(m.health_status === "unknown" ? (providers.get(m.provider_id)?.healthStatus ?? "unknown") : m.health_status);
    const score =
      w.identity * identity + w.quality * m.quality_score + w.speed * m.speed_score + w.health * health - w.cost * (cost / maxCost);
    eligible.push({ model: m, score: Math.round(score * 1000) / 1000, estimatedCostUsd: cost, reason: usesSoul ? "soul binding" : "eligible" });
  }

  const byId = new Map(eligible.map((c) => [c.model.id, c]));
  let ordered: Candidate[];
  switch (mode) {
    case "fixed":
      ordered = policy.preferredModelId && byId.has(policy.preferredModelId) ? [byId.get(policy.preferredModelId)!] : [];
      break;
    case "preferred_fallback": {
      const chain = [policy.preferredModelId, ...policy.fallbackModelIds].filter((x): x is number => x !== null && byId.has(x));
      ordered = [...new Set(chain)].map((id) => byId.get(id)!);
      // An empty or fully ineligible chain falls back to auto so content never silently stops.
      if (!ordered.length) ordered = [...eligible].sort((a, b) => b.score - a.score);
      break;
    }
    case "best_quality":
      ordered = [...eligible].sort((a, b) => b.model.quality_score + b.model.identity_score * w.identity - (a.model.quality_score + a.model.identity_score * w.identity));
      break;
    case "best_value":
      ordered = [...eligible].sort((a, b) => valueOf(b) - valueOf(a));
      break;
    case "fastest":
      ordered = [...eligible].filter((c) => c.model.quality_score >= 0.5).sort((a, b) => b.model.speed_score - a.model.speed_score);
      break;
    case "capability_first":
      ordered = eligible;
      break;
    case "auto":
    default:
      ordered = [...eligible].sort((a, b) => b.score - a.score);
  }
  if (req.preferred) {
    const pref = eligible.find((c) => c.model.provider_id === req.preferred!.provider && c.model.model_id === req.preferred!.model);
    if (pref) ordered = [pref, ...ordered.filter((c) => c !== pref)];
  }
  return { mode, candidates: ordered.slice(0, MAX_CANDIDATES), excluded };
}

function valueOf(c: Candidate): number {
  return (c.model.quality_score * 0.5 + c.model.identity_score * 0.5) / Math.max(c.estimatedCostUsd, 0.001);
}
