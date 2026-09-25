import { setting } from "../../config/settings.js";
import type { AdapterJob, PollState, ProviderAdapter } from "../types.js";
import { GenerationError } from "../types.js";
import { jsonRequest } from "./http.js";

const BASE = "https://api.dev.runwayml.com";
const VERSION = "2024-11-06";
const USD_PER_CREDIT = 0.01;

/**
 * Runway developer API. Tasks: POST /v1/{endpoint} → GET /v1/tasks/{id}.
 * gen4_image takes tagged reference images (`@subject` in the prompt), which
 * is how identity is carried. Poll no faster than every 5s; no webhooks.
 */
export class RunwayAdapter implements ProviderAdapter {
  readonly id = "runway";
  readonly displayName = "Runway";
  readonly credentialKeys = ["RUNWAY_API_KEY"];

  private async headers(): Promise<Record<string, string>> {
    const k = await setting("RUNWAY_API_KEY");
    if (!k) throw new GenerationError("RUNWAY_API_KEY not set", "auth");
    return { authorization: `Bearer ${k}`, "x-runway-version": VERSION };
  }

  async isConfigured() {
    return Boolean(await setting("RUNWAY_API_KEY"));
  }

  async validateCredentials() {
    const r = await jsonRequest<{ creditBalance?: number }>(`${BASE}/v1/organization`, { headers: await this.headers() }, "runway organization");
    return { ok: true, detail: `${r.creditBalance ?? "?"} credits (≈ $${((r.creditBalance ?? 0) * USD_PER_CREDIT).toFixed(2)})` };
  }

  estimateCost(job: AdapterJob) {
    const unit = Number(job.model.cost_estimate_usd);
    return job.model.cost_unit === "second" ? unit * (job.request.durationSeconds ?? job.model.max_duration ?? 5) : unit;
  }

  body(job: AdapterJob): { endpoint: string; body: Record<string, unknown> } {
    const cfg = job.model.config as { endpoint: string; ratioMap?: Record<string, string>; durations?: number[] };
    const r = job.request;
    const ratioKey = job.model.supported_ratios.includes(r.aspectRatio) ? r.aspectRatio : job.model.supported_ratios[0];
    const ratio = cfg.ratioMap?.[ratioKey] ?? ratioKey;
    const model = job.model.model_id;
    switch (cfg.endpoint) {
      case "text_to_image": {
        const refs = job.references.slice(0, job.model.reference_limit);
        const tags = refs.map((_, i) => (i === 0 ? "subject" : `ref${i}`));
        const prompt = refs.length ? `@subject is the person to depict (keep face and identity identical). ${r.prompt}` : r.prompt;
        return { endpoint: "text_to_image", body: { model, promptText: prompt.slice(0, 1000), ratio, ...(refs.length ? { referenceImages: refs.map((uri, i) => ({ uri, tag: tags[i] })) } : {}) } };
      }
      case "image_to_video": {
        if (!job.references[0]) throw new GenerationError("image_to_video needs a source image", "validation");
        const allowed = cfg.durations ?? [5, 10];
        const d = allowed.reduce((best, x) => (Math.abs(x - (r.durationSeconds ?? allowed[0])) < Math.abs(best - (r.durationSeconds ?? allowed[0])) ? x : best), allowed[0]);
        return { endpoint: "image_to_video", body: { model, promptImage: job.references[0], promptText: r.prompt.slice(0, 1000), ratio, duration: d } };
      }
      case "image_upscale":
        if (!job.references[0]) throw new GenerationError("upscale needs a source image", "validation");
        return { endpoint: "image_upscale", body: { model, imageUri: job.references[0], scaleFactor: 2 } };
      default:
        throw new GenerationError(`unknown Runway endpoint ${cfg.endpoint}`, "unsupported");
    }
  }

  async submit(job: AdapterJob) {
    const { endpoint, body } = this.body(job);
    const r = await jsonRequest<{ id?: string }>(`${BASE}/v1/${endpoint}`, { method: "POST", headers: await this.headers(), json: body }, `runway ${job.model.model_id}`);
    if (!r.id) throw new GenerationError("Runway returned no task id", "provider", true);
    return { providerRequestId: r.id };
  }

  async poll(_job: AdapterJob, id: string): Promise<PollState> {
    const r = await jsonRequest<{ status: string; output?: string[]; failure?: string; failureCode?: string }>(`${BASE}/v1/tasks/${id}`, { headers: await this.headers() }, "runway task");
    switch (r.status) {
      case "SUCCEEDED":
        return { state: "succeeded", urls: r.output ?? [] };
      case "FAILED":
        return { state: "failed", errorClass: (r.failureCode ?? "").startsWith("SAFETY") ? "content_policy" : "provider", message: `${r.failureCode ?? ""} ${r.failure ?? "task failed"}`.trim() };
      case "CANCELLED":
        return { state: "cancelled", errorClass: "provider", message: "cancelled" };
      case "RUNNING":
        return { state: "processing" };
      default: // PENDING, THROTTLED
        return { state: "queued" };
    }
  }
}
