import type { KnowledgeEntry } from "../context.js";

/**
 * Fact check for replies that cite business knowledge. Two deterministic checks:
 *  - completeness: an entry can list `must_include` phrases (the full shop
 *    address, the WhatsApp number). A reply that cites the entry must carry
 *    every one of them, so "where's the shop?" never gets a vague half-answer.
 *  - truth: every number in the reply must come from the knowledge the model
 *    was shown or from the follower's own message. A floor, shop number or
 *    phone number the model made up is caught before it goes out.
 */

export interface FactProblems {
  missing: string[];
  unverified: string[];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Phone numbers compare on their last 9 digits, so 0789 652 909 and +256 789 652 909 are the same number. */
export const phoneKey = (digits: string) => (digits.length >= 9 ? digits.slice(-9) : digits);

/** Every number in a text. A spaced run long enough to be a phone number is one number; otherwise each run of digits counts. */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(/\+?\d[\d\s().-]*\d|\d/g) ?? []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 9) out.push(phoneKey(digits));
    else out.push(...(m.match(/\d+/g) ?? []));
  }
  return out;
}

export function missingDetails(text: string, entries: KnowledgeEntry[]): string[] {
  const t = norm(text);
  const nums = numbersIn(text);
  const missing: string[] = [];
  for (const e of entries) {
    for (const phrase of e.must_include ?? []) {
      const digits = phrase.replace(/\D/g, "");
      // A phone number counts in any common format (+256…, 0…, spaced or not).
      const found = digits.length >= 9 ? nums.includes(phoneKey(digits)) : t.includes(norm(phrase));
      if (!found && !missing.includes(phrase)) missing.push(phrase);
    }
  }
  return missing;
}

export function unverifiedNumbers(text: string, shown: KnowledgeEntry[], inbound: string): string[] {
  const known = new Set([...shown.flatMap((e) => numbersIn(e.content)), ...numbersIn(inbound)]);
  return [...new Set(numbersIn(text).filter((n) => !known.has(n)))];
}

export function checkFacts(text: string, o: { used: KnowledgeEntry[]; shown: KnowledgeEntry[]; inbound: string }): FactProblems {
  return { missing: missingDetails(text, o.used), unverified: unverifiedNumbers(text, o.shown, o.inbound) };
}

export const hasProblems = (p: FactProblems) => p.missing.length > 0 || p.unverified.length > 0;

/** The instruction for the one rewrite round. */
export function fixInstruction(p: FactProblems): string {
  const parts: string[] = [];
  if (p.missing.length) parts.push(`It must include these details exactly as written: ${p.missing.map((m) => `"${m}"`).join(", ")}.`);
  if (p.unverified.length) parts.push(`It contains numbers that are not in the KNOWLEDGE (${p.unverified.join(", ")}). Remove them or use only numbers the KNOWLEDGE gives.`);
  return parts.join(" ");
}
