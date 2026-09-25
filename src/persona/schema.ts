import { z } from "zod";

const slot = z.enum(["morning", "late_morning", "lunch", "afternoon", "evening", "night"]);
export type Slot = z.infer<typeof slot>;
export const SLOTS: Slot[] = ["morning", "late_morning", "lunch", "afternoon", "evening", "night"];

export const personaSchema = z.object({
  identity: z.object({
    name: z.string().min(1),
    handle: z.string().optional(),
    age: z.union([z.number(), z.string()]).optional(),
    location: z.string(),
    timezone: z.string().default("UTC"),
    occupation: z.string(),
    bio: z.string(),
    // Disclosure is part of identity, not an afterthought: the persona is an AI
    // and says so whenever sincerely asked.
    ai_disclosure: z.string(),
    affiliation: z.string().optional(),
  }),
  interests: z.array(z.string()).min(1),
  personality: z.array(z.string()).min(1),
  communication_style: z.object({
    voice: z.string(),
    emoji_use: z.enum(["none", "light", "moderate", "heavy"]).default("light"),
    max_reply_chars: z.number().int().positive().default(280),
    languages: z.array(z.string()).default(["English"]),
    signature_phrases: z.array(z.string()).default([]),
    avoid_phrases: z.array(z.string()).default([]),
  }),
  content_style: z.array(z.string()).min(1),
  content_rules: z.array(z.string()).default([]),
  behavior: z.array(z.string()).min(1),
  boundaries: z.array(z.string()).default([]),
  visual: z.object({
    character: z.object({
      appearance: z.string(),
      hairstyle: z.string(),
      body_type: z.string(),
      skin_tone: z.string(),
      recurring_clothing_preferences: z.array(z.string()).min(1),
      // The full closet the wardrobe rotation draws from (staples above are included).
      wardrobe: z.array(z.string()).default([]),
      signature_accessories: z.array(z.string()).default([]),
      // Public URLs of approved reference images. Sent to the image model on
      // every generation to hold facial and body identity.
      reference_images: z.array(z.string().url()).default([]),
      face_policy: z.enum(["visible", "faceless"]).default("visible"),
    }),
    photography: z.object({
      style: z.string(),
      camera_feel: z.string(),
      lighting: z.string(),
      realism: z.string(),
      negative: z.string().default(""),
    }),
    locations: z
      .array(z.object({ id: z.string(), description: z.string(), slots: z.array(slot).default([]) }))
      .min(1),
  }),
  daily_life: z.object({
    activities: z
      .array(
        z.object({
          slot,
          activity: z.string(),
          locations: z.array(z.string()).default([]),
          postable: z.boolean().default(true),
          weight: z.number().positive().default(1),
          weekdays_only: z.boolean().default(false),
        }),
      )
      .min(3),
    // How many activities to sample per day.
    activities_per_day: z.number().int().min(2).max(12).default(6),
  }),
  carousel: z.object({
    structures: z.array(z.string()).min(1),
    min_slides: z.number().int().min(2).max(20).default(4),
    // Real creators post plain phone photos. Text on images (and any branding)
    // is opt-in, and even then never on photos of the persona herself.
    text_overlays: z.boolean().default(false),
    max_slides: z.number().int().min(2).max(20).default(6),
    brand_colors: z.object({
      primary: z.string().default("#FF5A1F"),
      text: z.string().default("#FFFFFF"),
      shadow: z.string().default("#000000"),
    }),
  }),
  hashtags: z.object({
    always: z.array(z.string()).default([]),
    pool: z.array(z.string()).default([]),
    max: z.number().int().min(0).max(30).default(5),
  }),
});

export type Persona = z.infer<typeof personaSchema>;
