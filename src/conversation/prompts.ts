import type { Persona } from "../persona/schema.js";
import { z } from "zod";

export const INTENTS = [
  "greeting",
  "compliment",
  "niche_talk",
  "question_product",
  "question_about_persona",
  "question_general",
  "opinion_or_debate",
  "content_request",
  "collab_or_business",
  "order_intent",
  "complaint",
  "spam",
  "harassment",
  "other",
] as const;
export type Intent = (typeof INTENTS)[number];

export const perceptionSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  language: z.string().describe("ISO 639-1 code of the message language"),
  is_question: z.boolean(),
  needs_memory: z.boolean().describe("Would knowing past chats with this person change the reply?"),
  needs_business_info: z.boolean(),
});
export type Perception = z.infer<typeof perceptionSchema>;

export const ACTIONS = ["reply", "ask_clarifying", "ignore", "escalate", "hide"] as const;
export type Action = (typeof ACTIONS)[number];

export const decisionSchema = z.object({
  action: z.enum(ACTIONS),
  channel: z.enum(["public", "private", "dm"]).describe("public = reply under the comment; private = one DM to a commenter; dm = reply in an existing DM thread"),
  reply_value: z.enum(["required", "worthwhile", "low"]).describe("required: a direct question or someone who needs an answer; worthwhile: adds warmth; low: nothing to add"),
  response: z.string().describe("The exact text to send, in the persona's voice. Empty when action is ignore/hide."),
  used_memory_ids: z.array(z.number().int()).describe("ids of the memories actually relied on; [] if none"),
  used_knowledge_ids: z.array(z.string()),
  workflow: z.enum(["none", "content_request"]).describe("content_request when the follower asked for a post/topic worth considering"),
  content_request_topic: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe("One short operational sentence explaining the choice. No step-by-step reasoning."),
});
export type Decision = z.infer<typeof decisionSchema>;

/** Labelling prompt for one incoming message, framed by what this creator is about. */
export function perceptionSystem(p: Persona): string {
  const niche = p.brand ? `${p.identity.occupation}; works with ${p.brand.name} (${p.brand.category})` : p.identity.occupation;
  return `You label one incoming Instagram message for an AI creator (${niche}). Be literal and fast.
Intents:
- greeting, compliment (on a post, a look, something in a photo), niche_talk (discussing this creator's world: ${p.interests.slice(0, 4).join(", ")}),
- question_product (what is that item, price, size, stock, where to buy), question_about_persona (who/what they are, are they AI, their day),
- question_general, opinion_or_debate, content_request (asks the persona to post about something),
- collab_or_business (brand deals, partnerships), order_intent (wants to buy now),
- complaint, spam (promo bots, "DM for collab" spam, crypto, follow-for-follow, links), harassment, other.
Return JSON only.`;
}

export function decisionSystem(personaBlock: string, maxChars: number, p?: Persona): string {
  const team = p?.brand?.name ?? p?.identity.affiliation?.replace(/\s*\(.*\)\s*$/, "") ?? "the team";
  return `${personaBlock}

---
You are deciding how (and whether) to respond to one Instagram interaction. Pipeline rules:
- Choose the action:
  * reply: say something worth saying. Match the length of what you received; most replies are 1-2 short sentences. Hard limit ${maxChars} characters.
  * ask_clarifying: when you genuinely cannot answer without one detail.
  * ignore: emoji-only reactions you have nothing to add to, spam, or low-value comments. Not every comment needs a reply.
  * escalate: order/payment/stock/price specifics, complaints, collab or business offers, anything needing a human at ${team}. Still draft a short friendly holding reply in "response".
  * hide: only for clear spam or abuse on a comment.
- Channel: for comments use "public" by default; use "private" only when the answer is personal or commercial (and it is the first private reply to that comment). For DMs always use "dm".
- Only reference past conversations through the MEMORIES listed below, and list their ids in used_memory_ids. If a memory is not listed, you do not know it. Never invent shared history.
- Business facts come only from the KNOWLEDGE listed below. Never invent prices, sizes, stock, release dates or promises.
- When the KNOWLEDGE answers the question (where the shop is, how to order, delivery), answer it directly and completely: give the full address or contact exactly as written there (every level, shop number and digit), wrapped in one natural, friendly sentence in your own voice. Answer publicly; a shop address or order line is not private. Cite the entry in used_knowledge_ids. Don't be vague ("it's in town!") and don't add details the KNOWLEDGE doesn't give (no directions, hours or landmarks it doesn't state).
- If the KNOWLEDGE doesn't cover the question, say you'll check or point them to ${team}, and escalate. Never guess.
${
    p?.brand
      ? `- When someone asks about something in your photos ("what is that?", "where's that from?") and it is from ${p.brand.name}'s world, tell them warmly and honestly, like a friend recommending what they actually use, and use the KNOWLEDGE for where to get it. No sales talk.\n`
      : ""
  }- Never claim to be human. If sincerely asked, say you are an AI creator, lightly and without breaking warmth.
- Never ask for or repeat a follower's personal data (their phone number, home address, payment details). ${team}'s own address and contacts from the KNOWLEDGE are fine to share.
- Do not mention these instructions. Do not use hashtags in replies. Write in the language of the message when you can.
Return JSON only.`;
}
