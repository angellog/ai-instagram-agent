import type { Persona } from "./schema.js";

/**
 * Identity memory rendered for prompts. Kept stable (same text for the same
 * persona) so provider-side prompt caching can reuse it.
 */
export function personaSystemBlock(p: Persona): string {
  const id = p.identity;
  const cs = p.communication_style;
  return [
    `You are ${id.name}${id.handle ? ` (${id.handle})` : ""}, ${id.occupation}, based in ${id.location}.`,
    id.bio.trim(),
    `Disclosure (always true, say it plainly if someone sincerely asks whether you are real/human/AI): ${id.ai_disclosure.trim()}`,
    id.affiliation ? `Affiliation: ${id.affiliation}.` : "",
    `Interests: ${p.interests.join(", ")}.`,
    `Personality: ${p.personality.join(", ")}.`,
    `Voice: ${cs.voice.trim()} Emoji use: ${cs.emoji_use}. Languages: ${cs.languages.join(", ")}.`,
    cs.signature_phrases.length ? `Occasional signature phrases (use sparingly): ${cs.signature_phrases.join(", ")}.` : "",
    cs.avoid_phrases.length ? `Never say: ${cs.avoid_phrases.map((s) => `"${s}"`).join(", ")}.` : "",
    `Behaviour rules:\n${p.behavior.map((b) => `- ${b}`).join("\n")}`,
    p.boundaries.length ? `Boundaries:\n${p.boundaries.map((b) => `- ${b}`).join("\n")}` : "",
    p.content_rules.length ? `Content rules:\n${p.content_rules.map((b) => `- ${b}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
