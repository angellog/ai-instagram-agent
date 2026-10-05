import type { KnowledgeEntry } from "../context.js";
import { namesBrand, pronouns } from "../persona/pronouns.js";
import type { Persona } from "../persona/schema.js";

/** How many recent captions the mention rate is measured over. */
export const MENTION_WINDOW = 10;

/**
 * May this post name the brand? Counted from this influencer's own recent
 * captions so the mention rate holds whatever the model prefers.
 */
export function brandMentionBudget(p: Persona, recentCaptions: string[]): { used: number; allowed: number; mayName: boolean } {
  if (!p.brand) return { used: 0, allowed: 0, mayName: false };
  const window = recentCaptions.slice(0, MENTION_WINDOW);
  const used = window.filter((c) => namesBrand(c, p.brand!.name)).length;
  const allowed = Math.round(p.brand.mention_rate * MENTION_WINDOW);
  return { used, allowed, mayName: used < allowed };
}

/** Facts the director may rely on when the brand's world appears (never invent beyond these). */
function brandFacts(knowledge: KnowledgeEntry[]): string {
  return knowledge
    .filter((k) => !/^ai[-_]|disclos/i.test(k.id))
    .slice(0, 8)
    .map((k) => `- ${k.id}: ${k.content.replace(/\s+/g, " ").trim().slice(0, 160)}`)
    .join("\n");
}

/**
 * The "brand pull" brief for posts and stories: everyday UGC where the brand's
 * category lives naturally in the frame, so followers ask about it. Empty when
 * the influencer has no brand (a pure lifestyle creator).
 */
export function brandPullBlock(p: Persona, recentCaptions: string[], knowledge: KnowledgeEntry[], kind: "post" | "story"): string {
  const b = p.brand;
  if (!b) return "";
  const pr = pronouns(p);
  const budget = brandMentionBudget(p, recentCaptions);
  const facts = brandFacts(knowledge);
  return `BRAND PULL (${b.name}: ${b.category}). This is UGC, not advertising.
- The ${kind} is about ${pr.poss} life in this moment. ${b.name}'s world may be present only where it would naturally be${b.natural_moments.length ? `, e.g. ${b.natural_moments.join("; ")}` : ""}. A breakfast ${kind} is about breakfast.
- When it fits, let one item from the category sit naturally in the frame (on the table, in hand, in the background) without being the subject or the caption topic, so a follower might ask about it${
    b.curiosity_hooks.length ? ` (the kind of question we want: ${b.curiosity_hooks.map((h) => `"${h}"`).join(", ")})` : ""
  }. Put it in "featured_item", described generically; leave "featured_item" empty when it would feel forced.${b.products.length ? `\n- Items that can appear: ${b.products.join("; ")}.` : ""}
- Naming ${b.name}: ${budget.mayName ? `allowed this time (named in ${budget.used} of the last ${MENTION_WINDOW} posts, limit ${budget.allowed}), but only if it fits naturally; most posts still don't.` : `NOT this time (named in ${budget.used} of the last ${MENTION_WINDOW} posts, limit ${budget.allowed}). Do not name the brand in the caption, hashtags or on the image.`}
- Never pitch, never add "link in bio", prices, discounts, stock or shop details unless the operator asked for them.${facts ? `\n- Brand facts you may rely on (never invent beyond these):\n${facts}` : ""}`;
}
