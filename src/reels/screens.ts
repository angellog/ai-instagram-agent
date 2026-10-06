import { z } from "zod";

/**
 * Phone-screen recreations for explainer reels. Tip creators show exactly where
 * to tap; AI video can't draw a real Settings screen, so we draw it: an iOS
 * style grouped list (or Android-style list) inside a phone frame, with the
 * finger, the tap ripple, the highlighted row and toggles animated per frame.
 * Pure SVG, rendered with the bundled fonts.
 */

export const rowSchema = z.object({
  label: z.string().describe("Exact row text as it appears on the phone"),
  section: z.string().nullable().describe("Section header shown ABOVE this row when it starts a new group, else null"),
  icon_color: z.string().nullable().describe("Settings icon colour as a hex (e.g. #34C759 green, #007AFF blue, #FF9500 orange, #8E8E93 grey), or null for no icon"),
  value: z.string().nullable().describe("Grey value on the right (e.g. 'On', 'Wi-Fi name'), or null"),
  toggle: z.boolean().nullable().describe("true/false when the row has a switch (its state BEFORE any tap), null otherwise"),
  chevron: z.boolean().describe("true when the row opens another screen"),
});
export const screenSchema = z.object({
  title: z.string().describe("The screen's title as shown (e.g. 'Settings', 'Battery')"),
  back: z.string().nullable().describe("Back button text (the previous screen's title), or null on the first screen"),
  rows: z.array(rowSchema).min(1).max(12),
  footer: z.string().nullable().describe("Small grey explanation under the list, or null"),
});
export type Screen = z.infer<typeof screenSchema>;
export type Row = z.infer<typeof rowSchema>;

export const OS_STYLES = ["ios", "android"] as const;
export type OsStyle = (typeof OS_STYLES)[number];

const FRAME = { w: 1080, h: 1920 };
/** The phone and its screen on the 1080x1920 canvas. */
export const PHONE = { x: 170, y: 420, w: 740, h: 1440, bezel: 20, radius: 108 } as const;
const SCREEN = { x: PHONE.x + PHONE.bezel, y: PHONE.y + PHONE.bezel, w: PHONE.w - PHONE.bezel * 2, h: PHONE.h - PHONE.bezel * 2, radius: PHONE.radius - PHONE.bezel };
/** Points → pixels on the drawn screen (a 390pt-wide phone). */
const S = SCREEN.w / 390;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface ScreenState {
  /** Row index highlighted (pressed), or -1. */
  pressed: number;
  /** 0..1 progress of a toggle switching on the pressed row. */
  toggleT: number;
}

/** Where each row sits on the screen (for the finger). Coordinates are canvas pixels. */
export function rowCenters(screen: Screen, os: OsStyle): Array<{ x: number; y: number }> {
  return layout(screen, os).rows.map((r) => ({ x: SCREEN.x + SCREEN.w * 0.62, y: SCREEN.y + r.y + r.h / 2 }));
}

interface Laid {
  rows: Array<{ y: number; h: number; first: boolean; last: boolean; header?: { text: string; y: number } }>;
  footerY: number;
}

function layout(screen: Screen, os: OsStyle): Laid {
  const rowH = (os === "ios" ? 44 : 56) * S;
  let y = (os === "ios" ? 54 + 44 + 52 + 10 : 54 + 64 + 10) * S; // status bar + nav + large title
  const rows: Laid["rows"] = [];
  screen.rows.forEach((r, i) => {
    const newGroup = i === 0 || r.section !== null;
    if (newGroup && i > 0) y += (os === "ios" ? 22 : 8) * S;
    let header: { text: string; y: number } | undefined;
    if (r.section) {
      header = { text: r.section, y: y + 18 * S };
      y += 28 * S;
    }
    const next = screen.rows[i + 1];
    rows.push({ y, h: rowH, first: newGroup, last: !next || next.section !== null, header });
    y += rowH;
  });
  return { rows, footerY: y + 22 * S };
}

const STATUS = (os: OsStyle) =>
  `<text x="${48 * S}" y="${34 * S}" font-family="Inter" font-weight="700" font-size="${16 * S}" fill="#000">9:41</text>` +
  // signal, wifi, battery
  `<g transform="translate(${SCREEN.w - 104 * S} ${22 * S})" fill="#000">${[0, 1, 2, 3].map((i) => `<rect x="${i * 5.5 * S}" y="${(9 - i * 2.5) * S}" width="${3.6 * S}" height="${(3 + i * 2.5) * S}" rx="${1 * S}"/>`).join("")}` +
  `<path d="M${30 * S} ${8 * S} q${8 * S} ${-7 * S} ${16 * S} 0" stroke="#000" stroke-width="${2.2 * S}" fill="none"/><path d="M${33 * S} ${11 * S} q${5 * S} ${-4 * S} ${10 * S} 0" stroke="#000" stroke-width="${2.2 * S}" fill="none"/><circle cx="${38 * S}" cy="${13.5 * S}" r="${1.8 * S}"/>` +
  `<rect x="${54 * S}" y="${2 * S}" width="${25 * S}" height="${12 * S}" rx="${3.5 * S}" fill="none" stroke="#000" stroke-opacity="0.4" stroke-width="${1.2 * S}"/><rect x="${56 * S}" y="${4 * S}" width="${19 * S}" height="${8 * S}" rx="${2 * S}"/></g>` +
  (os === "ios" ? `<rect x="${SCREEN.w / 2 - 62 * S}" y="${11 * S}" width="${124 * S}" height="${36 * S}" rx="${18 * S}" fill="#000"/>` : `<circle cx="${SCREEN.w / 2}" cy="${22 * S}" r="${9 * S}" fill="#000"/>`);

