import { localeLines } from "./locale.js";
import type { Persona } from "../persona/schema.js";
import type { Idea } from "./director.js";
import type { VisualState } from "./history.js";

type Slide = Idea["slides"][number];

const COMPOSITION_TEXT: Record<string, string> = {
  close_up: "close-up portrait framing, head and shoulders",
  medium: "medium shot from the waist up",
  full_body: "full-body shot, head to toe",
  detail: "tight detail shot (hands, objects, textures), shallow depth of field",
  flat_lay: "top-down flat lay on a clean surface",
  environment: "wide environmental shot, subject small in the frame, the place tells the story",
  over_shoulder: "over-the-shoulder point of view",
  mirror: "casual mirror shot holding a phone",
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
export function slidePrompt(p: Persona, idea: { format: Idea["format"] | "story" }, slide: Slide, state: VisualState, index: number, total: number): string {
  const story = idea.format === "story";
  const ch = p.visual.character;
  const ph = p.visual.photography;
  const loc = state.location_id ? p.visual.locations.find((l) => l.id === state.location_id) : undefined;
  const lines: string[] = [];

  if (slide.include_character) {
    lines.push(
      `Photograph of the same person shown in the identity reference image(s): keep the face, skin tone, hair, body and proportions identical to the reference.`,
      `Use the reference ONLY for who the person is. Ignore the clothing, background and lighting in the reference photo; dress them exactly as described below.`,
      `Appearance: ${ch.appearance.trim()}. Hair: ${ch.hairstyle}. Skin tone: ${ch.skin_tone}. Build: ${ch.body_type}.`,
      `Wearing ${state.outfit ?? ch.recurring_clothing_preferences[0]}${legacyShoes(state) ? `, with ${legacyShoes(state)} on their feet` : ""}.${
        ch.signature_accessories.length ? ` Accessories: ${ch.signature_accessories.join(", ")}.` : ""
      }`,
    );
    if (ch.face_policy === "faceless") lines.push("The face is not visible: framed from the chin down or turned away.");
  } else {
    lines.push(
      `The creator is not in frame except possibly their hands${item(state) ? `; ${item(state)} sits naturally in the scene` : ""}.`,
      "Same shoot and styling as the rest of the series.",
    );
  }

  if (slide.include_character && state.featured_item) lines.push(`Somewhere natural in the scene (not posed with, not the subject, no visible logo text): ${state.featured_item}.`);
  lines.push(`Shot: ${slide.shot.trim()}`);
  lines.push(`Framing: ${COMPOSITION_TEXT[slide.composition] ?? slide.composition}.`);
  if (loc) lines.push(`Location: ${loc.description}.`);
  lines.push(...localeLines(p, loc, slide.include_character));
  lines.push(`Light: ${LIGHT_TEXT[state.time_of_day ?? "morning"] ?? state.time_of_day}. ${ph.lighting}.`);
  lines.push(
    story
      ? `Style: ${ph.style}; ${ph.camera_feel}; ${ph.realism}. Vertical 9:16 Instagram Story photo filling the whole frame, shot in the moment on a phone. Keep faces and the key detail in the middle; nothing important in the top 14% or bottom 20% (Instagram covers those).`
      : `Style: ${ph.style}; ${ph.camera_feel}; ${ph.realism}. Vertical 4:5 Instagram photo.`,
  );
  if (total > 1) lines.push(`This is photo ${index + 1} of ${total} from one continuous shoot: same outfit, same place, same light as the others.`);
  if (story && !slide.include_character && slide.overlay_kind !== "none") lines.push("Leave calm, uncluttered space in the lower-middle of the frame for a short line of text.");
  else if (p.carousel.text_overlays && !slide.include_character) lines.push("Leave calm, uncluttered space in the lower third of the frame.");
  if (ph.negative) lines.push(`Avoid: ${ph.negative.trim()}`);
  return lines.join("\n");
}

/** The brand item in this shot (new featured_item, or a legacy pair of shoes). */
function item(state: VisualState): string | undefined {
  return state.featured_item || state.sneakers || undefined;
}

/** Older posts stored the pair on foot; keep rendering them the same way. */
function legacyShoes(state: VisualState): string | undefined {
  return state.featured_item ? undefined : state.sneakers || undefined;
}
