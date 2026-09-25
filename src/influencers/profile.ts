import sharp from "sharp";
import { z } from "zod";
import { currentInfluencer, influencerId } from "../context.js";
import { one } from "../db/pool.js";
import { assetBytes, generate } from "../generation/service.js";
import { sha256 } from "../lib/crypto.js";
import { PermanentError } from "../lib/errors.js";
import { llm } from "../llm/llm.js";
import { persona } from "../persona/loader.js";
import { activeSoul, soulContext } from "../souls/souls.js";
import { download, hostImage } from "../storage/host.js";

/**
 * Profile kit. Instagram's API cannot change a profile's name, bio or photo,
 * so the agent prepares everything for the person setting the account up:
 * text to paste (within Instagram's limits) and a profile picture made from
 * the soul's face. Stored on influencers.profile_kit.
 */

export const LIMITS = { name: 30, username: 30, bio: 150, highlight: 15 } as const;

export const kitSchema = z.object({
  display_name: z.string().describe(`Instagram "Name" field, max ${LIMITS.name} chars, searchable: name + niche keyword`),
  usernames: z.array(z.string()).min(3).max(5).describe("handle ideas, lowercase letters, digits, . and _ only, max 30"),
  bios: z
    .array(z.object({ style: z.string(), text: z.string().describe(`max ${LIMITS.bio} characters including emoji and line breaks`) }))
    .min(3)
    .max(3),
  category: z.string().describe("Instagram profile category, e.g. Digital creator"),
  link_idea: z.string().describe("what to put in the profile link"),
  highlights: z.array(z.string()).min(4).max(6).describe(`story highlight names, max ${LIMITS.highlight} chars each`),
  first_story: z.string().describe("one idea for the first story, to make the profile feel alive"),
});
export type ProfileKitText = z.infer<typeof kitSchema>;

export interface ProfilePicture {
  url: string;
  kind: "crop" | "generated";
  created_at: string;
}

export interface ProfileKit {
  text?: ProfileKitText & { generated_at: string };
  pictures?: ProfilePicture[];
}

const AI_TOKEN = /\b(ai|a\.i\.)\b/i;

/** Enforce Instagram's limits and the disclosure rule deterministically, whatever the model wrote. */
export function sanitizeKit(k: ProfileKitText, name: string): ProfileKitText {
  const cut = (s: string, n: number) => ([...s].length <= n ? s : [...s].slice(0, n - 1).join("").trimEnd() + "…");
  const bios = k.bios.map((b) => {
    let text = b.text.trim();
    // Honesty: every bio says it's an AI creator.
    if (!AI_TOKEN.test(text)) text = `${text}\n🤖 AI creator`;
    return { style: b.style, text: cut(text, LIMITS.bio) };
  });
  return {
    display_name: cut(k.display_name.trim() || name, LIMITS.name),
    usernames: [...new Set(k.usernames.map((u) => u.toLowerCase().replace(/[^a-z0-9._]/g, "").replace(/^\.+|\.+$/g, "").slice(0, LIMITS.username)).filter((u) => u.length >= 3))],
    bios,
    category: k.category.trim().slice(0, 60),
    link_idea: k.link_idea.trim().slice(0, 200),
    highlights: k.highlights.map((h) => cut(h.trim(), LIMITS.highlight)).slice(0, 6),
    first_story: k.first_story.trim().slice(0, 300),
  };
}

export async function getKit(id = influencerId()): Promise<ProfileKit> {
  return ((await one<{ profile_kit: ProfileKit }>("SELECT profile_kit FROM influencers WHERE id = $1", [id]))?.profile_kit ?? {}) as ProfileKit;
}

async function saveKit(patch: ProfileKit): Promise<ProfileKit> {
  const r = await one<{ profile_kit: ProfileKit }>("UPDATE influencers SET profile_kit = profile_kit || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING profile_kit", [
    influencerId(),
    JSON.stringify(patch),
  ]);
  return r!.profile_kit;
}

