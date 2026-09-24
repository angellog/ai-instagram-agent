import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import sharp, { type Metadata } from "sharp";

/**
 * Carousel slide composer: generated photo + text layer → 1080×1350 sRGB JPEG,
 * the one format Instagram's publishing API accepts for every slide (4:5,
 * JPEG, ≤ 8 MB, ≤ 1440 px wide; docs/RESEARCH.md §2).
 *
 * Text is laid out in SVG and rasterized by resvg with bundled OFL fonts, so
 * output is identical on a laptop and on a Railway container with no system
 * fonts.
 */

export const SLIDE_W = 1080;
export const SLIDE_H = 1350;

export type OverlayKind = "none" | "cover" | "body" | "cta";

export interface Overlay {
  kind: OverlayKind;
  heading?: string;
  body?: string;
  /** "2/5" style counter; omitted on single images. */
  counter?: string;
  handle?: string;
}

export interface Brand {
  primary: string;
  text: string;
  shadow: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
function fontsDir(): string {
  // src/render → ../../assets/fonts ; dist/render → ../../assets/fonts
  return process.env.FONTS_DIR ?? resolve(HERE, "..", "..", "assets", "fonts");
}

const FONT_FILES = ["ArchivoBlack-Regular.ttf", "Inter-Bold.ttf", "Inter-Medium.ttf"];
let fontPaths: string[] | undefined;
function fonts(): string[] {
  if (!fontPaths) {
    fontPaths = FONT_FILES.map((f) => resolve(fontsDir(), f));
    // Fail at first use with a clear message rather than silently falling back.
    for (const p of fontPaths) readFileSync(p);
  }
  return fontPaths;
}

/** Bundled fonts are Latin-only; drop what they cannot draw instead of rendering tofu. */
export function sanitizeOverlayText(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E -ÿ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Average advance width as a fraction of font size, per font. Conservative
// (slightly wide) so text never overflows; checked in tests by rendering.
const WIDTH_FACTOR = { archivo: 0.8, interBold: 0.58, interMedium: 0.53 } as const;

export function wrap(text: string, fontSize: number, factor: number, maxWidth: number): string[] {
  const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * factor)));
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxChars) line = next;
    else {
      if (line) lines.push(line);
      line = w.length > maxChars ? w.slice(0, maxChars) : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Largest font size (stepping down) at which the text fits in maxLines. */
export function fit(text: string, sizes: number[], factor: number, maxWidth: number, maxLines: number): { size: number; lines: string[] } {
  for (const size of sizes) {
    const lines = wrap(text, size, factor, maxWidth);
    if (lines.length <= maxLines) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  const lines = wrap(text, size, factor, maxWidth);
  const clipped = lines.slice(0, maxLines);
  if (lines.length > maxLines) clipped[maxLines - 1] = `${clipped[maxLines - 1].replace(/[.,;:!?]?$/, "")}...`;
  return { size, lines: clipped };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function overlaySvg(o: Overlay, brand: Brand): string {
  const pad = 72;
  const maxW = SLIDE_W - pad * 2;
  const parts: string[] = [];
  const heading = o.heading ? sanitizeOverlayText(o.heading) : "";
  const body = o.body ? sanitizeOverlayText(o.body) : "";

  if (o.kind !== "none" && (heading || body)) {
    const gradTop = o.kind === "cover" ? 0.42 : 0.38;
    parts.push(
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="${gradTop}" stop-color="${brand.shadow}" stop-opacity="0"/>
        <stop offset="${gradTop + 0.25}" stop-color="${brand.shadow}" stop-opacity="0.55"/>
        <stop offset="1" stop-color="${brand.shadow}" stop-opacity="0.9"/>
      </linearGradient>
      <filter id="s" x="-5%" y="-20%" width="110%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="${brand.shadow}" flood-opacity="0.6"/></filter></defs>
      <rect x="0" y="0" width="${SLIDE_W}" height="${SLIDE_H}" fill="url(#g)"/>`,
    );

    let y = SLIDE_H - (o.handle ? 150 : 110);
    const blocks: string[] = [];
    if (body && o.kind !== "cover") {
      const b = fit(body, [40, 36, 32, 30], WIDTH_FACTOR.interMedium, maxW, 6);
      const lh = Math.round(b.size * 1.3);
      for (let i = b.lines.length - 1; i >= 0; i--) {
        blocks.unshift(`<text x="${pad}" y="${y}" font-family="Inter" font-weight="500" font-size="${b.size}" fill="${brand.text}">${esc(b.lines[i])}</text>`);
        y -= lh;
      }
      y -= 18;
    }
    if (heading) {
      const isCover = o.kind === "cover";
      const text = isCover ? heading.toUpperCase() : heading;
      const h = isCover
        ? fit(text, [92, 84, 76, 68, 60, 54], WIDTH_FACTOR.archivo, maxW, 4)
        : fit(text, [62, 56, 50, 46, 42], WIDTH_FACTOR.interBold, maxW, 3);
      const lh = Math.round(h.size * (isCover ? 1.02 : 1.12));
      const family = isCover ? `font-family="Archivo Black"` : `font-family="Inter" font-weight="700"`;
      const headLines: string[] = [];
      for (let i = h.lines.length - 1; i >= 0; i--) {
        headLines.unshift(`<text x="${pad}" y="${y}" ${family} font-size="${h.size}" fill="${brand.text}">${esc(h.lines[i])}</text>`);
        y -= lh;
      }
      // Accent bar above the heading.
      blocks.unshift(`<rect x="${pad}" y="${y + lh - h.size - 34}" width="96" height="10" rx="5" fill="${brand.primary}"/>`, ...headLines);
    }
    parts.push(`<g filter="url(#s)">`, ...blocks, `</g>`);
  }

  if (o.handle) {
    parts.push(
      `<text x="${pad}" y="${SLIDE_H - 64}" font-family="Inter" font-weight="500" font-size="30" fill="${brand.text}" fill-opacity="0.85">${esc(sanitizeOverlayText(o.handle))}</text>`,
    );
  }
  if (o.counter) {
    const w = 30 + o.counter.length * 17;
    parts.push(
      `<rect x="${SLIDE_W - pad - w}" y="56" width="${w}" height="52" rx="26" fill="${brand.shadow}" fill-opacity="0.45"/>
       <text x="${SLIDE_W - pad - w / 2}" y="92" text-anchor="middle" font-family="Inter" font-weight="700" font-size="28" fill="${brand.text}">${esc(o.counter)}</text>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SLIDE_W}" height="${SLIDE_H}" viewBox="0 0 ${SLIDE_W} ${SLIDE_H}">${parts.join("")}</svg>`;
}

export function renderOverlayPng(o: Overlay, brand: Brand): Buffer {
  const r = new Resvg(overlaySvg(o, brand), {
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "width", value: SLIDE_W },
  });
  return r.render().asPng();
}

/**
 * Crop/resize the source image to 4:5 (attention-based crop keeps the subject),
 * composite the text layer, and encode a baseline sRGB JPEG under 8 MB.
 */
export async function composeSlide(image: Buffer, o: Overlay, brand: Brand): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const base = sharp(image, { failOn: "error" }).rotate().resize(SLIDE_W, SLIDE_H, { fit: "cover", position: sharp.strategy.attention });
  const layers = o.kind === "none" && !o.counter && !o.handle ? [] : [{ input: renderOverlayPng(o, brand), top: 0, left: 0 }];
  let quality = 90;
  for (;;) {
    const jpeg = await base
      .clone()
      .composite(layers)
      .toColorspace("srgb")
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:4:4" })
      .toBuffer();
    if (jpeg.length <= 7.5 * 1024 * 1024 || quality <= 60) return { jpeg, width: SLIDE_W, height: SLIDE_H };
    quality -= 10;
  }
}

export interface ImageCheck {
  ok: boolean;
  problems: string[];
  width: number;
  height: number;
  meanLuma: number;
  stdev: number;
}

/**
 * Cheap pixel-level validation of a generated image before any spend on
 * composition or vision QC: decodable, large enough, not blank/flat, not
 * blown out or black.
 */
export async function inspectImage(buf: Buffer): Promise<ImageCheck> {
  const problems: string[] = [];
  let meta: Metadata;
  try {
    meta = await sharp(buf).metadata();
  } catch (e) {
    return { ok: false, problems: [`undecodable: ${(e as Error).message}`], width: 0, height: 0, meanLuma: 0, stdev: 0 };
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 720 || height < 900) problems.push(`too small ${width}x${height}`);
  const ratio = width / Math.max(1, height);
  if (ratio > 1.0 || ratio < 0.5) problems.push(`unexpected aspect ${ratio.toFixed(2)}`);
  const stats = await sharp(buf).greyscale().stats();
  const ch = stats.channels[0];
  if (ch.stdev < 12) problems.push("near-uniform image (blank or flat)");
  if (ch.mean < 18) problems.push("almost black");
  if (ch.mean > 240) problems.push("almost white / blown out");
  return { ok: problems.length === 0, problems, width, height, meanLuma: ch.mean, stdev: ch.stdev };
}
