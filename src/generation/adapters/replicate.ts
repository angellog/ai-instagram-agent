import { setting } from "../../config/settings.js";
import type { AdapterJob, PollState, ProviderAdapter } from "../types.js";
import { GenerationError } from "../types.js";
import { jsonRequest } from "./http.js";
import { mapInput, urlsFrom } from "./input.js";

const BASE = "https://api.replicate.com/v1";

/** Replicate predictions API (official models: POST /models/{owner}/{name}/predictions). */
export class ReplicateAdapter implements ProviderAdapter {
  readonly id = "replicate";
  readonly displayName = "Replicate";
  readonly credentialKeys = ["REPLICATE_API_TOKEN"];

  private async auth(): Promise<Record<string, string>> {
    const k = await setting("REPLICATE_API_TOKEN");
    if (!k) throw new GenerationError("REPLICATE_API_TOKEN not set", "auth");
    return { authorization: `Bearer ${k}` };
  }

  async isConfigured() {
    return Boolean(await setting("REPLICATE_API_TOKEN"));
  }

  async validateCredentials() {
    const r = await jsonRequest<{ username?: string }>(`${BASE}/account`, { headers: await this.auth() }, "replicate account");
    return { ok: true, detail: `authenticated as ${r.username ?? "unknown"}` };
  }

  estimateCost(job: AdapterJob) {
    const unit = Number(job.model.cost_estimate_usd);
    return job.model.cost_unit === "second" ? unit * (job.request.durationSeconds ?? job.model.max_duration ?? 5) : unit;
  }

  async submit(job: AdapterJob) {
    const r = await jsonRequest<{ id?: string }>(
      `${BASE}/models/${job.model.model_id}/predictions`,
      { method: "POST", headers: await this.auth(), json: { input: mapInput(job) } },
      `replicate ${job.model.model_id}`,
    );
    if (!r.id) throw new GenerationError("Replicate returned no prediction id", "provider", true);
    return { providerRequestId: r.id };
  }

  async poll(_job: AdapterJob, id: string): Promise<PollState> {
    const r = await jsonRequest<{ status: string; output?: unknown; error?: string | null; metrics?: { predict_time?: number } }>(`${BASE}/predictions/${id}`, { headers: await this.auth() }, "replicate status");
    switch (r.status) {
      case "succeeded": {
        const urls = urlsFrom(r.output);
        return urls.length ? { state: "succeeded", urls } : { state: "failed", errorClass: "provider", message: "Replicate returned no output" };
      }
      case "failed":
        return { state: "failed", errorClass: /nsfw|sensitive|safety|flagged/i.test(r.error ?? "") ? "content_policy" : "provider", message: r.error ?? "prediction failed" };
      case "canceled":
        return { state: "cancelled", errorClass: "provider", message: "cancelled" };
      case "processing":
        return { state: "processing" };
      default:
        return { state: "queued" };
    }
  }
}
