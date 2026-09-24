import { normalize } from "../lib/text.js";
import { evaluateRules, redactPersonalData } from "../safety/rules.js";

/**
 * Memory policy (brief §5): what is worth remembering, what expires, what is
 * never stored, with what confidence, from which source.
 *
 * The extractor LLM proposes candidates; this deterministic policy decides.
 */

export const RELATIONSHIP_KINDS = ["interest", "preference", "fact", "question", "event", "context"] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

/** Time-to-live per kind. `null` = kept until superseded (still decays in ranking). */
export const TTL_DAYS: Record<string, number | null> = {
  interest: null,
  preference: null,
  fact: 365,
  question: 30,
  event: 21,
  context: 45,
  // world layer
  theme: 30,
  content_request: 21,
  recent_topic: 14,
  published: null,
};

export const MIN_CONFIDENCE = 0.6;

/** Categories that are never stored, whatever the extractor says. */
const FORBIDDEN_TOPICS: Array<{ category: string; re: RegExp }> = [
  { category: "health", re: /\b(sick|illness|disease|diagnos\w*|pregnan\w*|depress\w*|anxiety|medication|hospital|hiv|therapy)\b/i },
  { category: "religion", re: /\b(christian|muslim|islam|church|mosque|religio\w*|atheis\w*)\b/i },
  { category: "politics", re: /\b(votes? for|supports? (nup|nrm)|politic\w*|party member)\b/i },
  { category: "sexuality", re: /\b(gay|lesbian|bisexual|sexual|sex life|dating life)\b/i },
  { category: "finances", re: /\b(salary|debt|loan|bank account|income|broke)\b/i },
  { category: "precise_location", re: /\b(lives? (at|on)|home address|house number|plot \d+|street \d+)\b/i },
  { category: "minor", re: /\b(1[0-5]|[5-9]) (years old|yo)\b|\b(in (primary|p\.?[1-7])|my (mom|mum) won'?t let)\b/i },
  { category: "credentials", re: /\b(password|pin|otp|login)\b/i },
  { category: "third_party", re: /\b(my (friend|sister|brother|boyfriend|girlfriend|wife|husband|ex)('s)? (name|number|address))\b/i },
];

export interface MemoryCandidate {
  kind: string;
  content: string;
  confidence: number;
  importance?: number;
  /** Explicit expiry for dated things ("my birthday is Friday"). ISO date. */
  expires_on?: string | null;
}

export type PolicyVerdict =
  | { store: true; kind: string; key: string; content: string; confidence: number; importance: number; expiresAt: Date | null }
  | { store: false; reason: string };

export function applyMemoryPolicy(c: MemoryCandidate, now = new Date(), allowedContacts: string[] = []): PolicyVerdict {
  const kind = c.kind.toLowerCase().trim();
  if (!(kind in TTL_DAYS)) return { store: false, reason: `unknown kind "${c.kind}"` };
  const content = c.content.trim();
  if (content.length < 4) return { store: false, reason: "too short" };
  if (content.length > 300) return { store: false, reason: "too long; memories are single facts" };
  if (!(c.confidence >= MIN_CONFIDENCE)) return { store: false, reason: `confidence ${c.confidence} < ${MIN_CONFIDENCE}` };

  for (const f of FORBIDDEN_TOPICS) if (f.re.test(content)) return { store: false, reason: `never stored: ${f.category}` };
  // Contact data, IDs, card numbers: refuse rather than redact, a redacted
  // "their number is [phone]" has no value and signals the wrong habit.
  const personal = evaluateRules(content, { direction: "outbound", allowedContacts }).filter((h) =>
    ["personal_contact", "payment_data", "credentials"].includes(h.category),
  );
  if (personal.length) return { store: false, reason: `never stored: ${personal[0].category}` };

  let expiresAt: Date | null = null;
  if (c.expires_on) {
    const d = new Date(c.expires_on);
    if (!Number.isNaN(d.getTime())) {
      if (d.getTime() < now.getTime()) return { store: false, reason: "already expired" };
      expiresAt = new Date(d.getTime() + 2 * 86_400_000); // keep a couple of days after the date for follow-ups
    }
  }
  if (!expiresAt) {
    const ttl = TTL_DAYS[kind];
    expiresAt = ttl === null ? null : new Date(now.getTime() + ttl * 86_400_000);
  }

  return {
    store: true,
    kind,
    key: memoryKey(kind, content),
    content: redactPersonalData(content, allowedContacts),
    confidence: Math.min(1, c.confidence),
    importance: clamp01(c.importance ?? defaultImportance(kind)),
    expiresAt,
  };
}

/** Dedupe key: kind + the first few content words, so "likes Jordans" updates in place. */
export function memoryKey(kind: string, content: string): string {
  const words = normalize(content)
    .split(" ")
    .filter((w) => (w.length > 2 || /\d/.test(w)) && !["user", "they", "their", "likes", "like", "loves", "wants", "asked", "about", "the", "and"].includes(w))
    .slice(0, 4);
  return `${kind}:${words.join("_") || normalize(content).slice(0, 40)}`;
}

function defaultImportance(kind: string): number {
  return { preference: 0.7, interest: 0.6, fact: 0.6, event: 0.8, question: 0.4, context: 0.5 }[kind] ?? 0.5;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