/** Write the name/bio/handle/highlight suggestions from the persona. */
export async function composeProfileText(): Promise<ProfileKitText> {
  const p = persona();
  const i = p.identity;
  const out = await llm().structured(kitSchema, {
    operation: "profile.kit",
    tier: "smart",
    maxTokens: 1200,
    system:
      "You set up Instagram profiles that convert visitors into followers. Follow the proven creator template: who you are + what you post + a personal hook + a reason to follow/CTA. Warm, specific, scannable, a few relevant emoji, no hashtags in the bio. Respect the character limits exactly. Every bio must plainly say this is an AI creator. Return JSON.",
    prompt: [
      `Creator: ${i.name} ${i.handle ?? ""}, ${i.age ?? ""} in ${i.location}. ${i.occupation}.`,
      `Bio notes: ${i.bio.trim()}`,
      `Disclosure: ${i.ai_disclosure.trim()}`,
      i.affiliation ? `Affiliation: ${i.affiliation}` : "",
      `Interests: ${p.interests.join(", ")}. Personality: ${p.personality.join(", ")}. Voice: ${p.communication_style.voice}.`,
      `Limits: Name ≤${LIMITS.name}, username ≤${LIMITS.username}, bio ≤${LIMITS.bio} (count emoji and line breaks), highlight names ≤${LIMITS.highlight}.`,
      "Give three bio styles: 'clean', 'playful', 'community' (invites DMs/comments).",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const kit = sanitizeKit(out, i.name);
  await saveKit({ text: { ...kit, generated_at: new Date().toISOString() } });
  return kit;
}

/** 1080×1080, face-weighted crop that survives Instagram's circle mask. */
export async function squareProfile(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).rotate().resize(1080, 1080, { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 92 }).toBuffer();
}

async function store(bytes: Buffer, kind: ProfilePicture["kind"]): Promise<ProfilePicture> {
  const { url } = await hostImage(bytes, `influencers/${currentInfluencer().slug}/profile/pp-${kind}-${sha256(bytes).slice(0, 12)}.jpg`);
  const pic: ProfilePicture = { url, kind, created_at: new Date().toISOString() };
  const cur = await getKit();
  await saveKit({ pictures: [pic, ...(cur.pictures ?? []).filter((x) => x.url !== url)].slice(0, 6) });
  return pic;
}

/** Free option: crop the soul's primary face. */
export async function profilePictureFromSoul(): Promise<ProfilePicture> {
  const soul = await activeSoul();
  if (!soul?.primaryRef) throw new PermanentError("choose a soul face first");
  return store(await squareProfile(await download(soul.primaryRef, 25 * 1024 * 1024, "image/")), "crop");
}

/** Designed option: a new headshot of the same person, composed for a profile circle (one image of spend). */
export async function generateProfilePicture(): Promise<ProfilePicture> {
  const soul = await activeSoul();
  if (!soul) throw new PermanentError("choose a soul face first");
  const p = persona();
  const r = await generate({
    influencerId: influencerId(),
    idempotencyKey: `profile:${influencerId()}:${soul.soul.soul_id}:${Date.now()}`,
    purpose: "soul",
    modality: "reference_image",
    prompt: [
      `Instagram profile photo of the same person as the reference: head and shoulders, centred, face filling the middle third, looking straight at the camera with a big warm genuine smile.`,
      `Use the reference ONLY for identity; ${p.visual.character.appearance.trim()}. Hair: ${p.visual.character.hairstyle}.`,
      `Simple, softly blurred, warm background with gentle contrast so the face pops inside a small circle crop. Natural daylight, sharp eyes, realistic skin texture, shot on a phone.`,
      `No text, no logos, no watermark, no other people.`,
    ].join(" "),
    references: soul.identityRefs,
    soul: soulContext(soul),
    aspectRatio: "1:1",
    resolution: "2K",
    quality: "high",
    identityConsistency: "high",
  });
  return store(await squareProfile(await assetBytes(r.assets[0])), "generated");
}
