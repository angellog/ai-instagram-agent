import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env } from "../config/env.js";
import { setting } from "../config/settings.js";
import type { FetchLike } from "../lib/async.js";
import { TransientError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

/**
 * Durable public hosting for composed slides (Instagram fetches media by URL).
 * Order follows FeetBit's standing rule, ported from kickshot/src/host.mjs:
 * Supabase Storage first, imgbb second. `local` serves files from this app
 * (development only: Instagram cannot reach localhost).
 */
export type Provider = "supabase" | "imgbb" | "local";

let fetchImpl: FetchLike = fetch;
export function setStorageFetch(f: FetchLike): void {
  fetchImpl = f;
}

export async function hostImage(
  bytes: Buffer,
  key: string,
  o: { contentType?: string; order?: Provider[]; verify?: boolean } = {},
): Promise<{ url: string; provider: Provider }> {
  const e = env();
  const order = o.order ?? (e.NODE_ENV === "production" ? ["supabase", "imgbb"] : ["supabase", "imgbb", "local"]);
  const contentType = o.contentType ?? "image/jpeg";
  const errors: string[] = [];
  for (const provider of order) {
    try {
      const url = await PROVIDERS[provider](bytes, key, contentType);
      if (!url) {
        errors.push(`${provider}: not configured`);
        continue;
      }
      if (o.verify !== false && provider !== "local") await verifyImageUrl(url, contentType.split("/")[0] + "/");
      return { url, provider };
    } catch (err) {
      errors.push(`${provider}: ${(err as Error).message}`);
      logger.warn({ provider, key, err: (err as Error).message }, "image host failed, trying next");
    }
  }
  throw new TransientError(`Could not host ${key}: ${errors.join(" | ")}`);
}

export async function verifyImageUrl(url: string, expect = "image/"): Promise<void> {
  let r = await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
  if (r.status === 405 || r.status === 403) r = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(15_000) });
  const ct = r.headers.get("content-type") ?? "";
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  if (!ct.startsWith(expect)) throw new Error(`not ${expect}* (${ct}) at ${url}`);
}

const ensured = new Set<string>();

const PROVIDERS: Record<Provider, (bytes: Buffer, key: string, contentType: string) => Promise<string | undefined>> = {
  async supabase(bytes, key, contentType) {
    const [supaUrl, token, bucketSetting] = [await setting("SUPABASE_URL"), await setting("SUPABASE_SERVICE_ROLE_KEY"), await setting("SUPABASE_BUCKET")];
    if (!supaUrl || !token) return undefined;
    const base = supaUrl.replace(/\/$/, "");
    const bucket = bucketSetting ?? env().SUPABASE_BUCKET;
    if (!ensured.has(bucket)) {
      const h = { authorization: `Bearer ${token}`, apikey: token, "content-type": "application/json" };
      const r = await fetchImpl(`${base}/storage/v1/bucket/${bucket}`, { headers: h });
      if (r.status === 404 || r.status === 400) {
        const c = await fetchImpl(`${base}/storage/v1/bucket`, {
          method: "POST",
          headers: h,
          body: JSON.stringify({ id: bucket, name: bucket, public: true, allowed_mime_types: ["image/jpeg", "image/png", "image/webp"] }),
        });
        if (!c.ok && c.status !== 409) throw new Error(`create bucket HTTP ${c.status}`);
      } else if (!r.ok) {
        throw new Error(`bucket check HTTP ${r.status}`);
      }
      ensured.add(bucket);
    }
    const r = await fetchImpl(`${base}/storage/v1/object/${bucket}/${key}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, apikey: token, "content-type": contentType, "x-upsert": "true" },
      body: new Uint8Array(bytes),
    });
    if (!r.ok) throw new Error(`upload HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    return `${base}/storage/v1/object/public/${bucket}/${key}`;
  },

  async imgbb(bytes, _key, contentType) {
    if (!contentType.startsWith("image/")) return undefined; // imgbb hosts images only
    const k = await setting("IMGBB_API_KEY");
    if (!k) return undefined;
    const form = new FormData();
    form.append("image", bytes.toString("base64"));
    const r = await fetchImpl(`https://api.imgbb.com/1/upload?key=${k}`, { method: "POST", body: form });
    const d = (await r.json().catch(() => ({}))) as { data?: { url?: string }; error?: { message?: string } };
    if (!r.ok || !d.data?.url) throw new Error(`imgbb HTTP ${r.status} ${d.error?.message ?? ""}`);
    return d.data.url;
  },

  async local(bytes, key) {
    const e = env();
    const path = resolve(e.LOCAL_MEDIA_DIR, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return `${e.PUBLIC_BASE_URL.replace(/\/$/, "")}/media/${key}`;
  },
};

export function localMediaPath(key: string): string {
  const root = resolve(env().LOCAL_MEDIA_DIR);
  const p = resolve(join(root, key));
  if (!p.startsWith(root + "/")) throw new Error("path traversal");
  return p;
}

/** Download an image. Anything that is not an image is an error, not bytes. */
export async function download(url: string, maxBytes = 30 * 1024 * 1024, expect = "image/"): Promise<Buffer> {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new TransientError(`download HTTP ${r.status} from ${url}`);
  const ct = r.headers.get("content-type") ?? "";
  if (ct && !ct.startsWith(expect) && !ct.startsWith("application/octet-stream") && !ct.startsWith("binary/octet-stream")) {
    throw new TransientError(`download from ${url} returned ${ct}, not ${expect}*`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`download too large: ${buf.length} bytes`);
  return buf;
}
