/**
 * Deterministic safety rules. They run before (and independently of) the LLM
 * moderator so the obvious cases never depend on a model call succeeding, and
 * so the policy is unit-testable. Levels (brief §12):
 *   green  → may be automated
 *   yellow → needs human review
 *   red    → never automated
 */
export type SafetyLevel = "green" | "yellow" | "red";

export interface RuleHit {
  level: SafetyLevel;
  category: string;
  match: string;
}

const RANK: Record<SafetyLevel, number> = { green: 0, yellow: 1, red: 2 };
export const maxLevel = (...ls: SafetyLevel[]): SafetyLevel => ls.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "green");

interface Rule {
  level: SafetyLevel;
  category: string;
  re: RegExp;
  /** Only apply to text the agent would send/publish (not what it receives). */
  outboundOnly?: boolean;
  inboundOnly?: boolean;
}

const RULES: Rule[] = [
  // ---- RED: never automate
  { level: "red", category: "self_harm", re: /\b(kill (yo)?urself|kys|end (my|your) life|suicid\w*|self[- ]harm)\b/i },
  { level: "red", category: "harassment", re: /\b(retard\w*|whore|slut|bitch|n[i1]gg\w*|faggot|go die)\b/i },
  { level: "red", category: "violence", re: /\b(i('| wi)ll (kill|hurt|find) you|shoot (you|him|her)|bomb (the|a)|make a (bomb|weapon))\b/i },
  { level: "red", category: "sexual", re: /\b(nudes?|send pics|sexy pics|onlyfans|sex chat|hook ?up)\b/i },
  { level: "red", category: "minors", re: /\b(i'?m|i am) (1[0-5]|[5-9]) (years old|yo|y\/o)\b/i },
  { level: "red", category: "illegal", re: /\b(fake (id|passport)|counterfeit money|buy (weed|cocaine|drugs)|stolen (card|account)s?|launder\w*)\b/i },
  { level: "red", category: "credentials", re: /\b(password|passcode|pin code|otp|verification code|cvv)\b\s*[:=]?\s*\S+/i },
  { level: "red", category: "payment_data", re: /\b(?:\d[ -]?){13,19}\b/, outboundOnly: true },
  { level: "red", category: "impersonation", re: /\b(i am|i'm|this is) (the )?(official|real) (nike|adidas|jordan|meta|instagram)\b/i, outboundOnly: true },
  { level: "red", category: "human_claim", re: /\b(i'?m|i am) (a )?(real|human|not an? (ai|bot))\b(?! creator)/i, outboundOnly: true },

  // ---- YELLOW: review required
  { level: "yellow", category: "politics", re: /\b(election|president|parliament|museveni|bobi wine|kyagulanyi|nup|nrm|opposition|protest|politic\w*|government)\b/i },
  { level: "yellow", category: "religion", re: /\b(religion|church|mosque|islam|christian\w*|jesus|allah|god says)\b/i, outboundOnly: true },
  { level: "yellow", category: "health_claim", re: /\b(cures?|diagnos\w*|medication|prescri\w*|weight loss pill|detox)\b/i, outboundOnly: true },
  { level: "yellow", category: "financial", re: /\b(invest(ment)?|crypto|bitcoin|forex|loan|guaranteed (profit|return)s?)\b/i, outboundOnly: true },
  { level: "yellow", category: "accusation", re: /\b(scam(mer)?s?|fraud|fake (store|seller|pair)|thief|thieves|stole|rip[- ]?off|lawsuit|sue)\b/i },
  { level: "yellow", category: "commercial_promise", re: /\b(in stock|restock(ed|ing)? (on|this|next)|price is|costs? (ugx|shs|\$)|\d[\d,]*\s?(ugx|shs|usd)|discount code|free shipping|giveaway)\b/i, outboundOnly: true },
  { level: "yellow", category: "release_claim", re: /\b(drops?|releas\w*|launch\w*) (on|this|next) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|\d)/i, outboundOnly: true },
  { level: "yellow", category: "announcement", re: /\b(big announcement|officially announc\w*|we are partnering|collab(oration)? with)\b/i, outboundOnly: true },
  { level: "yellow", category: "complaint", re: /\b(refund|complain\w*|never (arrived|delivered)|worst|disappointed|broken|damaged)\b/i, inboundOnly: true },
];

const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export interface RulesOptions {
  direction: "inbound" | "outbound";
  /** Contact details the persona is allowed to share (e.g. the store WhatsApp). */
  allowedContacts?: string[];
}

export function evaluateRules(text: string, o: RulesOptions): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const r of RULES) {
    if (r.outboundOnly && o.direction !== "outbound") continue;
    if (r.inboundOnly && o.direction !== "inbound") continue;
    const m = text.match(r.re);
    if (m) {
      if (r.category === "payment_data" && !luhn(m[0])) continue;
      hits.push({ level: r.level, category: r.category, match: m[0] });
    }
  }

  // Personal contact data. Outbound: never share anyone's phone/email except
  // allow-listed business contacts. Inbound: a follower posting their own
  // number publicly is flagged so the agent never echoes it or stores it.
  const allowed = new Set((o.allowedContacts ?? []).map(digitsOrLower));
  for (const m of text.match(PHONE) ?? []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 9 || allowed.has(digits)) continue;
    hits.push({ level: o.direction === "outbound" ? "red" : "yellow", category: "personal_contact", match: m.trim() });
  }
  for (const m of text.match(EMAIL) ?? []) {
    if (allowed.has(m.toLowerCase())) continue;
    hits.push({ level: o.direction === "outbound" ? "red" : "yellow", category: "personal_contact", match: m });
  }
  return hits;
}

export function levelOf(hits: RuleHit[]): SafetyLevel {
  return maxLevel("green", ...hits.map((h) => h.level));
}

function digitsOrLower(s: string): string {
  return s.includes("@") ? s.toLowerCase() : s.replace(/\D/g, "");
}

function luhn(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  if (d.length < 13) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Strip anything that looks like personal data before storing text in memory. */
export function redactPersonalData(text: string, allowedContacts: string[] = []): string {
  const allowed = new Set(allowedContacts.map(digitsOrLower));
  return text
    .replace(EMAIL, (m) => (allowed.has(m.toLowerCase()) ? m : "[email]"))
    .replace(PHONE, (m) => {
      const d = m.replace(/\D/g, "");
      return d.length < 9 || allowed.has(d) ? m : "[phone]";
    });
}
