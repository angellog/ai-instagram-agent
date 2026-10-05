import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { PermanentError } from "../lib/errors.js";
import { llm } from "../llm/llm.js";
import { parsePersona } from "../persona/loader.js";
import { SLOTS } from "../persona/schema.js";

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
  /** Faith and occasions to dress for (church, Jumu'ah, Eid, kwanjula…). Optional. */
  faith?: string;
  /** Asked, never inferred from the name. */
  pronouns?: "she" | "he" | "they";
}

/** The neutral structural template (never another influencer's persona: it would bleed into every hatch). */
export const TEMPLATE_PATH = "config/persona.template.yaml";

export function template(): string {
  try {
    return readFileSync(resolve(TEMPLATE_PATH), "utf8");
  } catch {
    return "";
  }
}

export function briefText(b: HatchBrief): string {
  return [
    `Name: ${b.name}`,
    `Niche / what they post about: ${b.niche}`,
    `Home city: ${b.city}${b.timezone ? ` (timezone ${b.timezone})` : ""}`,
    b.pronouns ? `Pronouns: ${b.pronouns}` : "",
    b.age ? `Age: ${b.age}` : "",
    b.vibe ? `Personality / vibe: ${b.vibe}` : "",
    b.audience ? `Audience to build: ${b.audience}` : "",
    b.appearance ? `Look: ${b.appearance}` : "",
    b.brand ? `Affiliated brand / business: ${b.brand}` : "Affiliation: independent creator",
    b.language ? `Languages: ${b.language}` : "",
    b.faith ? `Faith and occasions to dress for: ${b.faith}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const WEEKDAYS = "monday, tuesday, wednesday, thursday, friday, saturday, sunday";

const SYSTEM = `You design believable AI Instagram creator personas. Output ONLY a YAML document (no code fences, no commentary)
with exactly the same top-level keys and nesting as the TEMPLATE. Rules:
- Keep it specific and lived-in: real neighbourhoods, habits, routines; 6-12 daily activities with location ids that exist under visual.locations.
- Time slots (daily_life.activities[].slot and visual.locations[].slots) must be EXACTLY one of: ${SLOTS.join(", ")}. Weekday names are lowercase: ${WEEKDAYS}.
- identity.ai_disclosure must plainly say this is an AI creator with AI-generated photos.
- identity.pronouns: exactly the brief's pronouns (she, he or they); "they" if the brief gives none. Never infer them from the name.
- brand: only if the brief names a brand. name and category from the brief; 4-6 products from that category described generically (no invented product names or prices); 5-8 natural_moments from THIS person's own daily life where the category belongs without being the subject (a breakfast stays about breakfast); 2-4 curiosity_hooks (questions followers would ask); mention_rate 0.2. Independent creators: omit brand entirely.
- Everything else is about this person's own life and niche. Nothing from any other creator: no sneakers, shops or places unless the brief says so.
- visual.character.reference_images must be an empty list [] (faces are chosen in the next step).
- visual.character.wardrobe: 6-10 complete signature outfits. visual.character.closet: SEPARATES that remix like a real closet (any top works with any bottom): 10-12 tops, 7-9 bottoms, 3-4 layers, 4-5 one_pieces (dresses/jumpsuits; skip if not their style), 3-4 activewear sets. Specific colours, fabrics and cuts, mostly versatile neutrals plus a few colour pops; no brand logos.
- visual.character.closet.occasions: 2-4 occasion outfits that fit THIS person's faith and culture from the brief (e.g. Sunday church dress with days [sunday] and keywords [church]; Jumu'ah kanzu/abaya with days [friday]; Eid outfit with keywords [eid]; a kwanjula gomesi or kanzu; wedding guest). Respectful and modest where the occasion calls for it. If the brief gives no faith, include only cultural or wedding occasions.
- daily_life: include 4-6 weekend activities using weekends_only: true or days: [saturday]/[sunday] (outings, markets, brunch, worship if it fits the faith, resets).
- weekend_ideas: 5-6 weekend post ideas in this creator's voice, including a "remix" idea (one piece styled several ways).
- trends: region = the ISO country code of the home city, language "en", max_items 8. queries as { query, label } objects (add " when:7d" for slower topics): what's trending on TikTok in the country (label "TikTok <Country>"), the Instagram scene in the city (label "Instagram <City>"), what's trending on X in the country (label "X <Country>"), 1-2 niche queries, and sports leagues they follow if their interests include sport. feeds as { url, label }: 1-3 well-known international feeds for the niche only if you are sure of their URLs. avoid: [] plus anything the brief says to avoid.
- visual.character.appearance must describe a consistent, photographable look (face, skin tone, hair, build) without naming a real person.
- carousel.text_overlays: false. Use the IANA timezone of the home city.
- No hashtags about AI. No medical, political or financial advice in behaviour.`;

/**
 * A whole persona is ~4-5k output tokens: well past the 90s default per-call
 * limit on the smart model. It runs as a background job, so give it room.
 */
export const COMPOSE_TIMEOUT_MS = 5 * 60_000;
const COMPOSE_MAX_TOKENS = 12_000;

/** The brief's required fields, checked before any work is queued. */
export function assertBrief(b: HatchBrief): void {
  if (!b.name.trim() || !b.niche.trim() || !b.city.trim()) throw new PermanentError("name, niche and city are required");
}

export async function composePersona(b: HatchBrief): Promise<{ yaml: string; name: string }> {
  assertBrief(b);
  const tpl = template();
  const prompt = `TEMPLATE (structure and level of detail to match; the content is a different person):\n${tpl}\n\nBRIEF:\n${briefText(b)}\n\nWrite the new persona YAML now.`;
  let text = await llm().generate({ operation: "persona.compose", tier: "smart", maxTokens: COMPOSE_MAX_TOKENS, timeoutMs: COMPOSE_TIMEOUT_MS, system: SYSTEM, prompt });
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
        maxTokens: COMPOSE_MAX_TOKENS,
        timeoutMs: COMPOSE_TIMEOUT_MS,
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
