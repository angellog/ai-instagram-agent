import type { Persona } from "../persona/schema.js";
import type { Idea } from "./director.js";
import type { VisualState } from "./history.js";

type Slide = Idea["slides"][number];

const COMPOSITION_TEXT: Record<string, string> = {
  close_up: "close-up portrait framing, head and shoulders",
  medium: "medium shot from the waist up",
  full_body: "full-body shot, head to sneakers, sneakers clearly visible",
  detail: "tight detail shot (sneakers, hands, textures), shallow depth of field",
  flat_lay: "top-down flat lay on a clean surface",
  environment: "wide environmental shot, subject small in the frame, the place tells the story",
  over_shoulder: "over-the-shoulder point of view",
  mirror: "mirror fit-check shot holding a phone",
};

const LIGHT_TEXT: Record<string, string> = {
  sunrise: "soft low sunrise light, cool shadows, gentle warm highlights",
  morning: "clean bright morning daylight",
  midday: "bright midday light with crisp shadows",
  afternoon: "warm afternoon daylight",
  golden_hour: "golden hour sunlight, long warm shadows",
  dusk: "blue-hour dusk light with warm practical lights",
  night: "night scene lit by warm practical lamps and city lights",
};

/**
 * Visual Director (brief §8): turns one slide of an idea into an image prompt
 * that holds character identity, outfit, environment, light and camera style
 * constant across the series and consistent with the persona profile.
 */
export function slidePrompt(p: Persona, idea: Pick<Idea, "format">, slide: Slide, state: VisualState, index: number, total: number): string {
  const ch = p.visual.character;
  const ph = p.visual.photography;
  const loc = state.location_id ? p.visual.locations.find((l) => l.id === state.location_id) : undefined;
  const lines: string[] = [];

  if (slide.include_character) {
    lines.push(
      `Photograph of the same young woman shown in the reference image${ch.reference_images.length > 1 ? "s" : ""}: keep her face, skin tone, body and proportions identical to the reference.`,
      `She is ${ch.appearance.trim()}. Hair: ${ch.hairstyle}. Skin tone: ${ch.skin_tone}. Build: ${ch.body_type}.`,
      `Wearing ${state.outfit ?? ch.recurring_clothing_preferences[0]}${state.sneakers ? `, with ${state.sneakers} on her feet` : ""}.${
        ch.signature_accessories.length ? ` Accessories: ${ch.signature_accessories.join(", ")}.` : ""
      }`,
    );
    if (ch.face_policy === "faceless") lines.push("Her face is not visible: framed from the chin down or turned away.");
  } else {
    lines.push(
      `No people in frame${state.sneakers ? ` except possibly hands or feet; the focus is ${state.sneakers}` : ""}.`,
      "Same shoot and styling as the rest of the series.",
    );
  }

  lines.push(`Shot: ${slide.shot.trim()}`);
  lines.push(`Framing: ${COMPOSITION_TEXT[slide.composition] ?? slide.composition}.`);
  if (loc) lines.push(`Location: ${loc.description}.`);
  lines.push(`Light: ${LIGHT_TEXT[state.time_of_day ?? "morning"] ?? state.time_of_day}. ${ph.lighting}.`);
  lines.push(`Style: ${ph.style}; ${ph.camera_feel}; ${ph.realism}. Vertical 4:5 Instagram photo.`);
  if (total > 1) lines.push(`This is photo ${index + 1} of ${total} from one continuous shoot: same outfit, same place, same light as the others.`);
  lines.push("Leave calm, uncluttered space in the lower third of the frame.");
  if (ph.negative) lines.push(`Avoid: ${ph.negative.trim()}`);
  return lines.join("\n");
}

/**
 * Reference images for a slide: the persona's identity references for
 * character shots, plus the already generated cover for later slides so the
 * environment and outfit carry over (the approach proven in Kickshot).
 */
export function slideReferences(p: Persona, slide: Slide, coverUrl?: string): string[] {
  const refs = slide.include_character ? [...p.visual.character.reference_images] : [];
  if (coverUrl) refs.push(coverUrl);
  return refs;
}
