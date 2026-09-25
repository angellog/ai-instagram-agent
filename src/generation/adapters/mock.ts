import sharp from "sharp";
import { env } from "../../config/env.js";
import type { AdapterJob, PollState, ProviderAdapter } from "../types.js";

/**
 * Offline provider for development, dry-run demos and tests. Produces a
 * deterministic image (colours derived from the prompt) through the full
 * asynchronous lifecycle so every engine path runs with no spend.
 * Never available in production unless MOCK_IMAGES=true.
 */
export class MockAdapter implements ProviderAdapter {
  readonly id = "mock";
  readonly displayName = "Mock (offline)";
  readonly credentialKeys: string[] = [];
  static images = new Map<string, Buffer>();
  static failNext: Array<{ errorClass: "provider" | "timeout" | "validation" | "content_policy" | "auth"; message: string; atSubmit?: boolean }> = [];
  static submitted: AdapterJob[] = [];
  private seq = 0;

  /** Only when explicitly enabled, so a dev box with real keys never routes to it by accident. */
  async isConfigured(): Promise<boolean> {
    return env().MOCK_IMAGES;
  }

  async validateCredentials() {
    return { ok: true, detail: "offline mock provider" };
  }

  estimateCost(job: AdapterJob): number {
    return Number(job.model.cost_estimate_usd);
  }

  async submit(job: AdapterJob) {
    const f = MockAdapter.failNext[0];
    if (f?.atSubmit) {
      MockAdapter.failNext.shift();
      const { GenerationError } = await import("../types.js");
      throw new GenerationError(f.message, f.errorClass);
    }
    MockAdapter.submitted.push(job);
    const id = `mock-${Date.now()}-${++this.seq}`;
    let h = 0;
    for (const ch of job.request.prompt) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const [w, hgt] = sizeFor(job.request.aspectRatio);
    const c1 = `#${(h & 0xffffff).toString(16).padStart(6, "0")}`;
    const c2 = `#${((h >>> 8) & 0xffffff).toString(16).padStart(6, "0")}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}">
      <defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <rect width="${w}" height="${hgt}" fill="url(#a)"/><circle cx="${w / 2}" cy="${hgt * 0.38}" r="${w * 0.19}" fill="#fff" fill-opacity="0.35"/>
      <rect x="${w * 0.3}" y="${hgt * 0.56}" width="${w * 0.4}" height="${hgt * 0.28}" rx="60" fill="#000" fill-opacity="0.25"/></svg>`;
    MockAdapter.images.set(id, await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer());
    return { providerRequestId: id };
  }

  async poll(_job: AdapterJob, id: string): Promise<PollState> {
    const f = MockAdapter.failNext[0];
    if (f && !f.atSubmit) {
      MockAdapter.failNext.shift();
      return { state: "failed", errorClass: f.errorClass, message: f.message };
    }
    if (!MockAdapter.images.has(id)) return { state: "failed", errorClass: "provider", message: "unknown mock task" };
    return { state: "succeeded", urls: [`mock://${id}`], costUsd: 0 };
  }

  static reset(): void {
    MockAdapter.images.clear();
    MockAdapter.failNext = [];
    MockAdapter.submitted = [];
  }
}

function sizeFor(ratio: string): [number, number] {
  const [a, b] = ratio.split(":").map(Number);
  if (!a || !b) return [1080, 1350];
  return a >= b ? [1350, Math.round((1350 * b) / a)] : [1080, Math.round((1080 * b) / a)];
}
