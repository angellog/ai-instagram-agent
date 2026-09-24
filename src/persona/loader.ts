import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { env } from "../config/env.js";
import { sha256 } from "../lib/crypto.js";
import { one } from "../db/pool.js";
import { personaSchema, type Persona } from "./schema.js";

export interface LoadedPersona {
  persona: Persona;
  hash: string;
  source: string;
}

let cached: LoadedPersona | undefined;

export function parsePersona(source: string): Persona {
  const parsed = personaSchema.safeParse(parse(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid persona: ${issues}`);
  }
  const p = parsed.data;
  if (p.carousel.min_slides > p.carousel.max_slides) throw new Error("Invalid persona: carousel.min_slides > max_slides");
  const locIds = new Set(p.visual.locations.map((l) => l.id));
  for (const a of p.daily_life.activities) {
    for (const l of a.locations) {
      if (!locIds.has(l)) throw new Error(`Invalid persona: activity "${a.activity}" references unknown location "${l}"`);
    }
  }
  return p;
}

export function loadPersonaFromFile(path = env().PERSONA_PATH): LoadedPersona {
  const source = readFileSync(resolve(path), "utf8");
  return { persona: parsePersona(source), hash: sha256(source).slice(0, 16), source };
}

/** The active persona. Loaded once per process; `reloadPersona` re-reads it. */
export function persona(): Persona {
  cached ??= loadPersonaFromFile();
  return cached.persona;
}

export function personaInfo(): LoadedPersona {
  cached ??= loadPersonaFromFile();
  return cached;
}

export function setPersona(p: LoadedPersona): void {
  cached = p;
}

export function reloadPersona(): LoadedPersona {
  cached = loadPersonaFromFile();
  return cached;
}

/** Record the persona version in the DB so every decision can be traced to it. */
export async function recordPersonaVersion(p: LoadedPersona = personaInfo()): Promise<void> {
  await one(
    `INSERT INTO persona_versions (hash, name, source_yaml, parsed) VALUES ($1, $2, $3, $4)
     ON CONFLICT (hash) DO NOTHING`,
    [p.hash, p.persona.identity.name, p.source, JSON.stringify(p.persona)],
  );
}
