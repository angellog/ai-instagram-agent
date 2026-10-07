import { z } from "zod";

const slot = z.enum(["morning", "late_morning", "lunch", "afternoon", "evening", "night"]);
export type Slot = z.infer<typeof slot>;
export const SLOTS: Slot[] = ["morning", "late_morning", "lunch", "afternoon", "evening", "night"];

/** Short-form formats built to get replies (v1.0.29). Playful only: never romantic or sexual. */
export const SHORT_FORMATS = ["silly_talk", "funny_question", "football_banter", "this_or_that", "hot_take"] as const;
export type ShortFormat = (typeof SHORT_FORMATS)[number];

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
    // Used in every prompt about this person ("she is in the photo"). Never inferred from the name.
    pronouns: z.enum(["she", "he", "they"]).optional(),
  }),
  // How this influencer drives interest in the brand it works with, without selling:
  // everyday UGC where the brand's world shows up naturally, so followers ask about it.
  brand: z
    .object({
      name: z.string().min(1),
      category: z.string().min(1).describe("What the brand sells, in a few words (e.g. 'skincare and cosmetics')"),
      // Products or product types that can appear naturally in a shot (generic descriptions, no invented SKUs).
      products: z.array(z.string()).default([]),
      // Everyday moments where the category belongs without being the subject (e.g. 'morning sink routine').
      natural_moments: z.array(z.string()).default([]),
      // What followers should end up asking ("what's that serum?", "where's that phone case from?").
      curiosity_hooks: z.array(z.string()).default([]),
      // At most this share of posts may NAME the brand; the rest only show its world.
      mention_rate: z.number().min(0).max(1).default(0.2),
    })
    .optional(),
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
      // Separates the rotation mixes and matches like a real person: any top with
      // any bottom (optionally a layer) is a new outfit made from pieces they own.
      closet: z
        .object({
          tops: z.array(z.string()).default([]),
          bottoms: z.array(z.string()).default([]),
          layers: z.array(z.string()).default([]),
          one_pieces: z.array(z.string()).default([]),
          activewear: z.array(z.string()).default([]),
          // Occasion wear, per this influencer's life and faith (church, Jumu'ah, Eid, weddings…).
          occasions: z
            .array(
              z.object({
                occasion: z.string(),
                outfit: z.string(),
                keywords: z.array(z.string()).default([]),
                days: z.array(z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])).default([]),
              }),
            )
            .default([]),
        })
        .default({ tops: [], bottoms: [], layers: [], one_pieces: [], activewear: [], occasions: [] }),
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
      .array(
        z.object({
          id: z.string(),
          description: z.string(),
          slots: z.array(slot).default([]),
          // How this real place looks (floors, walls, furniture, signage, what's outside), so images match the city.
          look: z.string().optional(),
        }),
      )
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
          weekends_only: z.boolean().default(false),
          // Only on these weekdays (e.g. church on sunday, market on saturday). Empty = any day.
          days: z.array(z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])).default([]),
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
      primary: z.string().default("#111111"),
      text: z.string().default("#FFFFFF"),
      shadow: z.string().default("#000000"),
    }),
  }),
  // Post ideas that only make sense on a Saturday or Sunday.
  weekend_ideas: z.array(z.string()).default([]),
  // A life that moves forward, so the feed reads like a timeline and not a stock
  // library: storylines that run for weeks, small specific moments, and the
  // recurring people around them (named in words; never faces in photos).
  life: z
    .object({
      arcs: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
            title: z.string().min(1),
            // What's going on, in a sentence or two.
            story: z.string().min(1),
            // Small steps in order; one post (or story) moves it one beat.
            beats: z.array(z.string().min(1)).min(2),
            // At most one beat every this many days, so a storyline breathes.
            every_days: z.number().int().min(1).max(30).default(4),
          }),
        )
        .default([]),
      // Specific, local, sensory, slightly imperfect moments a real person would post about.
      moments: z.array(z.string().min(1)).default([]),
      circle: z.array(z.object({ name: z.string().min(1), who: z.string().min(1) })).default([]),
    })
    .default({ arcs: [], moments: [], circle: [] }),
  // Short-form content that gets people talking, and how this influencer shows up
  // in other people's comments (drafted for a human to post; apps can't comment
  // on or like other accounts' posts).
  engagement: z
    .object({
      formats: z.array(z.enum(SHORT_FORMATS)).default([]),
      // Football banter needs a club: friendly rivalry about clubs, never about people.
      football: z.object({ team: z.string().min(1), league: z.string().default(""), rivals: z.array(z.string()).default([]) }).nullable().default(null),
      // Short, funny questions followers answer in the comments.
      questions: z.array(z.string().min(1)).default([]),
      // Short silly takes and bits in their voice.
      silly_talk: z.array(z.string().min(1)).default([]),
      // Community hashtags (no #) whose posts the engagement scout reads.
      scout_hashtags: z.array(z.string().min(1)).default([]),
      // How they comment on other people's posts.
      comment_style: z.string().default(""),
    })
    .default({ formats: [], football: null, questions: [], silly_talk: [], scout_hashtags: [], comment_style: "" }),
  // What this influencer keeps up with: news searches (Google News) and RSS/Atom feeds.
  // Each source may carry a label (the platform or topic it represents), e.g.
  // { query: "TikTok Uganda", label: "TikTok Uganda" } or { url: "...", label: "Premier League" }.
  trends: z
    .object({
      queries: z.array(z.union([z.string(), z.object({ query: z.string(), label: z.string().optional() })])).default([]),
      feeds: z.array(z.union([z.string().url(), z.object({ url: z.string().url(), label: z.string().optional() })])).default([]),
      // Items per brief (spread across labels).
      max_items: z.number().int().min(3).max(12).default(8),
      region: z.string().default("US"),
      language: z.string().default("en"),
      avoid: z.array(z.string()).default([]),
    })
    .default({ queries: [], feeds: [], max_items: 8, region: "US", language: "en", avoid: [] }),
  hashtags: z.object({
    always: z.array(z.string()).default([]),
    pool: z.array(z.string()).default([]),
    max: z.number().int().min(0).max(30).default(5),
  }),
});

export type Persona = z.infer<typeof personaSchema>;
