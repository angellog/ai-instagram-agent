import sharp from "sharp";
import { setting } from "../config/settings.js";

/**
 * TikTok photo frames and their public URLs.
 *
 * TikTok downloads photo posts from a domain verified in the TikTok app and
 * does not follow redirects, so the web service serves each frame's bytes
 * itself at <TIKTOK_MEDIA_BASE_URL>/tiktok-media/<post>/<n>-<hash>.jpg
 * (see web/server.ts). Only assets of TikTok posts are ever served there.
 */

export const TIKTOK_W = 1080;
export const TIKTOK_H = 1920;

/**
 * 9:16 frame from any photo without cropping the subject away: the photo fits
 * the width, over a soft blurred, slightly darkened fill of itself. Used for
 * Instagram posts adapted to TikTok (4:5 → 9:16).
 */
export async function tiktokFrame(image: Buffer): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const meta = await sharp(image).metadata();
  const ratio = (meta.width ?? 1) / Math.max(1, meta.height ?? 1);
  // Already vertical 9:16 (a story frame): just normalise the size.
  if (Math.abs(ratio - TIKTOK_W / TIKTOK_H) < 0.02) {
    const jpeg = await sharp(image).rotate().resize(TIKTOK_W, TIKTOK_H, { fit: "cover" }).toColorspace("srgb").jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    return { jpeg, width: TIKTOK_W, height: TIKTOK_H };
  }
  const fill = await sharp(image).rotate().resize(TIKTOK_W, TIKTOK_H, { fit: "cover" }).blur(38).modulate({ brightness: 0.72 }).toBuffer();
  const photo = await sharp(image).rotate().resize(TIKTOK_W, TIKTOK_H, { fit: "inside" }).toBuffer();
  const pm = await sharp(photo).metadata();
  const jpeg = await sharp(fill)
    .composite([{ input: photo, top: Math.round((TIKTOK_H - (pm.height ?? TIKTOK_H)) / 2), left: Math.round((TIKTOK_W - (pm.width ?? TIKTOK_W)) / 2) }])
    .toColorspace("srgb")
    .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return { jpeg, width: TIKTOK_W, height: TIKTOK_H };
}

export async function mediaBase(): Promise<string | undefined> {
  const b = (await setting("TIKTOK_MEDIA_BASE_URL"))?.trim().replace(/\/+$/, "");
  return b && /^https:\/\//.test(b) ? b : undefined;
}

export function tiktokMediaPath(postId: string, position: number, sha: string | null): string {
  return `/tiktok-media/${postId}/${position + 1}-${(sha ?? "x").slice(0, 10)}.jpg`;
}

/** "3-ab12cd34ef.jpg" → slide position 2. */
export function positionFromFile(file: string): number | undefined {
  const m = /^(\d{1,2})-[0-9a-zx]{1,10}\.jpg$/.exec(file);
  return m ? Number(m[1]) - 1 : undefined;
}
