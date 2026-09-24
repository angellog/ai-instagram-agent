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
