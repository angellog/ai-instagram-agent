import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { env } from "../config/env.js";
import { containsKeyword } from "../lib/text.js";

const knowledgeSchema = z.object({
  entries: z
    .array(z.object({ id: z.string(), keywords: z.array(z.string()).min(1), content: z.string() }))
    .default([]),
});
export type KnowledgeEntry = z.infer<typeof knowledgeSchema>["entries"][number];

let cached: KnowledgeEntry[] | undefined;

export function loadKnowledge(path = env().KNOWLEDGE_PATH): KnowledgeEntry[] {
  const p = resolve(path);
  if (!existsSync(p)) return [];
  return knowledgeSchema.parse(parse(readFileSync(p, "utf8")) ?? {}).entries;
}

export function knowledge(): KnowledgeEntry[] {
  cached ??= loadKnowledge();
  return cached;
}

export function setKnowledge(entries: KnowledgeEntry[]): void {
  cached = entries;
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

/** Phone numbers / handles / emails published in the knowledge base are safe to repeat. */
export function allowedContacts(): string[] {
  const out: string[] = [];
  for (const e of knowledge()) {
    for (const m of e.content.match(/\+?\d[\d\s-]{7,}\d/g) ?? []) out.push(m);
    for (const m of e.content.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []) out.push(m);
  }
  return out;
}
