import { setting } from "../../config/settings.js";
import type { AdapterJob, PollState, ProviderAdapter } from "../types.js";
import { GenerationError } from "../types.js";
import { jsonRequest } from "./http.js";
import { mapInput, urlsFrom } from "./input.js";

/**
 * fal.ai queue API: submit to queue.fal.run/{model}, poll the returned
 * status_url, then fetch response_url. Always use the URLs fal returns
 * (model ids with sub-paths resolve differently).
 */
export class FalAdapter implements ProviderAdapter {
  readonly id = "fal";
  readonly displayName = "fal.ai";
  readonly credentialKeys = ["FAL_KEY"];

  private async auth(): Promise<Record<string, string>> {
    const k = await setting("FAL_KEY");
    if (!k) throw new GenerationError("FAL_KEY not set", "auth");
    return { authorization: `Key ${k}` };
  }

  async isConfigured() {
    return Boolean(await setting("FAL_KEY"));
  }

  async validateCredentials() {
    const r = await jsonRequest<{ credits?: { current_balance?: number } }>("https://api.fal.ai/v1/account/billing?expand=credits", { headers: await this.auth() }, "fal billing");
    const bal = r.credits?.current_balance;
    return { ok: true, detail: bal !== undefined ? `balance $${Number(bal).toFixed(2)}` : "authenticated" };
  }

  estimateCost(job: AdapterJob) {
    const unit = Number(job.model.cost_estimate_usd);
    return job.model.cost_unit === "second" ? unit * (job.request.durationSeconds ?? job.model.max_duration ?? 5) : unit;
  }

  async submit(job: AdapterJob) {
    const r = await jsonRequest<{ request_id?: string; status_url?: string; response_url?: string }>(
      `https://queue.fal.run/${job.model.model_id}`,
      { method: "POST", headers: await this.auth(), json: mapInput(job) },
      `fal ${job.model.model_id}`,
    );
    if (!r.request_id || !r.status_url || !r.response_url) throw new GenerationError("fal returned no request handle", "provider", true);
    return { providerRequestId: r.request_id, meta: { status_url: r.status_url, response_url: r.response_url } };
  }

  async poll(job: AdapterJob, id: string, meta?: Record<string, unknown>): Promise<PollState> {
    const statusUrl = String(meta?.status_url ?? `https://queue.fal.run/${job.model.model_id}/requests/${id}/status`);
    const responseUrl = String(meta?.response_url ?? `https://queue.fal.run/${job.model.model_id}/requests/${id}`);
    const s = await jsonRequest<{ status: string; error?: string; error_type?: string }>(statusUrl, { headers: await this.auth() }, "fal status");
    if (s.status === "IN_QUEUE") return { state: "queued" };
    if (s.status === "IN_PROGRESS") return { state: "processing" };
    if (s.error) return { state: "failed", errorClass: /content|nsfw|policy|safety/i.test(`${s.error_type} ${s.error}`) ? "content_policy" : "provider", message: s.error };
    const out = await jsonRequest<{ images?: unknown; image?: unknown; video?: unknown }>(responseUrl, { headers: await this.auth() }, "fal result");
    const urls = urlsFrom(out.images, out.image, out.video);
    return urls.length ? { state: "succeeded", urls } : { state: "failed", errorClass: "provider", message: "fal returned no output" };
  }
}
