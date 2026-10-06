import { z } from "zod";
import { getControls } from "../config/controls.js";
import { currentInfluencer, influencerId } from "../context.js";
import { checkFacts } from "../conversation/facts.js";
import { knowledge } from "../conversation/knowledge.js";
import { fitCaption, tidyCaption } from "../content/caption.js";
import { finalizePost } from "../content/produce.js";
import { many, one, tx } from "../db/pool.js";
import { sha256 } from "../lib/crypto.js";
import { PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { llm } from "../llm/llm.js";
import { frameAt, toFeedJpeg, toReelMp4 } from "../media/video.js";
import { persona } from "../persona/loader.js";
import { personaSystemBlock } from "../persona/prompt.js";
import type { Persona } from "../persona/schema.js";
import { download, hostImage, mediaPrefix } from "../storage/host.js";

/**
 * The business content library: media a brand uploads for its influencer.
 * Each item goes out at a set time ("scheduled") or when the influencer's
 * content director finds the right moment ("ai"). Either way the caption is
 * written in the influencer's own voice from the business's notes, and the
 * post passes the same safety check and review as everything else.
 * Items marked as reel material (screen recordings, b-roll) are never posted
 * on their own: AI reels cut them in.
 */

export type LibraryTarget = "auto" | "feed" | "story" | "reel";
export interface LibraryFile {
  url: string;
  mime: string;
  width: number;
  height: number;
  duration_s?: number;
  bytes: number;
}
export interface LibraryItem {
  id: string;
  influencer_id: number;
  title: string;
  notes: string;
  kind: "image" | "video";
  files: LibraryFile[];
  mode: "ai" | "scheduled";
  scheduled_for: Date | null;
  target: LibraryTarget;
  reel_material: boolean;
  status: "ready" | "planned" | "posted" | "failed" | "archived";
  post_id: string | null;
  last_error: string | null;
  created_at: Date;
}

export interface Upload {
  bytes: Buffer;
  mime: string;
  filename: string;
}

export const LIBRARY_LIMITS = { files: 10, imageBytes: 25 * 1024 * 1024, videoBytes: 200 * 1024 * 1024 } as const;

const isVideo = (mime: string, name: string) => mime.startsWith("video/") || /\.(mp4|mov|m4v|webm|3gp)$/i.test(name);
const isImage = (mime: string, name: string) => mime.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(name);

/** Validate, normalise and host an upload, then save the item (and plan it now if it has a time). */
export async function saveLibraryItem(o: {
  title: string;
  notes?: string;
  files: Upload[];
  mode: "ai" | "scheduled";
  scheduledFor?: Date;
  target?: LibraryTarget;
  reelMaterial?: boolean;
  by: string;
}): Promise<LibraryItem> {
  const title = o.title.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!title) throw new PermanentError("give it a short title (what it is)");
  if (!o.files.length) throw new PermanentError("add at least one photo or video");
  if (o.files.length > LIBRARY_LIMITS.files) throw new PermanentError(`at most ${LIBRARY_LIMITS.files} files per item`);
  const videos = o.files.filter((f) => isVideo(f.mime, f.filename));
  const images = o.files.filter((f) => isImage(f.mime, f.filename));
  if (videos.length + images.length !== o.files.length) throw new PermanentError("only photos (JPEG, PNG, WebP, HEIC) and videos (MP4, MOV) are accepted");
  if (videos.length && images.length) throw new PermanentError("an item is either photos or one video, not both");
  if (videos.length > 1) throw new PermanentError("one video per item (upload the others as separate items)");
  const kind = videos.length ? "video" : "image";
  let target: LibraryTarget = o.target ?? "auto";
  if (kind === "video" && (target === "feed" || target === "story")) target = "reel";
  if (kind === "image" && target === "reel") throw new PermanentError("a reel needs a video");
  if (target === "story" && images.length > 1) throw new PermanentError("a story is one photo");
  if (o.mode === "scheduled") {
    if (!o.scheduledFor || Number.isNaN(o.scheduledFor.getTime())) throw new PermanentError("pick a date and time");
    if (o.scheduledFor.getTime() < Date.now() - 5 * 60_000) throw new PermanentError("that time has already passed");
    if (o.reelMaterial) throw new PermanentError("reel material is cut into AI reels, not posted on its own: choose 'let them decide'");
  }

  const id = (await one<{ id: string }>("SELECT gen_random_uuid()::text AS id"))!.id;
  const prefix = `${mediaPrefix(influencerId())}/library/${id}`;
  const files: LibraryFile[] = [];
  for (const [i, f] of o.files.entries()) {
    if (kind === "video") {
      if (f.bytes.length > LIBRARY_LIMITS.videoBytes) throw new PermanentError(`${f.filename} is over ${LIBRARY_LIMITS.videoBytes / 1024 / 1024} MB`);
      const { mp4, info } = await toReelMp4(f.bytes);
      const hosted = await hostImage(mp4, `${prefix}/${i + 1}-${sha256(mp4).slice(0, 10)}.mp4`, { contentType: "video/mp4", order: ["supabase", "local"] });
      files.push({ url: hosted.url, mime: "video/mp4", width: info.width, height: info.height, duration_s: Math.round(info.durationS * 10) / 10, bytes: mp4.length });
    } else {
      if (f.bytes.length > LIBRARY_LIMITS.imageBytes) throw new PermanentError(`${f.filename} is over ${LIBRARY_LIMITS.imageBytes / 1024 / 1024} MB`);
      const { jpeg, width, height } = await toFeedJpeg(f.bytes, target === "story" ? "story" : "feed");
      const hosted = await hostImage(jpeg, `${prefix}/${i + 1}-${sha256(jpeg).slice(0, 10)}.jpg`);
      files.push({ url: hosted.url, mime: "image/jpeg", width, height, bytes: jpeg.length });
    }
  }
  const item = (await one<LibraryItem>(
    `INSERT INTO library_items (id, influencer_id, title, notes, kind, files, mode, scheduled_for, target, reel_material, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [id, influencerId(), title, (o.notes ?? "").trim().slice(0, 1500), kind, JSON.stringify(files), o.mode, o.mode === "scheduled" ? o.scheduledFor : null, target, Boolean(o.reelMaterial), o.by],
  ))!;
  await recordEvent("info", "library", `Library item added: ${title}`, { itemId: id, kind, mode: o.mode });
  // A set time: write the caption and queue it for review now, so there's time to look before it goes out.
  if (o.mode === "scheduled") return (await planLibraryPost(id)).item;
  return item;
}

export async function getLibraryItem(id: string): Promise<LibraryItem | undefined> {
  return (await one<LibraryItem>("SELECT * FROM library_items WHERE id = $1 AND influencer_id = $2", [id, influencerId()])) ?? undefined;
}

export async function listLibrary(limit = 100): Promise<LibraryItem[]> {
  return many<LibraryItem>("SELECT * FROM library_items WHERE influencer_id = $1 AND status <> 'archived' ORDER BY created_at DESC LIMIT $2", [influencerId(), limit]);
}

/** Items the content director may choose from right now ("let them decide"), oldest first. */
export async function libraryForDirector(limit = 5): Promise<LibraryItem[]> {
  return many<LibraryItem>(
    "SELECT * FROM library_items WHERE influencer_id = $1 AND mode = 'ai' AND status = 'ready' AND NOT reel_material ORDER BY created_at LIMIT $2",
    [influencerId(), limit],
  );
}

/** Reel material (screen recordings, b-roll) the reel maker may cut in. */
export async function reelMaterial(limit = 20): Promise<LibraryItem[]> {
  return many<LibraryItem>("SELECT * FROM library_items WHERE influencer_id = $1 AND reel_material AND kind = 'video' AND status <> 'archived' ORDER BY created_at DESC LIMIT $2", [
    influencerId(),
    limit,
  ]);
}

/** How an item goes out, given its files and target. */
export function mediaTypeFor(item: Pick<LibraryItem, "kind" | "files" | "target">): "IMAGE" | "CAROUSEL" | "STORY" | "REEL" {
  if (item.kind === "video") return "REEL";
  if (item.target === "story") return "STORY";
  return item.files.length > 1 ? "CAROUSEL" : "IMAGE";
}

const captionSchema = z.object({
  caption: z.string().describe("1-3 short lines in the creator's own voice"),
  hashtags: z.array(z.string()).max(5),
  alt_text: z.string().describe("Plain description of the media, max 200 chars"),
});

function captionSystem(p: Persona): string {
  return `${personaSystemBlock(p)}

---
The business you work with has given you this photo/video to post. Write the caption the way you'd post your own content: your voice, one simple thought, everyday words. It may name ${p.brand?.name ?? "the brand"} because it's their content, but it must not read like an advert (no "link in bio", no shouting, no lists of features).
- Use ONLY facts from the business notes and the knowledge given. Never invent prices, discounts, stock, dates or addresses; leave them out if the notes don't give them.
- If the notes say what the caption must include, include it exactly.
- Never describe the photo; say something about it.
Return JSON only.`;
}

/**
 * Turn an item into a post: caption in the influencer's voice, media copied in,
 * then the normal safety check and review. Scheduled items publish at their
 * time once approved; "ai" items go out in the next posting window.
 */
export async function planLibraryPost(itemId: string, o: { caption?: string; hashtags?: string[] } = {}): Promise<{ item: LibraryItem; postId: string }> {
  const item = await getLibraryItem(itemId);
  if (!item) throw new PermanentError("library item not found");
  if (item.status !== "ready") throw new PermanentError(`this item is already ${item.status}`);
  if (item.reel_material) throw new PermanentError("reel material is used inside reels, not posted on its own");
  const p = persona();
  const c = await getControls();
  const mediaType = mediaTypeFor(item);

  let caption = o.caption;
  let hashtags = o.hashtags ?? [];
  let alt = item.title;
  if (!caption) {
    const preview = item.kind === "video" ? await frameAt(await download(item.files[0].url, 250 * 1024 * 1024, "video/"), 1) : await download(item.files[0].url);
    const kb = knowledge();
    const out = await llm().structured(captionSchema, {
      operation: "library.caption",
      tier: "smart",
      maxTokens: 600,
      system: captionSystem(p),
      prompt: [
        `WHAT IT IS: ${item.title}`,
        item.notes ? `BUSINESS NOTES (the only facts you may state):\n${item.notes}` : "",
        kb.length ? `KNOWLEDGE:\n${kb.map((k) => `- ${k.id}: ${k.content}`).join("\n")}` : "",
        `FORMAT: ${mediaType === "REEL" ? "a reel (video)" : mediaType === "STORY" ? "a story (no caption is shown; write one anyway for the record)" : mediaType === "CAROUSEL" ? `a carousel of ${item.files.length} photos` : "one photo"}`,
        `Hashtags: at most ${p.hashtags.max}, from: ${p.hashtags.pool.join(" ")} (or none).`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      images: [{ mediaType: "image/jpeg", data: (await toFeedJpeg(preview, "feed")).jpeg.toString("base64"), label: "The media to post" }],
    });
    caption = tidyCaption(out.caption, false);
    hashtags = out.hashtags;
    alt = out.alt_text.slice(0, 200);
    // Numbers in the caption must come from the notes or the knowledge.
    const facts = checkFacts(caption, { used: [], shown: kb, inbound: `${item.title}\n${item.notes}` });
    if (facts.unverified.length) caption = `${caption}\n\n(check: ${facts.unverified.join(", ")} not in the notes)`;
  }
  const finalCaption = mediaType === "STORY" ? "" : fitCaption(caption, hashtags, p);

  const postId = await tx(async (client) => {
    const idea = await client.query<{ id: number }>(
      `INSERT INTO content_ideas (format, structure, topic, hook, angle, plan, caption, visual_state, status, influencer_id)
       VALUES ($1, 'library', $2, $2, 'business content', $3, $4, '{}', 'accepted', $5) RETURNING id`,
      [
        mediaType === "REEL" ? "reel" : mediaType === "STORY" ? "story" : mediaType === "CAROUSEL" ? "carousel" : "single",
        item.title,
        JSON.stringify({ library_item_id: item.id, slides: item.files.map((_, i) => ({ role: i ? "slide" : "cover", shot: item.title, include_character: false, overlay_kind: "none", alt_text: alt })) }),
        finalCaption,
        influencerId(),
      ],
    );
    const post = await client.query<{ id: string }>(
      `INSERT INTO posts (influencer_id, content_idea_id, media_type, caption, status, visual_state, origin, library_item_id, scheduled_for)
       VALUES ($1, $2, $3, $4, 'composing', '{}', 'library', $5, $6) RETURNING id`,
      [influencerId(), idea.rows[0].id, mediaType, finalCaption, item.id, item.mode === "scheduled" ? item.scheduled_for : null],
    );
    for (const [i, f] of item.files.entries()) {
      await client.query(
        `INSERT INTO post_assets (post_id, position, role, prompt, overlay, generated_url, public_url, storage_provider, width, height, sha256, qc, media_kind, duration_s)
         VALUES ($1, $2, $3, 'business upload', $4, $5, $5, 'library', $6, $7, '', $8, $9, $10)`,
        [post.rows[0].id, i, i ? "slide" : "cover", JSON.stringify({ kind: "none", alt_text: alt }), f.url, f.width, f.height, JSON.stringify({ bytes: f.bytes }), f.mime.startsWith("video/") ? "video" : "image", f.duration_s ?? null],
      );
    }
    await client.query("UPDATE library_items SET status = 'planned', post_id = $2, last_error = NULL, updated_at = now() WHERE id = $1", [item.id, post.rows[0].id]);
    return post.rows[0].id;
  });
  const outcome = await finalizePost(postId, c, p);
  if (["qc_failed", "rejected", "failed"].includes(outcome)) {
    await one("UPDATE library_items SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [item.id, `post ${outcome}: see the post`]);
  }
  await recordEvent("info", "library", `Library item planned as a ${mediaType.toLowerCase()}: ${item.title}`, { itemId: item.id, postId, outcome });
  return { item: (await getLibraryItem(item.id))!, postId };
}

/** Mark the item posted once its post goes live (called from publishing). */
export async function markLibraryPosted(postId: string): Promise<void> {
  await one("UPDATE library_items SET status = 'posted', updated_at = now() WHERE post_id = $1 AND influencer_id = $2", [postId, influencerId()]);
}

export async function archiveLibraryItem(id: string): Promise<boolean> {
  const r = await one<{ id: string }>("UPDATE library_items SET status = 'archived', updated_at = now() WHERE id = $1 AND influencer_id = $2 AND status <> 'posted' RETURNING id", [id, influencerId()]);
  return Boolean(r);
}


export function libraryOwnerName(): string {
  return currentInfluencer().name;
}
