import sharp from "sharp";
import { one } from "../db/pool.js";
import { HiggsfieldAdapter } from "../generation/adapters/higgsfield.js";
import { adapter } from "../generation/adapters/index.js";
import { sha256 } from "../lib/crypto.js";
import { PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { download, hostImage } from "../storage/host.js";
import { activeSoul, createSoul, setSoulBinding, type SoulRow } from "./souls.js";

/**
 * Operator-facing soul management: bring your own face photos (URL or
 * upload), version the soul, and bind/train provider-side characters.
 */

const MIN_SIDE = 512;

async function slugOf(influencerId: number): Promise<string> {
  const r = await one<{ slug: string }>("SELECT slug FROM influencers WHERE id = $1", [influencerId]);
  if (!r) throw new PermanentError(`influencer ${influencerId} not found`);
  return r.slug;
}

/** True when the URL is already a durable reference/asset owned by this influencer. */
async function owned(influencerId: number, url: string): Promise<boolean> {
  return Boolean(
    await one("SELECT 1 FROM visual_references WHERE influencer_id = $1 AND url = $2 UNION SELECT 1 FROM assets WHERE influencer_id = $1 AND url = $2", [influencerId, url]),
  );
}

/**
 * Copy a face photo (public URL or data: URL from the browser) into our
 * storage under the influencer, after checking it is a usable image.
 */
export async function rehostReference(influencerId: number, source: string): Promise<string> {
  const s = source.trim();
  if (!s) throw new PermanentError("empty image");
  if (/^https?:\/\//.test(s) && (await owned(influencerId, s))) return s;
  let bytes: Buffer;
  if (s.startsWith("data:image/")) {
    const b64 = s.slice(s.indexOf(",") + 1);
    bytes = Buffer.from(b64, "base64");
  } else if (/^https?:\/\//.test(s)) {
    bytes = await download(s, 25 * 1024 * 1024, "image/");
  } else {
    throw new PermanentError("use an https:// image URL or upload a file");
  }
  const meta = await sharp(bytes).metadata().catch(() => undefined);
  if (!meta?.width || !meta.height) throw new PermanentError("that file is not a readable image");
  if (Math.min(meta.width, meta.height) < MIN_SIDE) throw new PermanentError(`image is too small (${meta.width}×${meta.height}); use at least ${MIN_SIDE}px on the short side`);
  const jpeg = await sharp(bytes).rotate().resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  const { url } = await hostImage(jpeg, `influencers/${await slugOf(influencerId)}/refs/${sha256(jpeg).slice(0, 16)}.jpg`);
  return url;
}

/**
 * New soul version from a list of references (URLs or data URLs). The first
 * becomes the primary face and the influencer's avatar. Provider bindings are
 * trained on a specific face, so they are only carried over when asked.
 */
export async function newSoulVersion(o: { influencerId: number; sources: string[]; description?: string; keepBindings?: boolean; soulId?: string }): Promise<SoulRow> {
  const sources = o.sources.map((x) => x.trim()).filter(Boolean);
  if (!sources.length) throw new PermanentError("add at least one face photo");
  if (sources.length > 12) throw new PermanentError("use at most 12 reference photos");
  const refs: string[] = [];
  for (const src of sources) refs.push(await rehostReference(o.influencerId, src));
  const prev = await activeSoul(o.influencerId);
  const soul = await createSoul({
    influencerId: o.influencerId,
    soulId: o.soulId?.trim() || undefined,
    identityRefs: [...new Set(refs)],
    description: o.description,
    bindings: o.keepBindings ? (prev?.soul.provider_bindings ?? {}) : {},
  });
  await one("UPDATE influencers SET avatar_url = $2, updated_at = now() WHERE id = $1", [o.influencerId, refs[0]]);
  await recordEvent("info", "soul", `New soul ${soul.soul_id}`, { influencerId: o.influencerId, refs: refs.length });
  return soul;
}

function higgsfield(): HiggsfieldAdapter {
  const a = adapter("higgsfield");
  if (!(a instanceof HiggsfieldAdapter)) throw new PermanentError("Higgsfield adapter not registered");
  return a;
}

/**
 * Train a Higgsfield Soul ID from the active soul's references. The id is
 * stored as `pending_id` until training completes; only a completed character
 * is used for routing (bindings.higgsfield.soul_id).
 */
export async function trainHiggsfieldSoul(influencerId: number): Promise<{ id: string; status: string }> {
  const s = await activeSoul(influencerId);
  if (!s) throw new PermanentError("give the influencer a soul first");
  const hf = higgsfield();
  if (!(await hf.isConfigured())) throw new PermanentError("set the Higgsfield key id and secret in Config first");
  const name = (await one<{ name: string }>("SELECT name FROM influencers WHERE id = $1", [influencerId]))!.name;
  const r = await hf.trainSoul(`${name} · ${s.soul.soul_id}`, s.identityRefs);
  await setSoulBinding({ influencerId, provider: "higgsfield", binding: { pending_id: r.id, status: r.status, requested_at: new Date().toISOString() } });
  await recordEvent("info", "soul", "Higgsfield Soul ID training started", { influencerId, characterId: r.id, refs: s.identityRefs.length });
  return r;
}

/** Poll training; promotes the character to an active binding when complete. */
export async function refreshHiggsfieldSoul(influencerId: number): Promise<{ status: string; soulId?: string; reason?: string }> {
  const s = await activeSoul(influencerId);
  const b = s?.soul.provider_bindings?.higgsfield as { pending_id?: string; soul_id?: string } | undefined;
  const id = b?.pending_id ?? b?.soul_id;
  if (!id) throw new PermanentError("no Higgsfield character to check");
  const st = await higgsfield().soulStatus(id);
  if (st.status === "completed") {
    await setSoulBinding({ influencerId, provider: "higgsfield", binding: { soul_id: st.id, status: "completed", thumbnail_url: st.thumbnailUrl, strength: 0.9 } });
    return { status: "completed", soulId: st.id };
  }
  await setSoulBinding({ influencerId, provider: "higgsfield", binding: { ...(b ?? {}), pending_id: id, status: st.status, fail_reason: st.failReason } });
  return { status: st.status, reason: st.failReason };
}

/** Bind a character trained elsewhere (checked against the API when a key is set). */
export async function bindHiggsfieldSoul(influencerId: number, characterId: string): Promise<string> {
  const id = characterId.trim();
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw new PermanentError("that does not look like a Higgsfield character id");
  const hf = higgsfield();
  if (await hf.isConfigured()) {
    const st = await hf.soulStatus(id);
    if (st.status !== "completed") {
      await setSoulBinding({ influencerId, provider: "higgsfield", binding: { pending_id: id, status: st.status } });
      return `Character is ${st.status}; it will be used once training completes`;
    }
  }
  await setSoulBinding({ influencerId, provider: "higgsfield", binding: { soul_id: id, status: "completed", strength: 0.9 } });
  return "Higgsfield Soul ID bound";
}
