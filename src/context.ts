import { AsyncLocalStorage } from "node:async_hooks";
import { parse } from "yaml";
import { z } from "zod";
import { many, one } from "./db/pool.js";
import { sha256 } from "./lib/crypto.js";
import { parsePersona } from "./persona/parse.js";
import type { Persona } from "./persona/schema.js";

/**
 * Influencer context. Everything that runs on behalf of an influencer (a job,
 * an admin request) runs inside `withInfluencer(id, fn)`, and every module reads
 * the persona, knowledge, controls, Instagram account and data scope from here.
 * This is the isolation boundary: code outside a context cannot touch
 * influencer data by accident because `influencerId()` throws.
 */

export interface KnowledgeEntry {
  id: string;
  keywords: string[];
  content: string;
}

export interface InfluencerContext {
  id: number;
  slug: string;
  name: string;
  status: "hatching" | "active" | "paused" | "archived";
  persona: Persona;
  personaHash: string;
  personaYaml: string;
  knowledge: KnowledgeEntry[];
}

const storage = new AsyncLocalStorage<InfluencerContext>();

const knowledgeSchema = z.object({
  entries: z.array(z.object({ id: z.string(), keywords: z.array(z.string()).min(1), content: z.string() })).default([]),
});

export function parseKnowledge(yamlText: string): KnowledgeEntry[] {
  if (!yamlText.trim()) return [];
  return knowledgeSchema.parse(parse(yamlText) ?? {}).entries;
}

interface InfluencerRow {
  id: number;
  slug: string;
  name: string;
  status: InfluencerContext["status"];
  persona_yaml: string;
  knowledge_yaml: string;
  updated_at: Date;
}

const cache = new Map<number, { at: number; stamp: string; ctx: InfluencerContext }>();
const TTL_MS = 10_000;

export async function loadInfluencer(id: number, force = false): Promise<InfluencerContext> {
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.ctx;
  const row = await one<InfluencerRow>("SELECT id, slug, name, status, persona_yaml, knowledge_yaml, updated_at FROM influencers WHERE id = $1", [id]);
  if (!row) throw new Error(`Influencer ${id} not found`);
  const stamp = new Date(row.updated_at).toISOString();
  if (hit && hit.stamp === stamp) {
    hit.at = Date.now();
    return hit.ctx;
  }
  if (!row.persona_yaml.trim()) throw new Error(`Influencer ${row.slug} has no persona yet`);
  const ctx: InfluencerContext = {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    status: row.status,
    persona: parsePersona(row.persona_yaml),
    personaHash: sha256(row.persona_yaml).slice(0, 16),
    personaYaml: row.persona_yaml,
    knowledge: parseKnowledge(row.knowledge_yaml),
  };
  cache.set(id, { at: Date.now(), stamp, ctx });
  return ctx;
}

export function invalidateInfluencer(id?: number): void {
  if (id === undefined) cache.clear();
  else cache.delete(id);
}

export async function withInfluencer<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const ctx = await loadInfluencer(id);
  return storage.run(ctx, fn);
}

/**
 * Like withInfluencer, but also works for an influencer that has no persona
 * yet (hatching): costs, budgets and events are still attributed to it; code
 * that needs the persona fails with a clear message instead.
 */
export async function withInfluencerLoose<T>(id: number, fn: () => Promise<T>): Promise<T> {
  try {
    return await withInfluencer(id, fn);
  } catch (e) {
    const row = await one<{ id: number; slug: string; name: string; status: InfluencerContext["status"]; persona_yaml: string }>(
      "SELECT id, slug, name, status, persona_yaml FROM influencers WHERE id = $1",
      [id],
    );
    if (!row || row.persona_yaml.trim()) throw e; // unknown influencer, or a real persona error
    const bare = { id: Number(row.id), slug: row.slug, name: row.name, status: row.status, personaHash: "", personaYaml: "", knowledge: [] } as unknown as InfluencerContext;
    Object.defineProperty(bare, "persona", {
      get() {
        throw new Error(`${row.name} has no persona yet`);
      },
    });
    return storage.run(bare, fn);
  }
}

/** Run with an explicit context object (tests, hatch previews). */
export function runInContext<T>(ctx: InfluencerContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

let fallback: InfluencerContext | undefined;

/**
 * Process-wide default context for code running outside any request or job
 * (test suites, one-off scripts). Production entry points never set it, so a
 * missing withInfluencer() there still fails loudly.
 */
export function setFallbackInfluencer(ctx: InfluencerContext | undefined): void {
  fallback = ctx;
}

export function currentInfluencer(): InfluencerContext {
  const ctx = storage.getStore() ?? fallback;
  if (!ctx) throw new Error("No influencer context: wrap the call in withInfluencer(id, ...)");
  return ctx;
}

export function maybeInfluencer(): InfluencerContext | undefined {
  return storage.getStore() ?? fallback;
}

export function influencerId(): number {
  return currentInfluencer().id;
}

export async function listInfluencers(statuses: InfluencerContext["status"][] = ["active", "paused", "hatching"]) {
  return many<{ id: number; slug: string; name: string; status: InfluencerContext["status"]; avatar_url: string | null }>(
    "SELECT id, slug, name, status, avatar_url FROM influencers WHERE status = ANY($1) ORDER BY id",
    [statuses],
  );
}

export async function influencerBySlug(slug: string) {
  return one<{ id: number; slug: string; name: string; status: string }>("SELECT id, slug, name, status FROM influencers WHERE slug = $1", [slug]);
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s.length >= 2 ? s : `influencer-${Date.now().toString(36)}`;
}
