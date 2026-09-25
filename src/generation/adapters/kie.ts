import { env } from "../../config/env.js";
import { kieKeys } from "../../config/settings.js";
import { KieClient, KieError } from "../../kie/client.js";
import { PermanentError, RateLimitedError, TransientError } from "../../lib/errors.js";
import { GenerationError, type AdapterJob, type PollState, type ProviderAdapter } from "../types.js";
import { gfetch } from "./http.js";
import { mapInput, type InputConfig } from "./input.js";

/**
 * kie.ai market API: the v0 image path, now one adapter among many
 * (brief v2 §17). Field names per model live in `buildInput`.
 */
export class KieAdapter implements ProviderAdapter {
  readonly id = "kie";
  readonly displayName = "kie.ai";
  readonly credentialKeys = ["KIE_API_KEY", "KIE_API_KEY_2", "KIE_API_KEY_3"];

  async isConfigured(): Promise<boolean> {
    return (await kieKeys()).length > 0;
  }

  private async client(): Promise<KieClient> {
    const e = env();
    return new KieClient({ keys: await kieKeys(), baseUrl: e.KIE_BASE_URL, uploadBaseUrl: e.KIE_UPLOAD_BASE_URL, fetchImpl: gfetch });
  }

  async validateCredentials() {
    const credits = await (await this.client()).credits();
    const ok = credits.some((c) => Number.isFinite(c));
    return { ok, detail: credits.map((c, i) => `key ${i + 1}: ${Number.isFinite(c) ? `${c} credits` : "error"}`).join(" · ") };
  }

  estimateCost(job: AdapterJob): number {
    return Number(job.model.cost_estimate_usd);
  }

  async submit(job: AdapterJob) {
    try {
      const { taskId, keyIndex } = await (await this.client()).createTask(job.model.model_id, buildInput(job));
      return { providerRequestId: taskId, meta: { keyIndex } };
    } catch (e) {
      throw toGenError(e);
    }
  }

  async poll(job: AdapterJob, id: string, meta?: Record<string, unknown>): Promise<PollState> {
    try {
      const t = await (await this.client()).getTask(id, typeof meta?.keyIndex === "number" ? meta.keyIndex : undefined);
      if (t.state === "success") {
        const credits = t.creditsConsumed ?? Number(job.model.cost_estimate_usd) / env().KIE_USD_PER_CREDIT;
        return { state: "succeeded", urls: t.resultUrls, costUsd: credits * env().KIE_USD_PER_CREDIT, units: { credits } };
      }
      if (t.state === "fail") {
        const msg = t.failMsg ?? t.failCode ?? "generation failed";
        return { state: "failed", errorClass: /policy|nsfw|sensitive|safety/i.test(msg) ? "content_policy" : "provider", message: msg };
      }
      return { state: t.state === "generating" ? "processing" : "queued" };
    } catch (e) {
      throw toGenError(e);
    }
  }
}

/** kie defaults: references in `image_input`, durations as strings. Model config overrides. */
export function buildInput(job: AdapterJob): Record<string, unknown> {
  return mapInput(job, { refField: "image_input", durationFormat: "string", ...(job.model.config as InputConfig) });
}

function toGenError(e: unknown): Error {
  if (e instanceof GenerationError) return e;
  if (e instanceof KieError && e.code === 402) return new GenerationError(e.message, "auth");
  if (e instanceof RateLimitedError) return new GenerationError(e.message, "rate_limit", true);
  if (e instanceof TransientError) return new GenerationError(e.message, /timeout/i.test(e.message) ? "timeout" : "provider", true);
  if (e instanceof PermanentError) {
    const code = (e.detail as { code?: number } | undefined)?.code;
    return new GenerationError(e.message, code === 401 ? "auth" : /policy|nsfw|sensitive/i.test(e.message) ? "content_policy" : "validation");
  }
  return new GenerationError((e as Error).message, "provider", true);
}
