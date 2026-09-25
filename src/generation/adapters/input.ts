import type { AdapterJob } from "../types.js";

/**
 * Declarative request mapping shared by the HTTP adapters. Each catalog model
 * carries a `config` describing its field names, so adding a model is a
 * catalog edit rather than new adapter code.
 */
export interface InputConfig {
  /** Where references go and in what shape. */
  refField?: string;
  refMode?: "array" | "single" | "objects"; // objects = [{ url }]
  /** For image_to_video / upscale: field for the source image (first reference). */
  sourceField?: string;
  ratioField?: string;
  /** Map "9:16" → provider-specific value (e.g. "720:1280"). */
  ratioMap?: Record<string, string>;
  resolutionField?: string;
  durationField?: string;
  durationFormat?: "number" | "string" | "seconds_suffix";
  audioField?: string;
  negativeField?: string;
  promptField?: string;
  promptLimit?: number;
  outputFormat?: string;
  /** Constant extra fields (num_images: 1, …). */
  extra?: Record<string, unknown>;
}

export function mapInput(job: AdapterJob, cfg: InputConfig = job.model.config as InputConfig): Record<string, unknown> {
  const { request: r, model, references } = job;
  const out: Record<string, unknown> = { ...(cfg.extra ?? {}) };
  out[cfg.promptField ?? "prompt"] = r.prompt.slice(0, cfg.promptLimit ?? 10_000);

  let refs = references;
  if (cfg.sourceField && refs.length) {
    out[cfg.sourceField] = refs[0];
    refs = refs.slice(1);
  }
  if (cfg.refField && refs.length && model.reference_limit > 0) {
    const use = refs.slice(0, model.reference_limit);
    out[cfg.refField] = cfg.refMode === "single" ? use[0] : cfg.refMode === "objects" ? use.map((url) => ({ url })) : use;
  }

  if (cfg.ratioField !== undefined || model.supported_ratios.length) {
    const ratio = model.supported_ratios.includes(r.aspectRatio) ? r.aspectRatio : model.supported_ratios[0];
    if (ratio) out[cfg.ratioField ?? "aspect_ratio"] = cfg.ratioMap?.[ratio] ?? ratio;
  }
  if (model.resolution_options.length) {
    out[cfg.resolutionField ?? "resolution"] = r.resolution && model.resolution_options.includes(r.resolution) ? r.resolution : model.resolution_options[0];
  }
  if (r.durationSeconds && (cfg.durationField || model.max_duration)) {
    const d = Math.min(r.durationSeconds, model.max_duration ?? r.durationSeconds);
    out[cfg.durationField ?? "duration"] = cfg.durationFormat === "string" ? String(d) : cfg.durationFormat === "seconds_suffix" ? `${d}s` : d;
  }
  if (cfg.audioField && r.audio !== undefined) out[cfg.audioField] = r.audio;
  if (cfg.negativeField && r.negativePrompt) out[cfg.negativeField] = r.negativePrompt;
  if (cfg.outputFormat) out.output_format = cfg.outputFormat;
  return out;
}

/** First URL-looking value in a provider result. */
export function urlsFrom(...candidates: unknown[]): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (!v) return;
    if (typeof v === "string") {
      if (/^https?:\/\//.test(v)) out.push(v);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.url === "string") out.push(o.url);
      else if (typeof o.filePath === "string") out.push(o.filePath);
    }
  };
  candidates.forEach(visit);
  return [...new Set(out)];
}
