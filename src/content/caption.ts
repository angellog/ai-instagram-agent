import type { Persona } from "../persona/schema.js";

export const MAX_CAPTION = 2200;
export const MAX_HASHTAGS = 30;

export function normalizeHashtag(tag: string): string | undefined {
  const t = tag.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
  return t ? `#${t}` : undefined;
}

/**
 * Final caption = body + hashtag block, within Instagram's limits (2,200
 * characters, 30 hashtags; same rule as ig-poster's fitCaption).
 */
export function fitCaption(body: string, hashtags: string[], p: Pick<Persona, "hashtags">): string {
  const inBody = body.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  const tags: string[] = [];
  const seen = new Set(inBody.map((t) => t.toLowerCase()));
  for (const raw of [...p.hashtags.always, ...hashtags]) {
    const t = normalizeHashtag(raw);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    tags.push(t);
  }
  const budget = Math.max(0, Math.min(MAX_HASHTAGS - inBody.length, p.hashtags.always.length + p.hashtags.max));
  const block = tags.slice(0, budget).join(" ");
  const suffix = block ? `\n\n${block}` : "";
  let text = body.trim();
  if (text.length + suffix.length > MAX_CAPTION) text = `${text.slice(0, MAX_CAPTION - suffix.length - 1).trimEnd()}…`;
  return `${text}${suffix}`;
}

// ---------------------------------------------------------------- caption quality

/** Body limits (hashtags excluded). Real creators caption in a line or two. */
export const CAPTION_LIMITS = { short: 150, educational: 320 } as const;

/** Tics the model falls back on; banned so the feed doesn't sound like one template. */
export const OVERUSED: Array<[RegExp, string]> = [
  [/\brotation check\b/i, "rotation check"],
  [/\bdoing (its|that|their|her|his) ([\w-]+ )?thing\b/i, "doing its thing"],
  [/\bowes? me\b/i, "like it owes me"],
  [/\bwhole mood\b/i, "whole mood"],
  [/\bnot mad about it\b/i, "not mad about it"],
  [/\bin the best way\b/i, "in the best way"],
  [/\bearning (their|its) keep\b/i, "earning their keep"],
  [/^(some|on) (days|nights|mornings|afternoons|evenings)\b/i, "\"Some days/nights…\" opening"],
  [/^okay,? (so )?(first|quick)\b/i, "\"Okay, first…\" opening"],
];

const stripTags = (s: string) => s.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " ").replace(/[ \t]+/g, " ").trim();

export function sentences(body: string): string[] {
  return stripTags(body)
    .split(/\n+|(?<=[^\d\s][.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const opening = (s: string) =>
  stripTags(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");

/**
 * Why a caption isn't good enough, as feedback the director can act on.
 * Empty = fine. `recent` are the latest captions, newest first.
 */
export function captionProblems(body: string, o: { educational: boolean; recent: string[] }): string[] {
  const out: string[] = [];
  const text = stripTags(body);
  const limit = o.educational ? CAPTION_LIMITS.educational : CAPTION_LIMITS.short;
  if ([...text].length > limit) out.push(`too long (${[...text].length} characters; keep it under ${limit})`);
  const n = sentences(body).length;
  if (!o.educational && n > 2) out.push(`${n} sentences; use 1-2 short ones`);
  if (o.educational && n > 5) out.push(`${n} lines; use a hook plus at most 3 short tips`);
  for (const [re, label] of OVERUSED) if (re.test(text)) out.push(`overused phrase: ${label}`);
  const open = opening(text);
  if (open.split(" ").length >= 2 && o.recent.some((r) => opening(r) === open)) out.push(`same opening as a recent caption ("${open}…")`);
  if (/\?\s*$/.test(text) && o.recent.slice(0, 3).filter((r) => /\?\s*$/.test(stripTags(r))).length >= 2) out.push("the last posts all ended with a question; end with a thought this time");
  return out;
}

/**
 * Readable layout: one sentence per line, no stray whitespace, and (last
 * resort) trimmed at a sentence boundary so it never ends mid-thought.
 */
export function tidyCaption(body: string, educational: boolean): string {
  const limit = educational ? CAPTION_LIMITS.educational : CAPTION_LIMITS.short;
  const lines = sentences(body);
  const kept: string[] = [];
  for (const l of lines) {
    const next = [...kept, l].join("\n");
    if ([...next].length > limit && kept.length) break;
    kept.push(l);
    if (!educational && kept.length === 2) break;
  }
  let out = kept.join("\n");
  if ([...out].length > limit) out = `${[...out].slice(0, limit - 1).join("").replace(/\s+\S*$/, "")}…`;
  return out;
}
