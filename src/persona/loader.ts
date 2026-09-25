import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { currentInfluencer } from "../context.js";
import { one } from "../db/pool.js";
import { sha256 } from "../lib/crypto.js";
import { parsePersona } from "./parse.js";
import type { Persona } from "./schema.js";

export { parsePersona } from "./parse.js";

export interface LoadedPersona {
  persona: Persona;
  hash: string;
  source: string;
}

/** A persona file on disk (bootstrap of the first influencer, CLI validation, tests). */
export function loadPersonaFromFile(path = process.env.PERSONA_PATH ?? "config/persona.yaml"): LoadedPersona {
  const source = readFileSync(resolve(path), "utf8");
  return { persona: parsePersona(source), hash: sha256(source).slice(0, 16), source };
}

/** The persona of the influencer this code is running for. */
export function persona(): Persona {
  return currentInfluencer().persona;
}

export function personaInfo(): LoadedPersona {
  const c = currentInfluencer();
  return { persona: c.persona, hash: c.personaHash, source: c.personaYaml };
}

/** Record the persona version so every decision can be traced to it. */
export async function recordPersonaVersion(influencerId: number, source: string): Promise<string> {
  const p = parsePersona(source);
  const hash = sha256(source).slice(0, 16);
  await one(
    `INSERT INTO persona_versions (influencer_id, hash, name, source_yaml, parsed) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (influencer_id, hash) DO NOTHING`,
    [influencerId, hash, p.identity.name, source, JSON.stringify(p)],
  );
  return hash;
}
