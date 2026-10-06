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
/** Instagram Story frame (9:16). */
export const STORY_W = 1080;
export const STORY_H = 1920;

export interface Size {
  w: number;
  h: number;
}
export const FEED: Size = { w: SLIDE_W, h: SLIDE_H };
export const STORY: Size = { w: STORY_W, h: STORY_H };

export type OverlayKind = "none" | "cover" | "body" | "cta" | "story";

/** How a story's words are drawn. Picked at random per story so the feed doesn't look templated. */
export const STORY_STYLES = ["panel", "plain", "caption", "script", "marker", "highlight"] as const;
export type StoryStyle = (typeof STORY_STYLES)[number];

export interface Overlay {
  kind: OverlayKind;
  heading?: string;
  body?: string;
  /** "2/5" style counter; omitted on single images. */
  counter?: string;
  handle?: string;
  /** Story text style (stories only); "panel" when absent. */
  style?: StoryStyle;
  /** Deterministic variation (tilt, position, sticker) for this story. */
  seed?: number;
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

const FONT_FILES = ["ArchivoBlack-Regular.ttf", "Inter-Bold.ttf", "Inter-Medium.ttf", "Pacifico-Regular.ttf", "PermanentMarker-Regular.ttf"];
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
const WIDTH_FACTOR = { archivo: 0.8, interBold: 0.58, interMedium: 0.53, pacifico: 0.62, marker: 0.6 } as const;

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

/**
 * Story text: a headline and an optional small line (e.g. the shop address) on
 * a soft panel in the lower-middle of the frame, clear of the areas Instagram
 * covers with its own UI (top ~14% and bottom ~20%).
 */
function storySvg(o: Overlay, brand: Brand, size: Size): string {
  const pad = 88;
  const maxW = size.w - pad * 2 - 48;
  const heading = o.heading ? sanitizeOverlayText(o.heading) : "";
  const body = o.body ? sanitizeOverlayText(o.body) : "";
  const h = heading ? fit(heading, [72, 64, 58, 52, 46], WIDTH_FACTOR.interBold, maxW, 4) : undefined;
  const b = body ? fit(body, [38, 34, 32, 30], WIDTH_FACTOR.interMedium, maxW, 3) : undefined;
  const hl = h ? Math.round(h.size * 1.15) : 0;
  const bl = b ? Math.round(b.size * 1.3) : 0;
  // Lay the lines out from the panel's top, then size the panel to them (equal padding above and below).
  const padY = 40;
  const lines: Array<(top: number) => string> = [];
  let y = padY + 18; // accent bar + gap
  if (h) {
    y += Math.round(h.size * 0.78);
    for (const [i, line] of h.lines.entries()) {
      const dy = y + i * hl;
      lines.push((top) => `<text x="${pad + 28}" y="${top + dy}" font-family="Inter" font-weight="700" font-size="${h.size}" fill="${brand.text}">${esc(line)}</text>`);
    }
    y += (h.lines.length - 1) * hl;
  }
  if (b) {
    y += h ? Math.round(h.size * 0.22) + 18 + Math.round(b.size * 0.78) : Math.round(b.size * 0.78);
    for (const [i, line] of b.lines.entries()) {
      const dy = y + i * bl;
      lines.push((top) => `<text x="${pad + 28}" y="${top + dy}" font-family="Inter" font-weight="500" font-size="${b.size}" fill="${brand.text}" fill-opacity="0.92">${esc(line)}</text>`);
    }
    y += (b.lines.length - 1) * bl;
  }
  const boxH = y + Math.round((b ? b.size : h!.size) * 0.22) + padY;
  const top = Math.round(size.h * 0.78) - boxH;
  const parts = [
    `<defs><filter id="s" x="-5%" y="-20%" width="110%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="10" flood-color="${brand.shadow}" flood-opacity="0.35"/></filter></defs>`,
    `<rect x="${pad}" y="${top}" width="${size.w - pad * 2}" height="${boxH}" rx="36" fill="${brand.shadow}" fill-opacity="0.58" filter="url(#s)"/>`,
    `<rect x="${pad + 28}" y="${top + padY - 8}" width="72" height="8" rx="4" fill="${brand.primary}"/>`,
    ...lines.map((line) => line(top)),
  ];
  return parts.join("");
}

export function overlaySvg(o: Overlay, brand: Brand, size: Size = FEED): string {
  const pad = 72;
  const SLIDE_W = size.w;
  const SLIDE_H = size.h;
  const maxW = SLIDE_W - pad * 2;
  const parts: string[] = [];
  const heading = o.heading ? sanitizeOverlayText(o.heading) : "";
  const body = o.body ? sanitizeOverlayText(o.body) : "";

  if (o.kind === "story" && (heading || body)) {
    parts.push(o.style && o.style !== "panel" ? styledStorySvg({ ...o, heading, body }, brand, size) : storySvg(o, brand, size));
  } else if (o.kind !== "none" && (heading || body)) {
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

export function renderOverlayPng(o: Overlay, brand: Brand, size: Size = FEED): Buffer {
  const r = new Resvg(overlaySvg(o, brand, size), {
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "width", value: size.w },
  });
  return r.render().asPng();
}

/**
 * Crop/resize the source image to 4:5 (attention-based crop keeps the subject),
 * composite the text layer, and encode a baseline sRGB JPEG under 8 MB.
 */
export async function composeSlide(image: Buffer, o: Overlay, brand: Brand, size: Size = FEED): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const base = sharp(image, { failOn: "error" }).rotate().resize(size.w, size.h, { fit: "cover", position: sharp.strategy.attention });
  const layers = o.kind === "none" && !o.counter && !o.handle ? [] : [{ input: renderOverlayPng(o, brand, size), top: 0, left: 0 }];
  let quality = 90;
  for (;;) {
    const jpeg = await base
      .clone()
      .composite(layers)
      .toColorspace("srgb")
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:4:4" })
      .toBuffer();
    if (jpeg.length <= 7.5 * 1024 * 1024 || quality <= 60) return { jpeg, width: size.w, height: size.h };
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

/** A small deterministic random source per story (tilt, position, sticker). */
function rng(seed: number): () => number {
  let x = (seed >>> 0) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10_000) / 10_000;
  };
}

/** Vector stickers (always render: no emoji font needed). Each is drawn around (0,0), ~120px. */
const STICKERS: Record<string, (c: string) => string> = {
  sparkle: (c) => `<path d="M0 -60 C8 -14 14 -8 60 0 C14 8 8 14 0 60 C-8 14 -14 8 -60 0 C-14 -8 -8 -14 0 -60Z" fill="${c}"/><path d="M52 -52 C55 -40 58 -37 70 -34 C58 -31 55 -28 52 -16 C49 -28 46 -31 34 -34 C46 -37 49 -40 52 -52Z" fill="${c}" opacity="0.85"/>`,
  heart: (c) => `<path d="M0 50 C-60 10 -62 -40 -28 -48 C-12 -52 -2 -40 0 -30 C2 -40 12 -52 28 -48 C62 -40 60 10 0 50Z" fill="${c}"/>`,
  star: (c) => `<path d="M0 -58 L16 -18 L58 -16 L25 10 L36 52 L0 28 L-36 52 L-25 10 L-58 -16 L-16 -18Z" fill="${c}"/>`,
  sun: (c) => `<circle r="30" fill="${c}"/>${Array.from({ length: 8 }, (_, i) => `<rect x="-5" y="-62" width="10" height="20" rx="5" fill="${c}" transform="rotate(${i * 45})"/>`).join("")}`,
  arrow: (c) => `<path d="M-50 30 C-30 -20 10 -30 40 -20" fill="none" stroke="${c}" stroke-width="10" stroke-linecap="round"/><path d="M22 -42 L48 -18 L18 -2" fill="none" stroke="${c}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`,
  burst: (c) => `<path d="${Array.from({ length: 24 }, (_, i) => { const r = i % 2 ? 40 : 60; const a = (i * Math.PI) / 12; return `${i ? "L" : "M"}${(Math.cos(a) * r).toFixed(1)} ${(Math.sin(a) * r).toFixed(1)}`; }).join(" ")}Z" fill="${c}"/>`,
};

/**
 * The non-panel story styles. All keep text inside the safe band (between the
 * top ~14% and bottom ~20% Instagram covers) and on the side of the frame the
 * prompt left calm.
 */
function styledStorySvg(o: Overlay, brand: Brand, size: Size): string {
  const r = rng(o.seed ?? 1);
  const heading = o.heading ?? "";
  const body = o.body ?? "";
  const W = size.w;
  const safeTop = Math.round(size.h * 0.16);
  const safeBottom = Math.round(size.h * 0.78);
  const accent = brand.primary;
  const shadow = `<defs><filter id="ts" x="-10%" y="-30%" width="120%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000" flood-opacity="0.55"/></filter></defs>`;
  const stickerNames = Object.keys(STICKERS);
  const sticker = (x: number, y: number, scale = 1) =>
    `<g transform="translate(${x} ${y}) rotate(${Math.round(r() * 40 - 20)}) scale(${scale})">${STICKERS[stickerNames[Math.floor(r() * stickerNames.length)]](r() < 0.5 ? accent : "#FFFFFF")}</g>`;
  const centerY = Math.round(safeTop + (safeBottom - safeTop) * (0.45 + r() * 0.35));

  switch (o.style) {
    case "plain": {
      const h = fit(heading || body, [96, 84, 74, 64, 56], WIDTH_FACTOR.interBold, W - 180, 4);
      const lh = Math.round(h.size * 1.12);
      const top = centerY - Math.round((h.lines.length * lh) / 2);
      const words = h.lines.map((l, i) => `<text x="${W / 2}" y="${top + i * lh + h.size}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="${h.size}" fill="#FFFFFF" filter="url(#ts)">${esc(l)}</text>`);
      const small = heading && body ? fit(body, [36, 32], WIDTH_FACTOR.interMedium, W - 220, 2) : undefined;
      const smallLines = small ? small.lines.map((l, i) => `<text x="${W / 2}" y="${top + h.lines.length * lh + 30 + (i + 1) * Math.round(small.size * 1.3)}" text-anchor="middle" font-family="Inter" font-weight="500" font-size="${small.size}" fill="#FFFFFF" filter="url(#ts)">${esc(l)}</text>`) : [];
      return shadow + words.join("") + smallLines.join("");
    }
    case "caption": {
      const h = fit([heading, body].filter(Boolean).join(" · "), [40, 36, 34, 32], WIDTH_FACTOR.interMedium, W - 260, 3);
      const lh = Math.round(h.size * 1.32);
      const boxW = Math.min(W - 160, Math.max(...h.lines.map((l) => l.length)) * h.size * WIDTH_FACTOR.interMedium + 72);
      const boxH = h.lines.length * lh + 44;
      const x = Math.round((W - boxW) / 2);
      const y = centerY - Math.round(boxH / 2);
      return `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${Math.min(40, boxH / 2)}" fill="#FFFFFF" fill-opacity="0.94"/>${h.lines
        .map((l, i) => `<text x="${W / 2}" y="${y + 22 + (i + 1) * lh - Math.round(h.size * 0.3)}" text-anchor="middle" font-family="Inter" font-weight="500" font-size="${h.size}" fill="#111111">${esc(l)}</text>`)
        .join("")}`;
    }
    case "script": {
      const h = fit(heading || body, [104, 92, 80, 70, 62], WIDTH_FACTOR.pacifico, W - 220, 3);
      const lh = Math.round(h.size * 1.3);
      const tilt = Math.round(r() * 10 - 6);
      const top = centerY - Math.round((h.lines.length * lh) / 2);
      const txt = h.lines.map((l, i) => `<text x="${W / 2}" y="${top + i * lh + h.size}" text-anchor="middle" font-family="Pacifico" font-size="${h.size}" fill="#FFFFFF" filter="url(#ts)">${esc(l)}</text>`).join("");
      const under = `<path d="M${W / 2 - 180} ${top + h.lines.length * lh + 18} C${W / 2 - 60} ${top + h.lines.length * lh + 34} ${W / 2 + 60} ${top + h.lines.length * lh + 2} ${W / 2 + 190} ${top + h.lines.length * lh + 20}" fill="none" stroke="${accent}" stroke-width="9" stroke-linecap="round"/>`;
      const small = heading && body ? `<text x="${W / 2}" y="${top + h.lines.length * lh + 90}" text-anchor="middle" font-family="Inter" font-weight="500" font-size="34" fill="#FFFFFF" filter="url(#ts)">${esc(fit(body, [34], WIDTH_FACTOR.interMedium, W - 220, 1).lines[0] ?? "")}</text>` : "";
      return `${shadow}<g transform="rotate(${tilt} ${W / 2} ${centerY})">${txt}${under}</g>${small}`;
    }
    case "marker": {
      const h = fit(heading || body, [84, 74, 66, 58], WIDTH_FACTOR.marker, W - 300, 3);
      const lh = Math.round(h.size * 1.15);
      const boxW = Math.min(W - 200, Math.max(...h.lines.map((l) => l.length)) * h.size * WIDTH_FACTOR.marker + 90);
      const boxH = h.lines.length * lh + 70;
      const tilt = Math.round(r() * 8 - 4);
      const x = Math.round((W - boxW) / 2);
      const y = centerY - Math.round(boxH / 2);
      const label = `<g transform="rotate(${tilt} ${W / 2} ${centerY})"><rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="14" fill="${accent}"/>${h.lines
        .map((l, i) => `<text x="${W / 2}" y="${y + 35 + (i + 1) * lh - Math.round(h.size * 0.18)}" text-anchor="middle" font-family="Permanent Marker" font-size="${h.size}" fill="${brand.text}">${esc(l)}</text>`)
        .join("")}</g>`;
      const side = r() < 0.5 ? x + 10 : x + boxW - 10;
      return label + sticker(side, y - 30, 0.9) + (heading && body ? `${shadow}<text x="${W / 2}" y="${y + boxH + 70}" text-anchor="middle" font-family="Inter" font-weight="500" font-size="34" fill="#FFFFFF" filter="url(#ts)">${esc(fit(body, [34], WIDTH_FACTOR.interMedium, W - 220, 1).lines[0] ?? "")}</text>` : "");
    }
    case "highlight":
    default: {
      const h = fit(heading || body, [66, 58, 52, 46], WIDTH_FACTOR.interBold, W - 240, 4);
      const lh = Math.round(h.size * 1.32);
      const top = centerY - Math.round((h.lines.length * lh) / 2);
      const bg = r() < 0.5 ? "#FFFFFF" : accent;
      const fg = bg === "#FFFFFF" ? "#111111" : brand.text;
      return (
        h.lines
          .map((l, i) => {
            const w = l.length * h.size * WIDTH_FACTOR.interBold + 44;
            const y = top + i * lh;
            return `<rect x="${(W - w) / 2}" y="${y}" width="${w}" height="${lh - 6}" rx="10" fill="${bg}"/><text x="${W / 2}" y="${y + Math.round(lh * 0.72)}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="${h.size}" fill="${fg}">${esc(l)}</text>`;
          })
          .join("") +
        (heading && body ? `${shadow}<text x="${W / 2}" y="${top + h.lines.length * lh + 50}" text-anchor="middle" font-family="Inter" font-weight="500" font-size="34" fill="#FFFFFF" filter="url(#ts)">${esc(fit(body, [34], WIDTH_FACTOR.interMedium, W - 220, 1).lines[0] ?? "")}</text>` : "") +
        (r() < 0.6 ? sticker(W - 170, top - 40, 0.8) : "")
      );
    }
  }
}