/** One screen, drawn in screen-local pixels (0..SCREEN.w x 0..SCREEN.h). */
export function screenSvg(screen: Screen, state: ScreenState, os: OsStyle = "ios"): string {
  const ios = os === "ios";
  const bg = ios ? "#F2F2F7" : "#F7F2FA";
  const accent = ios ? "#007AFF" : "#6750A4";
  const L = layout(screen, os);
  const parts: string[] = [`<rect width="${SCREEN.w}" height="${SCREEN.h}" fill="${bg}"/>`, STATUS(os)];
  if (ios) {
    if (screen.back) parts.push(`<text x="${16 * S}" y="${86 * S}" font-family="Inter" font-weight="500" font-size="${17 * S}" fill="${accent}">‹ ${esc(clip(screen.back, 16))}</text>`);
    parts.push(`<text x="${16 * S}" y="${142 * S}" font-family="Inter" font-weight="700" font-size="${32 * S}" fill="#000">${esc(clip(screen.title, 18))}</text>`);
  } else {
    parts.push(
      `${screen.back ? `<text x="${16 * S}" y="${100 * S}" font-family="Inter" font-weight="500" font-size="${22 * S}" fill="#1D1B20">←</text>` : ""}<text x="${(screen.back ? 52 : 16) * S}" y="${100 * S}" font-family="Inter" font-weight="500" font-size="${22 * S}" fill="#1D1B20">${esc(clip(screen.title, 20))}</text>`,
    );
  }
  const inset = ios ? 16 * S : 0;
  const w = SCREEN.w - inset * 2;
  screen.rows.forEach((r, i) => {
    const g = L.rows[i];
    if (g.y + g.h > SCREEN.h - 40 * S) return; // off the bottom of the phone
    if (g.header) parts.push(`<text x="${inset + (ios ? 16 : 16) * S}" y="${g.header.y}" font-family="Inter" font-weight="500" font-size="${13 * S}" fill="${ios ? "#6D6D72" : accent}">${esc(ios ? g.header.text.toUpperCase() : g.header.text)}</text>`);
    const r10 = ios ? 10 * S : 0;
    const pressed = state.pressed === i;
    const fill = pressed ? (ios ? "#D1D1D6" : "#E8DEF8") : ios ? "#FFFFFF" : bg;
    // Rounded only on the outer corners of each group.
    const topR = g.first ? r10 : 0;
    const botR = g.last ? r10 : 0;
    parts.push(
      `<path d="M${inset + topR} ${g.y} H${inset + w - topR} Q${inset + w} ${g.y} ${inset + w} ${g.y + topR} V${g.y + g.h - botR} Q${inset + w} ${g.y + g.h} ${inset + w - botR} ${g.y + g.h} H${inset + botR} Q${inset} ${g.y + g.h} ${inset} ${g.y + g.h - botR} V${g.y + topR} Q${inset} ${g.y} ${inset + topR} ${g.y}Z" fill="${fill}"/>`,
    );
    let tx = inset + 16 * S;
    if (r.icon_color) {
      const sz = 29 * S;
      parts.push(`<rect x="${tx}" y="${g.y + (g.h - sz) / 2}" width="${sz}" height="${sz}" rx="${7 * S}" fill="${esc(r.icon_color)}"/><text x="${tx + sz / 2}" y="${g.y + g.h / 2 + 6 * S}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="${15 * S}" fill="#FFF">${esc(r.label.slice(0, 1).toUpperCase())}</text>`);
      tx += sz + 14 * S;
    }
    parts.push(`<text x="${tx}" y="${g.y + g.h / 2 + 6 * S}" font-family="Inter" font-weight="500" font-size="${17 * S}" fill="#000">${esc(clip(r.label, r.value ? 20 : 28))}</text>`);
    let rx = inset + w - 16 * S;
    if (r.toggle !== null) {
      const on = state.pressed === i ? (r.toggle ? 1 - state.toggleT : state.toggleT) : r.toggle ? 1 : 0;
      const tw = 51 * S;
      const th = 31 * S;
      const x0 = rx - tw;
      const y0 = g.y + (g.h - th) / 2;
      const offC = ios ? "#E9E9EA" : "#E7E0EC";
      const onC = ios ? "#34C759" : accent;
      parts.push(`<rect x="${x0}" y="${y0}" width="${tw}" height="${th}" rx="${th / 2}" fill="${on > 0.5 ? onC : offC}"/><circle cx="${x0 + th / 2 + (tw - th) * on}" cy="${y0 + th / 2}" r="${th / 2 - 2 * S}" fill="#FFF"/>`);
      rx = x0 - 8 * S;
    } else if (r.chevron) {
      parts.push(`<path d="M${rx - 8 * S} ${g.y + g.h / 2 - 7 * S} l${7 * S} ${7 * S} l${-7 * S} ${7 * S}" stroke="#C4C4C7" stroke-width="${2.6 * S}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
      rx -= 18 * S;
    }
    if (r.value) parts.push(`<text x="${rx}" y="${g.y + g.h / 2 + 6 * S}" text-anchor="end" font-family="Inter" font-weight="500" font-size="${17 * S}" fill="#8E8E93">${esc(clip(r.value, 14))}</text>`);
    if (!g.last && ios) parts.push(`<rect x="${tx}" y="${g.y + g.h - 1}" width="${inset + w - tx}" height="1" fill="#C6C6C8"/>`);
  });
  if (screen.footer && L.footerY < SCREEN.h - 60 * S) {
    wrapCaption(screen.footer, 46, 3).forEach((line, k) =>
      parts.push(`<text x="${inset + 16 * S}" y="${L.footerY + 10 * S + k * 18 * S}" font-family="Inter" font-weight="500" font-size="${13 * S}" fill="#6D6D72">${esc(line)}</text>`),
    );
  }
  return parts.join("");
}

export interface FrameSpec {
  /** Screen on view, and (during a transition) the one sliding in. */
  screen: Screen;
  next?: Screen;
  /** 0..1 slide of `next` in from the right. */
  slide: number;
  state: ScreenState;
  finger?: { x: number; y: number; alpha: number; ripple: number };
  caption: string;
  stepLabel?: string;
  /** Brand colours for the backdrop. */
  bg: [string, string];
  os: OsStyle;
}

/** A whole 1080x1920 frame: backdrop, caption, phone, screen(s), finger. */
export function frameSvg(f: FrameSpec): string {
  const parts: string[] = [];
  parts.push(
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${f.bg[0]}"/><stop offset="1" stop-color="${f.bg[1]}"/></linearGradient>` +
      `<clipPath id="scr"><rect x="${SCREEN.x}" y="${SCREEN.y}" width="${SCREEN.w}" height="${SCREEN.h}" rx="${SCREEN.radius}"/></clipPath>` +
      `<filter id="ph" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="24" stdDeviation="30" flood-color="#000" flood-opacity="0.35"/></filter>` +
      `<filter id="tx"><feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000" flood-opacity="0.45"/></filter></defs>`,
    `<rect width="${FRAME.w}" height="${FRAME.h}" fill="url(#bg)"/>`,
  );
  // Caption band above the phone (inside Instagram's safe area).
  if (f.stepLabel) parts.push(`<text x="${FRAME.w / 2}" y="250" text-anchor="middle" font-family="Inter" font-weight="700" font-size="34" fill="#FFFFFF" fill-opacity="0.8" filter="url(#tx)">${esc(f.stepLabel.toUpperCase())}</text>`);
  const cap = wrapCaption(f.caption, 26);
  cap.forEach((line, i) => parts.push(`<text x="${FRAME.w / 2}" y="${318 + i * 64 - (cap.length - 1) * 20}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="56" fill="#FFFFFF" filter="url(#tx)">${esc(line)}</text>`));
  // Phone body.
  parts.push(`<rect x="${PHONE.x}" y="${PHONE.y}" width="${PHONE.w}" height="${PHONE.h}" rx="${PHONE.radius}" fill="#0B0B0D" filter="url(#ph)"/>`);
  const cur = `<g transform="translate(${SCREEN.x - SCREEN.w * f.slide * 0.3} ${SCREEN.y})">${screenSvg(f.screen, f.state, f.os)}</g>`;
  const nxt = f.next && f.slide > 0 ? `<g transform="translate(${SCREEN.x + SCREEN.w * (1 - f.slide)} ${SCREEN.y})">${screenSvg(f.next, { pressed: -1, toggleT: 0 }, f.os)}</g>` : "";
  parts.push(`<g clip-path="url(#scr)">${cur}${nxt}</g>`);
  if (f.finger && f.finger.alpha > 0) {
    const { x, y, alpha, ripple } = f.finger;
    if (ripple > 0) parts.push(`<circle cx="${x}" cy="${y}" r="${36 + ripple * 70}" fill="#FFFFFF" fill-opacity="${(0.45 * (1 - ripple)).toFixed(3)}"/>`);
    parts.push(`<circle cx="${x}" cy="${y}" r="38" fill="#FFFFFF" fill-opacity="${(0.55 * alpha).toFixed(3)}" stroke="#000" stroke-opacity="${(0.25 * alpha).toFixed(3)}" stroke-width="4"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME.w}" height="${FRAME.h}" viewBox="0 0 ${FRAME.w} ${FRAME.h}">${parts.join("")}</svg>`;
}

function wrapCaption(text: string, perLine: number, maxLines = 2): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > perLine && line) {
      lines.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}
