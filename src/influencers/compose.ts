import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { env } from "../config/env.js";
import { PermanentError } from "../lib/errors.js";
import { llm } from "../llm/llm.js";
import { parsePersona } from "../persona/loader.js";

/**
 * Hatch step 1: turn a short operator brief into a complete, validated persona
 * YAML. The model gets the reference persona as a structural template (every
 * key, the tone of each field) and must return YAML only; invalid output gets
 * one repair round with the validator's exact error.
 */

export interface HatchBrief {
  name: string;
  niche: string;
  city: string;
  timezone?: string;
  age?: string;
  vibe?: string;
  audience?: string;
  appearance?: string;
  brand?: string;
  language?: string;
}

function template(): string {
  try {
    return readFileSync(resolve(env().PERSONA_PATH), "utf8");
  } catch {
    return "";
  }
}

export function briefText(b: HatchBrief): string {
  return [
    `Name: ${b.name}`,
    `Niche / what they post about: ${b.niche}`,
    `Home city: ${b.city}${b.timezone ? ` (timezone ${b.timezone})` : ""}`,
    b.age ? `Age: ${b.age}` : "",
    b.vibe ? `Personality / vibe: ${b.vibe}` : "",
    b.audience ? `Audience to build: ${b.audience}` : "",
    b.appearance ? `Look: ${b.appearance}` : "",
    b.brand ? `Affiliated brand / business: ${b.brand}` : "Affiliation: independent creator",
    b.language ? `Languages: ${b.language}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const SYSTEM = `You design believable AI Instagram creator personas. Output ONLY a YAML document (no code fences, no commentary)
with exactly the same top-level keys and nesting as the TEMPLATE. Rules:
- Keep it specific and lived-in: real neighbourhoods, habits, routines; 6-12 daily activities across early_morning/morning/midday/afternoon/evening/night slots with location ids that exist under visual.locations.
- identity.ai_disclosure must plainly say this is an AI creator with AI-generated photos.
- visual.character.reference_images must be an empty list [] (faces are chosen in the next step).
- visual.character.appearance must describe a consistent, photographable look (face, skin tone, hair, build) without naming a real person.
- carousel.text_overlays: false. Use the IANA timezone of the home city.
- No hashtags about AI. No medical, political or financial advice in behaviour.`;

export async function composePersona(b: HatchBrief): Promise<{ yaml: string; name: string }> {
  if (!b.name.trim() || !b.niche.trim() || !b.city.trim()) throw new PermanentError("name, niche and city are required");
  const tpl = template();
  const prompt = `TEMPLATE (structure and level of detail to match; the content is a different person):\n${tpl}\n\nBRIEF:\n${briefText(b)}\n\nWrite the new persona YAML now.`;
  let text = await llm().generate({ operation: "persona.compose", tier: "smart", maxTokens: 6000, system: SYSTEM, prompt });
  for (let attempt = 0; attempt < 2; attempt++) {
    const yaml = clean(text);
    try {
      const p = parsePersona(yaml);
      p.visual.character.reference_images = [];
      return { yaml: stringify(p, { lineWidth: 0 }), name: p.identity.name };
    } catch (e) {
      if (attempt === 1) throw new PermanentError(`the persona draft was invalid twice: ${(e as Error).message}`);
      text = await llm().generate({
        operation: "persona.compose.repair",
        tier: "smart",
        maxTokens: 6000,
        system: SYSTEM,
        prompt: [
          { role: "user", content: prompt },
          { role: "assistant", content: yaml },
          { role: "user", content: `That YAML failed validation: ${(e as Error).message}\nReturn the corrected full YAML only.` },
        ],
      });
    }
  }
  throw new PermanentError("unreachable");
}

function clean(t: string): string {
  return t.replace(/^```(?:ya?ml)?\s*/i, "").replace(/```\s*$/, "").trim();
}

/** Face-candidate prompts for the soul step: same person, three framings. */
export function faceCandidatePrompts(appearance: string, city: string): string[] {
  const who = appearance.trim().replace(/\s+/g, " ");
  return [
    `Candid iPhone portrait of a person: ${who}. Warm genuine smile, looking at the camera, head and shoulders, soft daylight in ${city}, realistic skin texture, no makeup filter, no text.`,
    `Natural photo of a person: ${who}. Laughing, three-quarter view, outdoor café in ${city}, golden-hour light, realistic, shot on a phone, no text.`,
    `Friendly selfie-style photo of a person: ${who}. Relaxed smile, plain wall background, even window light, sharp focus on the eyes, realistic, no text.`,
  ];
}
