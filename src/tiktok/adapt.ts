import { z } from "zod";
import { getControls } from "../config/controls.js";
import { currentInfluencer, influencerId } from "../context.js";
import { many, one, tx } from "../db/pool.js";
import { sha256 } from "../lib/crypto.js";
import { recordDecision } from "../lib/decisions.js";
import { errorMessage } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { llm } from "../llm/llm.js";
import { persona } from "../persona/loader.js";
import { personaSystemBlock } from "../persona/prompt.js";
import { assessText, openReview } from "../safety/safety.js";
import { download, hostImage } from "../storage/host.js";
import { tiktokFrame } from "./media.js";

/**
 * "Also post to TikTok": turn an Instagram post (or story) into a TikTok photo
 * post. The photos are re-framed to 9:16 without cropping, the caption is
 * rewritten the TikTok way, and the result waits in Reviews with its TikTok
 * settings (privacy, comments, promotion, AI label) for the operator.
 */

export interface TikTokSettings {
  title: string;
  privacy: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
  allow_comments: boolean;
  /** Promoting the influencer's own business (TikTok's brand_organic_toggle), e.g. FeetBit. */
  promotes_own_business: boolean;
  /** Always on: TikTok's is_aigc flag. */
  ai_label: true;
  publish_id?: string | null;
  post_id?: string | null;
  privacy_used?: string;
  note?: string;
}

export const tiktokCaptionSchema = z.object({
  title: z.string().describe("Short on-post title, max 90 characters, plain words"),
  caption: z.string().describe("1-2 short lines for TikTok: a hook first, natural, max 300 characters, no hashtags"),
  hashtags: z.array(z.string()).describe("3-5 relevant hashtags without #, mixing broad and local"),
});

const SYSTEM = (p: ReturnType<typeof persona>) => `${personaSystemBlock(p)}

---
You rewrite an Instagram post for TikTok, in the same voice. TikTok photo posts are read fast: the first line is the hook.
- title: at most 90 characters, plain words, no emoji.
- caption: 1-2 short lines, under 300 characters, the hook first; never describe what the photos show; at most 1-2 emoji.
- hashtags: 3-5, no "#", relevant to the post and the creator's city and niche; never AI hashtags.
Never invent prices, stock, dates or facts. Return JSON only.`;

export function buildDescription(caption: string, hashtags: string[]): string {
  const tags = [...new Set(hashtags.map((h) => h.replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean))].slice(0, 5);
  return `${caption.trim()}${tags.length ? `\n\n${tags.map((t) => `#${t}`).join(" ")}` : ""}`.slice(0, 2200);
}

