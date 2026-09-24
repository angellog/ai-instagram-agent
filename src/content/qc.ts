import sharp from "sharp";
import { z } from "zod";
import { llm } from "../llm/llm.js";
import type { Persona } from "../persona/schema.js";
import { MAX_CAPTION, MAX_HASHTAGS } from "./caption.js";
import { SLIDE_H, SLIDE_W } from "../render/compose.js";

/**
 * Quality-control worker (brief §7, §9). Structural checks are deterministic;
 * the visual check asks a vision model to look at each generated photo the way
 * a picky editor would, before anything reaches the safety layer.
 */

export interface StructuralInput {
  mediaType: "IMAGE" | "CAROUSEL";
  caption: string;
  slides: Array<{ position: number; publicUrl: string | null; width: number | null; height: number | null; bytes?: number; overlayText: string }>;
}

export function structuralQc(i: StructuralInput, p: Persona): string[] {
  const problems: string[] = [];
  const n = i.slides.length;
  if (i.mediaType === "CAROUSEL") {
    if (n < Math.max(2, p.carousel.min_slides) || n > Math.min(10, p.carousel.max_slides)) {
      problems.push(`carousel has ${n} slides; allowed ${p.carousel.min_slides}-${Math.min(10, p.carousel.max_slides)}`);
    }
  } else if (n !== 1) problems.push(`single image post has ${n} assets`);
  for (const s of i.slides) {
    if (!s.publicUrl) problems.push(`slide ${s.position + 1} has no public URL`);
    if (s.width !== SLIDE_W || s.height !== SLIDE_H) problems.push(`slide ${s.position + 1} is ${s.width}x${s.height}, expected ${SLIDE_W}x${SLIDE_H}`);
    if (s.bytes !== undefined && s.bytes > 8 * 1024 * 1024) problems.push(`slide ${s.position + 1} exceeds 8 MB`);
    if (s.overlayText.length > 400) problems.push(`slide ${s.position + 1} overlay text too long`);
  }
  if (!i.caption.trim()) problems.push("empty caption");
  if (i.caption.length > MAX_CAPTION) problems.push(`caption ${i.caption.length} chars > ${MAX_CAPTION}`);
  const tags = i.caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (tags.length > MAX_HASHTAGS) problems.push(`${tags.length} hashtags > ${MAX_HASHTAGS}`);
  for (const bad of p.communication_style.avoid_phrases) {
    if (bad && i.caption.toLowerCase().includes(bad.toLowerCase())) problems.push(`caption uses avoided phrase "${bad}"`);
  }
  return problems;
}

export const visionQcSchema = z.object({
  acceptable: z.boolean(),
  character_consistent: z.enum(["yes", "no", "not_applicable"]),
  anatomy_issues: z.boolean().describe("extra/missing fingers or limbs, warped faces, broken feet"),
  garbled_text_or_logos: z.boolean().describe("unreadable or malformed text, fake watermarks"),
  extra_people: z.boolean(),
  matches_brief: z.boolean(),
  issues: z.array(z.string()).max(5),
});
export type VisionQc = z.infer<typeof visionQcSchema>;

/**
 * Vision QC for one raw generated image (before text overlay). The reference
 * image is sent alongside so identity drift can be judged, not guessed.
 */
export async function visionQc(o: {
  image: Buffer;
  reference?: Buffer;
  shotBrief: string;
  includeCharacter: boolean;
  ref: { type: string; id: string };
}): Promise<VisionQc> {
  const small = async (b: Buffer) => (await sharp(b).resize(768, 960, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer()).toString("base64");
  const images = [{ data: await small(o.image), mediaType: "image/jpeg" as const }];
  if (o.reference && o.includeCharacter) images.push({ data: await small(o.reference), mediaType: "image/jpeg" as const });
  return llm().structured(visionQcSchema, {
    operation: "image.validate",
    tier: "fast",
    maxTokens: 400,
    ref: o.ref,
    images,
    system:
      "You are a strict photo editor reviewing AI-generated images for a realistic lifestyle Instagram account. Judge only what you see. Return JSON.",
    prompt: [
      `Image 1 is the candidate.${images.length > 1 ? " Image 2 is the character reference." : ""}`,
      `Brief: ${o.shotBrief}`,
      o.includeCharacter
        ? "It should show exactly one woman who is clearly the same person as the reference (face, skin tone, build)."
        : "It should show no people (hands or feet are fine).",
      "Set acceptable=false for any anatomy problem, garbled text/logos, an extra person, identity mismatch, or an image that clearly misses the brief. Minor stylistic differences are fine.",
    ].join("\n"),
  });
}

export function visionVerdict(v: VisionQc, includeCharacter: boolean): { ok: boolean; problems: string[] } {
  const problems = [...v.issues];
  if (v.anatomy_issues) problems.push("anatomy issues");
  if (v.garbled_text_or_logos) problems.push("garbled text or logos");
  if (v.extra_people && includeCharacter) problems.push("extra people");
  if (includeCharacter && v.character_consistent === "no") problems.push("character does not match reference");
  const ok = v.acceptable && !v.anatomy_issues && !v.garbled_text_or_logos && !(includeCharacter && v.character_consistent === "no");
  return { ok, problems: [...new Set(problems)] };
}
