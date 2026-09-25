import type { FetchLike } from "../../lib/async.js";
import { GenerationError, type ErrorClass } from "../types.js";

let fetchImpl: FetchLike = fetch;
/** Test hook: every adapter's HTTP goes through this. */
export function setGenerationFetch(f: FetchLike | undefined): void {
  fetchImpl = f ?? fetch;
}
export function gfetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchImpl(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(60_000) });
}

export function classifyHttp(status: number, body: string): ErrorClass {
  const b = body.toLowerCase();
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "auth"; // out of credits: provider unusable right now
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (/nsfw|safety|policy|moderat|content filter|sensitive/.test(b)) return "content_policy";
  if (status === 400 || status === 404 || status === 422) return "validation";
  return "provider";
}

/** JSON request with uniform error classification. */
export async function jsonRequest<T>(url: string, init: RequestInit & { json?: unknown } = {}, label = url): Promise<T> {
  const headers = { ...(init.headers as Record<string, string> | undefined), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) };
  let res: Response;
  try {
    res = await gfetch(url, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  } catch (e) {
    const msg = (e as Error).message;
    throw new GenerationError(`${label}: network error ${msg}`, /timeout|abort/i.test(msg) ? "timeout" : "provider", true);
  }
  const text = await res.text();
  if (!res.ok) throw new GenerationError(`${label} → HTTP ${res.status}: ${text.slice(0, 300)}`, classifyHttp(res.status, text), res.status >= 500 || res.status === 429);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new GenerationError(`${label}: invalid JSON response`, "provider", true);
  }
}
