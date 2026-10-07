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

const NOT_UNITS = new Set("a an and are as at be but by do for from if in is it its me my of on or our so the to up us was we were will with you your".split(" "));

/** Each number with the word right after it ("2 hours" -> 2/hour, "9am" -> 9/am); phones and bare numbers have no unit. */
export function quantitiesIn(text: string): Array<{ n: string; unit: string }> {
  const out: Array<{ n: string; unit: string }> = [];
  const re = /\+?\d[\d\s().-]*\d|\d/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 9) {
      out.push({ n: phoneKey(digits), unit: "" });
      continue;
    }
    const nums = m[0].match(/\d+/g) ?? [];
    const word = /^\s?([a-z]+)/i.exec(text.slice(m.index + m[0].length))?.[1]?.toLowerCase() ?? "";
    const unit = NOT_UNITS.has(word) ? "" : word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
    nums.forEach((n, i) => out.push({ n, unit: i === nums.length - 1 ? unit : "" }));
  }
  return out;
}

/**
 * Numbers in the text the knowledge (or the follower) doesn't back. A number with
 * a unit needs the same number with the same unit, or the bare number, so "2 hours"
 * in the knowledge never vouches for "only 2 pairs left".
 */
export function unverifiedNumbers(text: string, shown: KnowledgeEntry[], inbound: string): string[] {
  const known = [...shown.flatMap((e) => quantitiesIn(e.content)), ...numbersIn(inbound).map((n) => ({ n, unit: "" }))]; // the follower's own numbers back any unit
  const ok = (q: { n: string; unit: string }) => known.some((k) => k.n === q.n && (!q.unit || !k.unit || k.unit === q.unit));
  return [...new Set(quantitiesIn(text).filter((q) => !ok(q)).map((q) => q.n))];
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
