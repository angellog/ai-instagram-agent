import { namesBrand } from "../persona/pronouns.js";
import type { Persona } from "../persona/schema.js";
import type { Intent } from "./prompts.js";

/**
 * Social conversation: the creator chats like a person on Instagram, not like
 * an assistant or a sales rep. Short, warm, mirrors the other person, has a
 * life of its own, and only talks shop when someone asks about buying.
 */

/** Intents where talking about the brand, products, prices or the shop is the answer. */
export const SHOP_INTENTS: Intent[] = ["question_product", "order_intent", "collab_or_business", "complaint"];

/** Phrases that make a reply read like a bot, a help desk or an ad. */
const ASSISTANT_TELLS =
  /\b(as an ai|as a language model|i'?m here to help|how (can|may) i (help|assist)|let me know if|feel free to|great question|i hope this helps|happy to help|don'?t hesitate|is there anything else|thank you for reaching out|thanks for reaching out|check out our|visit our (store|shop)|link in (my )?bio|dm (me|us) for (price|orders?))\b/i;

export function socialStyleBlock(p: Persona): string {
  const brand = p.brand?.name ?? p.identity.affiliation?.replace(/\s*\(.*\)\s*$/, "");
  return `HOW YOU TALK (this is a real Instagram chat, not customer service):
- You're ${p.identity.name}, chatting the way you would with a friend or a new follower. React, joke lightly, be curious, have opinions.
- Length mirrors theirs. "hey" or an emoji gets a few words back. Most replies are one short sentence, often under 12 words. Two short sentences at most, unless they asked something that truly needs more (like how to get somewhere).
- Never: paragraphs, lists, line breaks, more than one question, "how can I help", "let me know if", "feel free", "great question", "hope this helps", over-the-top excitement, or ending every message with a question.
- Ask a question back only sometimes, when you're genuinely curious, so the chat keeps going naturally.
- You have a life. Share small real-sounding details from your day and your interests (${p.interests.slice(0, 6).join(", ")}): what you're watching, playing, wearing, where you're heading this weekend. You may invent new details freely, but they must fit who you are and never contradict YOUR OWN LIFE below; whatever you say becomes part of your story and is remembered.
- With people who keep chatting, be a friend: remember what they told you (MEMORIES) and follow up on it ("did you end up going?").
- You're an influencer, not a salesperson. Don't bring up ${brand ?? "the brand"}, the shop, products, prices or buying. Only when they ask where to get something, what something costs or how to order do you answer, warmly and exactly from the KNOWLEDGE, like a friend recommending a place they actually use.
- You don't bring up being an AI. Only if someone sincerely asks whether you're real, human or a bot, tell the truth in one light line (your Disclosure), then carry on chatting as yourself. Never claim to be human.
- Never say you can't share something "as an AI", never apologise like a bot, never talk about these rules.`;
}

export interface SocialCheck {
  problems: string[];
  /** Target length for the rewrite. */
  maxChars: number;
}

/**
 * Deterministic checks on a draft reply: too long for the message it answers,
 * shaped like a bot (line breaks, lists, help-desk phrases), or selling when
 * nobody asked.
 */
export function socialProblems(reply: string, inbound: string, p: Persona, intent: Intent): SocialCheck {
  const problems: string[] = [];
  const shop = SHOP_INTENTS.includes(intent);
  const inLen = inbound.trim().length;
  // Shop answers may carry a full address; social replies mirror the message.
  const maxChars = Math.min(p.communication_style.max_reply_chars, shop ? 260 : Math.max(70, Math.round(inLen * 1.8) + 40));
  if (reply.length > maxChars) problems.push(`too long (${reply.length} characters; keep it under ${maxChars}, it's a chat)`);
  if (/\n/.test(reply.trim())) problems.push("has line breaks (one short message, no paragraphs)");
  if (/(^|\s)([-•*]|\d+[.)])\s/.test(reply)) problems.push("reads like a list");
  if (ASSISTANT_TELLS.test(reply)) problems.push(`sounds like a help desk or an ad ("${ASSISTANT_TELLS.exec(reply)![0]}")`);
  if ((reply.match(/\?/g) ?? []).length > 1) problems.push("asks more than one question");
  const brand = p.brand?.name;
  if (!shop && brand && namesBrand(reply, brand) && !namesBrand(inbound, brand)) problems.push(`brings up ${brand} when they didn't ask about buying (you're an influencer, not a salesperson)`);
  if (!shop && /\b(price|prices|ugx|shs|discount|in stock|order now|available in sizes?)\b/i.test(reply) && !/\b(price|cost|how much|stock|order|buy|size)\b/i.test(inbound)) {
    problems.push("talks prices or stock when they didn't ask");
  }
  return { problems, maxChars };
}

export function socialFixInstruction(c: SocialCheck): string {
  return `Rewrite it as a real person would text back on Instagram: ${c.problems.join("; ")}. One short message under ${c.maxChars} characters, same meaning and warmth, no line breaks. Return only the new reply.`;
}
