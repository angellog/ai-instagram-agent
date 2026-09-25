import { parse } from "yaml";
import { personaSchema, type Persona } from "./schema.js";

/** Parse + validate persona YAML, including cross-references the schema can't express. */
export function parsePersona(source: string): Persona {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (e) {
    throw new Error(`Invalid persona: YAML syntax: ${(e as Error).message.split("\n")[0]}`);
  }
  const parsed = personaSchema.safeParse(raw);
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
  try {
    new Intl.DateTimeFormat("en", { timeZone: p.identity.timezone });
  } catch {
    throw new Error(`Invalid persona: unknown timezone "${p.identity.timezone}"`);
  }
  return p;
}