export async function adaptToTikTok(sourceId: string, by: string): Promise<{ ok: boolean; message: string; postId?: string }> {
  const src = await one<{ id: string; platform: string; media_type: string; caption: string; status: string; visual_state: unknown; safety_level: string | null }>(
    "SELECT id, platform, media_type, caption, status, visual_state, safety_level FROM posts WHERE id = $1 AND influencer_id = $2",
    [sourceId, influencerId()],
  );
  if (!src) return { ok: false, message: "Post not found" };
  if (src.platform !== "instagram") return { ok: false, message: "Only Instagram posts can be adapted to TikTok" };
  if (["rejected", "failed", "draft", "generating", "composing"].includes(src.status)) return { ok: false, message: `A ${src.status} post can't be adapted yet` };
  if (src.safety_level === "red") return { ok: false, message: "RED posts are never published anywhere" };
  const existing = await one<{ id: string }>("SELECT id FROM posts WHERE source_post_id = $1 AND platform = 'tiktok'", [sourceId]);
  if (existing) return { ok: true, message: "Already adapted for TikTok: here it is", postId: existing.id };
  const c = await getControls();
  if (!c.tiktok_enabled) return { ok: false, message: "TikTok is off in Controls" };
  const assets = await many<{ position: number; public_url: string; overlay: { alt_text?: string } | null }>(
    "SELECT position, public_url, overlay FROM post_assets WHERE post_id = $1 AND public_url IS NOT NULL ORDER BY position",
    [sourceId],
  );
  if (!assets.length) return { ok: false, message: "The post has no finished images yet" };
  const p = persona();

  // Caption, TikTok style (falls back to the Instagram caption if the model is unavailable).
  let title = "";
  let description = src.caption;
  try {
    const out = await llm().structured(tiktokCaptionSchema, {
      operation: "tiktok.caption",
      tier: "smart",
      maxTokens: 400,
      ref: { type: "post", id: sourceId },
      system: SYSTEM(p),
      prompt: `INSTAGRAM CAPTION:\n"""${src.caption}"""\n\nRewrite it for TikTok.`,
    });
    title = out.title.replace(/\s+/g, " ").trim().slice(0, 90);
    description = buildDescription(out.caption, out.hashtags);
  } catch (e) {
    await recordEvent("warn", "tiktok", "TikTok caption rewrite failed; using the Instagram caption", { sourceId, error: errorMessage(e) });
  }
  const safety = await assessText(`${title}\n${description}`, { direction: "outbound", context: "TikTok post title and caption", ref: { type: "post", id: sourceId } });
  if (safety.level === "red") return { ok: false, message: `The TikTok caption was blocked by the safety check (${safety.categories.join(", ")})` };

  const settings: TikTokSettings = {
    title,
    privacy: c.tiktok_default_privacy,
    allow_comments: c.tiktok_allow_comments,
    promotes_own_business: Boolean(p.identity.affiliation?.trim()) && !/independent|none/i.test(p.identity.affiliation ?? ""),
    ai_label: true,
  };

  // Frames first (the slow part), then everything in one transaction.
  const frames: Array<{ position: number; url: string; provider: string; sha: string; bytes: number; alt?: string }> = [];
  const tmpId = crypto.randomUUID();
  for (const a of assets) {
    const { jpeg } = await tiktokFrame(await download(a.public_url));
    const sha = sha256(jpeg);
    const hosted = await hostImage(jpeg, `influencers/${currentInfluencer().slug}/tiktok/${tmpId}/${a.position + 1}-${sha.slice(0, 10)}.jpg`);
    frames.push({ position: a.position, url: hosted.url, provider: hosted.provider, sha, bytes: jpeg.length, alt: a.overlay?.alt_text });
  }
  const postId = await tx(async (client) => {
    const post = await client.query<{ id: string }>(
      `INSERT INTO posts (id, influencer_id, platform, source_post_id, media_type, caption, status, safety_level, visual_state, origin, tiktok, qc)
       VALUES ($1, $2, 'tiktok', $3, $4, $5, 'awaiting_review', $6, $7, 'operator', $8, $9) RETURNING id`,
      [
        tmpId,
        influencerId(),
        sourceId,
        frames.length > 1 ? "CAROUSEL" : "IMAGE",
        description,
        safety.level,
        JSON.stringify(src.visual_state ?? {}),
        JSON.stringify(settings),
        JSON.stringify({ structural: "pass", safety: { categories: safety.categories, reason: safety.reason } }),
      ],
    );
    for (const f of frames) {
      await client.query(
        `INSERT INTO post_assets (post_id, position, role, public_url, storage_provider, width, height, sha256, overlay, qc)
         VALUES ($1, $2, 'slide', $3, $4, 1080, 1920, $5, $6, $7)`,
        [tmpId, f.position, f.url, f.provider, f.sha, JSON.stringify({ kind: "none", alt_text: f.alt }), JSON.stringify({ bytes: f.bytes })],
      );
    }
    return post.rows[0].id;
  });
  await openReview({ subjectType: "post", subjectId: postId, assessment: safety, proposed: { caption: description, slides: frames.map((f) => f.url), platform: "tiktok" } });
  await recordDecision({ agent: "human_reviewer", subjectType: "post", subjectId: postId, action: "adapt_to_tiktok", reason: `${by}: from ${sourceId}` });
  await recordEvent("info", "tiktok", "Instagram post adapted for TikTok", { sourceId, postId, photos: frames.length });
  return { ok: true, message: `TikTok version ready for review (${frames.length} photo${frames.length === 1 ? "" : "s"})`, postId };
}
