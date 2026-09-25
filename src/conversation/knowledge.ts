import { maybeInfluencer, type KnowledgeEntry } from "../context.js";
import { containsKeyword } from "../lib/text.js";

export type { KnowledgeEntry } from "../context.js";

/** The current influencer's business/product knowledge (from its knowledge YAML). */
export function knowledge(): KnowledgeEntry[] {
  return maybeInfluencer()?.knowledge ?? [];
}

/** Entries whose keywords appear in the text, best match first. */
export function retrieveKnowledge(text: string, limit = 3): KnowledgeEntry[] {
  return knowledge()
    .map((e) => ({ e, score: e.keywords.filter((k) => containsKeyword(text, k)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}

/** Phone numbers / emails published in the knowledge base are safe to repeat. */
export function allowedContacts(): string[] {
  const out: string[] = [];
  for (const e of knowledge()) {
    for (const m of e.content.match(/\+?\d[\d\s-]{7,}\d/g) ?? []) out.push(m);
    for (const m of e.content.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []) out.push(m);
  }
  return out;
}
