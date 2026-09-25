/**
 * The normalized generation contract (brief v2 §4). Nothing outside
 * src/generation calls a provider API: agents describe *what* they need
 * (capability, ratio, identity requirements, budget) and the engine decides
 * *who* makes it.
 */

export const MODALITIES = ["text_to_image", "reference_image", "image_edit", "upscale", "image_to_video", "text_to_video"] as const;
export type Modality = (typeof MODALITIES)[number];

/** Model capabilities. `soul` = can generate from a provider-side trained character id. */
export const CAPABILITIES = [...MODALITIES, "soul", "audio"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type Level = "low" | "medium" | "high";
export type QualityTier = "draft" | "standard" | "high" | "max";

export const ROUTING_MODES = ["fixed", "preferred_fallback", "best_quality", "best_value", "fastest", "capability_first", "auto"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export interface SoulContext {
  soulId: string;
  /** Provider-side character handles, e.g. { higgsfield: { soul_id: "…", model: "soul_cinematic" } }. */
  bindings: Record<string, { soul_id?: string; model?: string; [k: string]: unknown }>;
}

export interface GenerationRequest {
  influencerId: number;
  /** Same key → same request row → never paid twice (retries, crashes, double clicks). */
  idempotencyKey: string;
  purpose: "post" | "soul" | "benchmark" | "manual";
  postId?: string;
  modality: Modality;
  prompt: string;
  negativePrompt?: string;
  /** Reference assets (URLs). Must belong to this influencer; verified before submission. */
  references: string[];
  soul?: SoulContext;
  aspectRatio: string; // "4:5" | "1:1" | "9:16" | …
  resolution?: "1K" | "2K" | "4K";
  durationSeconds?: number;
  audio?: boolean;
  quality: QualityTier;
  identityConsistency: Level;
  styleConsistency?: Level;
  /** Override the influencer's routing policy for this job. */
  mode?: RoutingMode;
  preferred?: { provider: string; model: string };
  /** Only this registry model may run (benchmarks, operator "try this model"). */
  pinModelId?: number;
  maxCostUsd?: number;
  timeoutSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface GeneratedAsset {
  assetId: string;
  url: string; // durable (our storage), never the provider's expiring URL
  sourceUrl: string;
  bytes?: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface GenerationResult {
  requestId: string;
  provider: string;
  model: string;
  providerRequestId: string;
  assets: GeneratedAsset[];
  costUsd: number;
  latencyMs: number;
  attempts: number;
  warnings: string[];
}

export type ErrorClass = "validation" | "auth" | "rate_limit" | "timeout" | "provider" | "content_policy" | "budget" | "unsupported";

/** Error classes after which the engine may try the next eligible model. */
export const FALLBACK_ON: ErrorClass[] = ["auth", "rate_limit", "timeout", "provider", "validation", "unsupported"];

export class GenerationError extends Error {
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

/** A model row from the registry (generation_models). */
export interface ModelRow {
  id: number;
  provider_id: string;
  model_id: string;
  display_name: string;
  capabilities: string[];
  supported_ratios: string[];
  resolution_options: string[];
  max_duration: number | null;
  reference_limit: number;
  identity_score: number;
  quality_score: number;
  speed_score: number;
  cost_estimate_usd: number;
  cost_unit: "image" | "second" | "request";
  enabled: boolean;
  health_status: "unknown" | "healthy" | "degraded" | "unavailable";
  quarantined_until: Date | null;
  deprecated: boolean;
  config: Record<string, unknown>;
}

/** What an adapter receives: the request plus the model it was routed to. */
export interface AdapterJob {
  model: ModelRow;
  request: GenerationRequest;
  /** References rehosted where the provider can fetch them. */
  references: string[];
}

export type PollState =
  | { state: "queued" | "processing" }
  | { state: "succeeded"; urls: string[]; costUsd?: number; units?: Record<string, number> }
  | { state: "failed" | "cancelled"; errorClass: ErrorClass; message: string };

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Setting keys this provider needs (shown on the Config page). */
  readonly credentialKeys: string[];
  isConfigured(): Promise<boolean>;
  /** A free call that proves the credentials work. */
  validateCredentials(): Promise<{ ok: boolean; detail: string }>;
  /** Submit and return the provider's request id immediately (persisted before polling). */
  submit(job: AdapterJob): Promise<{ providerRequestId: string; meta?: Record<string, unknown> }>;
  poll(job: AdapterJob, providerRequestId: string, meta?: Record<string, unknown>): Promise<PollState>;
  /** Estimated USD for this job on this model (before submission). */
  estimateCost(job: AdapterJob): number;
}
