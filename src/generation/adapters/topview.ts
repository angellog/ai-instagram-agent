import { setting } from "../../config/settings.js";
import { download } from "../../storage/host.js";
import type { AdapterJob, PollState, ProviderAdapter } from "../types.js";
import { GenerationError } from "../types.js";
import { gfetch, jsonRequest } from "./http.js";

const BASE = "https://api.topview.ai";

interface Wrapped<T> {
  code: string;
  message?: string;
  result: T;
}

/**
 * Topview AI common-task API. Inputs are Topview file ids, so every reference
 * is uploaded first (credential → PUT → check). Models are addressed by
 * display name ("Nano Banana Pro", "Kling V3", …) held in the catalog config.
 */
export class TopviewAdapter implements ProviderAdapter {
  readonly id = "topview";
  readonly displayName = "Topview";
  readonly credentialKeys = ["TOPVIEW_API_KEY", "TOPVIEW_UID"];

  private async headers(): Promise<Record<string, string>> {
    const [k, uid] = [await setting("TOPVIEW_API_KEY"), await setting("TOPVIEW_UID")];
    if (!k || !uid) throw new GenerationError("TOPVIEW_API_KEY / TOPVIEW_UID not set", "auth");
    return { authorization: `Bearer ${k}`, "topview-uid": uid };
  }

  private async call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const r = await jsonRequest<Wrapped<T>>(`${BASE}${path}`, { ...init, headers: { ...(await this.headers()), ...(init.headers as Record<string, string>) } }, `topview ${path.split("?")[0]}`);
    if (String(r.code) !== "200") {
      const code = Number(r.code);
      const cls = code === 4100 ? "auth" : code === 4007 ? "rate_limit" : code === 6001 ? "content_policy" : code >= 5000 ? "provider" : "validation";
      throw new GenerationError(`Topview ${r.code}: ${r.message ?? ""}`, cls, cls === "provider" || cls === "rate_limit");
    }
    return r.result;
  }

  async isConfigured() {
    return Boolean((await setting("TOPVIEW_API_KEY")) && (await setting("TOPVIEW_UID")));
  }

  async validateCredentials() {
    await this.call("/v1/tts/list");
    return { ok: true, detail: "authenticated" };
  }

  estimateCost(job: AdapterJob) {
    const unit = Number(job.model.cost_estimate_usd);
    return job.model.cost_unit === "second" ? unit * (job.request.durationSeconds ?? 5) : unit;
  }

  /** Upload a public URL into Topview storage and return its fileId. */
  async upload(url: string): Promise<string> {
    const bytes = await download(url, 30 * 1024 * 1024, "image/");
    const isPng = bytes.subarray(0, 4).toString("hex") === "89504e47";
    const [format, contentType] = isPng ? ["png", "image/png"] : ["jpg", "image/jpeg"];
    const cred = await this.call<{ fileId: string; uploadUrl: string }>(`/v1/upload/credential?format=${format}`);
    const put = await gfetch(cred.uploadUrl, { method: "PUT", body: new Uint8Array(bytes), headers: { "content-type": contentType } });
    if (!put.ok) throw new GenerationError(`Topview upload PUT failed: HTTP ${put.status}`, "provider", true);
    for (let i = 0; i < 10; i++) {
      if (await this.call<boolean>(`/v1/upload/check?fileId=${encodeURIComponent(cred.fileId)}`)) return cred.fileId;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new GenerationError("Topview upload never became ready", "timeout", true);
  }

  private kind(job: AdapterJob): { submit: string; query: string } {
    const m = job.request.modality;
    if (m === "image_to_video") return { submit: "/v2/common_task/image2video/task/submit", query: "/v2/common_task/image2video/task/query" };
    if (m === "text_to_video") return { submit: "/v1/common_task/text2video/task/submit", query: "/v1/common_task/text2video/task/query" };
    if (job.references.length) return { submit: "/v1/common_task/image_edit/task/submit", query: "/v1/common_task/image_edit/task/query" };
    return { submit: "/v1/common_task/text2image/task/submit", query: "/v1/common_task/text2image/task/query" };
  }

  async submit(job: AdapterJob) {
    const r = job.request;
    const cfg = job.model.config as { topviewModel?: string };
    const model = cfg.topviewModel ?? job.model.display_name;
    const ratio = job.model.supported_ratios.includes(r.aspectRatio) ? r.aspectRatio : job.model.supported_ratios[0];
    const k = this.kind(job);
    const fileIds = [];
    for (const u of job.references.slice(0, Math.max(1, job.model.reference_limit))) fileIds.push(await this.upload(u));
    let body: Record<string, unknown>;
    if (r.modality === "image_to_video") {
      body = { model, prompt: r.prompt, firstFrameFileId: fileIds[0], aspectRatio: ratio, resolution: 720, duration: r.durationSeconds ?? 5, sound: r.audio ? "on" : "off", generatingCount: 1 };
    } else if (r.modality === "text_to_video") {
      body = { model, prompt: r.prompt, aspectRatio: ratio, resolution: 720, duration: r.durationSeconds ?? 5 };
    } else {
      body = { model, prompt: r.prompt, aspectRatio: ratio, resolution: r.resolution ?? "2K", generateCount: 1, ...(fileIds.length ? { inputImageFileIds: fileIds } : {}) };
    }
    const res = await this.call<{ taskId: string }>(k.submit, { method: "POST", json: body });
    return { providerRequestId: res.taskId, meta: { query: k.query } };
  }

  async poll(job: AdapterJob, id: string, meta?: Record<string, unknown>): Promise<PollState> {
    const query = String(meta?.query ?? this.kind(job).query);
    const r = await this.call<{ status: string; errorMsg?: string | null; images?: Array<{ status: string; filePath?: string | null }>; videos?: Array<{ filePath?: string | null }>; costCredit?: number }>(
      `${query}?taskId=${encodeURIComponent(id)}`,
    );
    if (r.status === "success") {
      const urls = [...(r.images ?? []).filter((i) => i.status === "success"), ...(r.videos ?? [])].map((x) => x.filePath).filter((u): u is string => Boolean(u));
      return urls.length ? { state: "succeeded", urls, units: r.costCredit ? { credits: r.costCredit } : undefined } : { state: "failed", errorClass: "provider", message: r.errorMsg ?? "no output" };
    }
    if (r.status === "fail") return { state: "failed", errorClass: /policy|security|sensitive/i.test(r.errorMsg ?? "") ? "content_policy" : "provider", message: r.errorMsg ?? "task failed" };
    return { state: r.status === "running" ? "processing" : "queued" };
  }
}
