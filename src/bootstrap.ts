import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "./config/env.js";
import { invalidateInfluencer, parseKnowledge, slugify } from "./context.js";
import { one } from "./db/pool.js";
import { ensureDefaultPolicy, syncCatalog } from "./generation/registry.js";
import { seedAccountFromEnv } from "./instagram/accounts.js";
import { sha256 } from "./lib/crypto.js";
import { recordEvent } from "./lib/events.js";
import { parsePersona, recordPersonaVersion } from "./persona/loader.js";
import { activeSoul, createSoul } from "./souls/souls.js";

/**
 * Idempotent boot step shared by web, worker and CLI.
 *
 *  1. Influencer #1 inherits the v0 single-persona setup: when its persona is
 *     still empty it is filled from PERSONA_PATH / KNOWLEDGE_PATH and named
 *     after the persona. From then on the database is the source of truth
 *     (edit it in the console); set PERSONA_SYNC_FROM_FILE=true to keep
 *     overwriting it from the file on every boot instead.
 *  2. Every influencer with reference images in its persona but no soul gets
 *     one (soul_<slug>_v1) so identity references are first-class, owned and
 *     versioned.
 *  3. The generation catalog and the platform routing policy are synced.
 *  4. INSTAGRAM_ACCOUNT_ID / INSTAGRAM_ACCESS_TOKEN seed influencer #1's account.
 */
export async function bootstrap(): Promise<{ influencer: string; soul?: string; models: number }> {
  const e = env();
  const first = await one<{ id: number; slug: string; persona_yaml: string; knowledge_yaml: string }>(
    "SELECT id, slug, persona_yaml, knowledge_yaml FROM influencers WHERE id = 1",
  );
  if (!first) throw new Error("influencer #1 missing: migrations did not run");

  const personaPath = resolve(e.PERSONA_PATH);
  const sync = process.env.PERSONA_SYNC_FROM_FILE === "true";
  if ((!first.persona_yaml.trim() || sync) && existsSync(personaPath)) {
    const source = readFileSync(personaPath, "utf8");
    if (sha256(source) !== sha256(first.persona_yaml)) {
      const p = parsePersona(source); // throws with a readable message when invalid
      const knowledgePath = resolve(e.KNOWLEDGE_PATH);
      const knowledge = existsSync(knowledgePath) ? readFileSync(knowledgePath, "utf8") : first.knowledge_yaml;
      parseKnowledge(knowledge);
      const wanted = slugify(p.identity.name);
      const taken = await one("SELECT 1 FROM influencers WHERE slug = $1 AND id <> 1", [wanted]);
      const slug = first.slug === "default" && !taken ? wanted : first.slug;
      await one(
        `UPDATE influencers SET name = $2, slug = $3, persona_yaml = $4, knowledge_yaml = $5,
           avatar_url = coalesce(avatar_url, $6), updated_at = now() WHERE id = $1`,
        [1, p.identity.name, slug, source, knowledge, p.visual.character.reference_images[0] ?? null],
      );
      invalidateInfluencer(1);
      await recordPersonaVersion(1, source);
      await recordEvent("info", "boot", `Influencer #1 persona ${first.persona_yaml.trim() ? "re-synced" : "imported"} from ${e.PERSONA_PATH}`, { slug });
    }
  }

  // Souls for every influencer that has references but no soul yet.
  let soulId: string | undefined;
  const rows = await one<{ ids: number[] }>("SELECT coalesce(array_agg(id ORDER BY id), '{}') AS ids FROM influencers WHERE persona_yaml <> '' AND status <> 'archived'");
  for (const id of (rows?.ids ?? []).map(Number)) {
    const existing = await activeSoul(id);
    if (existing) {
      if (id === 1) soulId = existing.soul.soul_id;
      continue;
    }
    const src = await one<{ persona_yaml: string }>("SELECT persona_yaml FROM influencers WHERE id = $1", [id]);
    const refs = parsePersona(src!.persona_yaml).visual.character.reference_images;
    if (!refs.length) continue;
    const soul = await createSoul({ influencerId: id, identityRefs: refs, description: "Imported from persona reference images" });
    if (id === 1) soulId = soul.soul_id;
    await recordEvent("info", "boot", `Created ${soul.soul_id} from persona references`, { influencerId: id, refs: refs.length });
  }

  const { models } = await syncCatalog();
  await ensureDefaultPolicy();
  await seedAccountFromEnv(1);
  const slug = (await one<{ slug: string }>("SELECT slug FROM influencers WHERE id = 1"))!.slug;
  return { influencer: slug, soul: soulId, models };
}
