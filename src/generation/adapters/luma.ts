import { setting } from "../../config/settings.js";
import type { AdapterJob, PollState, ProviderAdapter } from "../types.js";
import { GenerationError } from "../types.js";
import { jsonRequest } from "./http.js";

const BASE = "https://agents.lumalabs.ai/v1";

/**
 * Luma Agents API (uni-1 image models, ray-3.2 video). Identity via image_ref
 * (up to 9). Output URLs expire after an hour, so the engine rehosts at once.
 * No cancel endpoint and no webhooks.
 */
export class LumaAdapter implements ProviderAdapter {
  readonly id = "luma";
  readonly displayName = "Luma";
  readonly credentialKeys = ["LUMA_API_KEY"];

  private async auth(): Promise<Record<string, string>> {
    const k = await setting("LUMA_API_KEY");
    if (!k) throw new GenerationError("LUMA_API_KEY not set", "auth");
    return { authorization: `Bearer ${k}` };
  }

  async isConfigured() {
    return Boolean(await setting("LUMA_API_KEY"));
  }

  async validateCredentials() {
    await jsonRequest(`${BASE}/files?limit=1`, { headers: await this.auth() }, "luma files");
    return { ok: true, detail: "authenticated (balance is only shown in the Luma dashboard)" };
  }

  estimateCost(job: AdapterJob) {
    const unit = Number(job.model.cost_estimate_usd);
    if (job.model.cost_unit === "second") return unit * (job.request.durationSeconds ?? 5);
    return unit + Math.max(0, job.references.length - 1) * 0.003;
  }

  body(job: AdapterJob): Record<string, unknown> {
    const r = job.request;
    const ratio = job.model.supported_ratios.includes(r.aspectRatio) ? r.aspectRatio : job.model.supported_ratios[0];
    const refs = job.references.slice(0, job.model.reference_limit);
    if (job.model.capabilities.includes("image_to_video") && r.modality === "image_to_video") {
      if (!refs[0]) throw new GenerationError("image_to_video needs a start frame", "validation");
      const duration = (r.durationSeconds ?? 5) > 7 ? "10s" : "5s";
      return { type: "video", model: job.model.model_id, prompt: r.prompt, aspect_ratio: ratio, video: { duration, resolution: "720p", start_frame: { url: refs[0] } } };
    }
    if (r.modality === "text_to_video") return { type: "video", model: job.model.model_id, prompt: r.prompt, aspect_ratio: ratio, video: { duration: "5s", resolution: "720p" } };
    return { type: "image", model: job.model.model_id, prompt: r.prompt, aspect_ratio: ratio, output_format: "jpeg", ...(refs.length ? { image_ref: refs.map((url) => ({ url })) } : {}) };
  }

  async submit(job: AdapterJob) {
    const r = await jsonRequest<{ id?: string }>(`${BASE}/generations`, { method: "POST", headers: await this.auth(), json: this.body(job) }, `luma ${job.model.model_id}`);
    if (!r.id) throw new GenerationError("Luma returned no generation id", "provider", true);
    return { providerRequestId: r.id };
  }

  async poll(_job: AdapterJob, id: string): Promise<PollState> {
    const r = await jsonRequest<{ state: string; output?: Array<{ url?: string }>; failure_code?: string; failure_reason?: string }>(`${BASE}/generations/${id}`, { headers: await this.auth() }, "luma generation");
    if (r.state === "completed") return { state: "succeeded", urls: (r.output ?? []).map((o) => o.url).filter((u): u is string => Boolean(u)) };
    if (r.state === "failed") {
      const code = r.failure_code ?? "";
      return {
        state: "failed",
        errorClass: code === "content_moderated" ? "content_policy" : code === "rate_limited" ? "rate_limit" : code === "budget_exhausted" ? "auth" : "provider",
        message: `${code} ${r.failure_reason ?? ""}`.trim() || "generation failed",
      };
    }
    return { state: r.state === "processing" ? "processing" : "queued" };
  }
}
