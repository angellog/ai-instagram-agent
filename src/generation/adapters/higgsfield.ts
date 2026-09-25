import { setting } from "../../config/settings.js";
import type { AdapterJob, PollState, ProviderAdapter } from "../types.js";
import { GenerationError } from "../types.js";
import { jsonRequest } from "./http.js";
import { mapInput, urlsFrom, type InputConfig } from "./input.js";

const BASE = "https://api.higgsfield.ai";

/**
 * Higgsfield (docs.higgsfield.ai): queue API, `Authorization: Key id:secret`.
 * Its differentiator is Soul ID: a character trained from face photos
 * (`POST /v1/custom-references`) and referenced at generation time with
 * `custom_reference_id` on the Soul image models. A soul-bound influencer
 * therefore needs no reference images on these models.
 */
export class HiggsfieldAdapter implements ProviderAdapter {
  readonly id = "higgsfield";
  readonly displayName = "Higgsfield";
  readonly credentialKeys = ["HIGGSFIELD_API_KEY", "HIGGSFIELD_API_SECRET"];

  private async auth(): Promise<Record<string, string>> {
    const [id, secret] = [await setting("HIGGSFIELD_API_KEY"), await setting("HIGGSFIELD_API_SECRET")];
    if (!id || !secret) throw new GenerationError("Higgsfield key id/secret not set", "auth");
    return { authorization: `Key ${id}:${secret}` };
  }

  async isConfigured(): Promise<boolean> {
    return Boolean((await setting("HIGGSFIELD_API_KEY")) && (await setting("HIGGSFIELD_API_SECRET")));
  }

  async validateCredentials() {
    const r = await jsonRequest<{ total?: number }>(`${BASE}/v1/custom-references/list?page=1&page_size=1`, { headers: await this.auth() }, "higgsfield auth");
    return { ok: true, detail: `authenticated · ${r.total ?? 0} Soul ID character(s)` };
  }

  estimateCost(job: AdapterJob): number {
    const unit = Number(job.model.cost_estimate_usd);
    return job.model.cost_unit === "second" ? unit * (job.request.durationSeconds ?? job.model.max_duration ?? 5) : unit;
  }

  body(job: AdapterJob): Record<string, unknown> {
    const cfg = job.model.config as InputConfig & { soul?: boolean; referenceStrength?: number };
    const body = mapInput(job, cfg);
    if (cfg.soul) {
      const binding = job.request.soul?.bindings?.higgsfield;
      if (binding?.soul_id) {
        body.custom_reference_id = binding.soul_id;
        body.custom_reference_strength = Math.min(1, Math.max(0.05, Number(binding.strength ?? cfg.referenceStrength ?? 0.9)));
      }
    }
    return body;
  }

  async submit(job: AdapterJob) {
    const r = await jsonRequest<{ request_id?: string }>(`${BASE}/${job.model.model_id}`, { method: "POST", headers: await this.auth(), json: this.body(job) }, `higgsfield ${job.model.model_id}`);
    if (!r.request_id) throw new GenerationError("Higgsfield returned no request_id", "provider", true);
    return { providerRequestId: r.request_id };
  }

  async poll(_job: AdapterJob, id: string): Promise<PollState> {
    const r = await jsonRequest<{ status: string; images?: unknown; video?: unknown; error?: string }>(`${BASE}/requests/${id}/status`, { headers: await this.auth() }, "higgsfield status");
    switch (r.status) {
      case "completed":
        return { state: "succeeded", urls: urlsFrom(r.images, r.video) };
      case "nsfw":
        return { state: "failed", errorClass: "content_policy", message: "flagged nsfw by Higgsfield (refunded)" };
      case "failed":
        return { state: "failed", errorClass: "provider", message: r.error ?? "Higgsfield generation failed" };
      case "canceled":
        return { state: "cancelled", errorClass: "provider", message: "cancelled" };
      case "in_progress":
        return { state: "processing" };
      default:
        return { state: "queued" };
    }
  }

  // ------------------------------------------------------------ Soul ID

  /** Train a Soul ID character from public face photo URLs (5–20 varied, well-lit photos recommended). */
  async trainSoul(name: string, imageUrls: string[], modelVersion: "v1" | "v2" | "cinema" = "v2"): Promise<{ id: string; status: string }> {
    if (!imageUrls.length) throw new GenerationError("Soul ID training needs at least one image", "validation");
    const r = await jsonRequest<{ id: string; status: string }>(
      `${BASE}/v1/custom-references`,
      { method: "POST", headers: await this.auth(), json: { name: name.slice(0, 100), model_version: modelVersion, input_images: imageUrls.slice(0, 100).map((image_url) => ({ type: "image_url", image_url })) } },
      "higgsfield soul training",
    );
    return { id: r.id, status: r.status };
  }

  async soulStatus(id: string): Promise<{ id: string; status: string; thumbnailUrl?: string; failReason?: string }> {
    const r = await jsonRequest<{ id: string; status: string; thumbnail_url?: string; fail_reason?: string }>(`${BASE}/v1/custom-references/${id}`, { headers: await this.auth() }, "higgsfield soul status");
    return { id: r.id, status: r.status, thumbnailUrl: r.thumbnail_url, failReason: r.fail_reason };
  }
}
