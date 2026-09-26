import { parse } from "yaml";
import { personaSchema, SLOTS, type Persona } from "./schema.js";

const SLOT_ALIASES: Record<string, string> = {
  early_morning: "morning", dawn: "morning", sunrise: "morning", breakfast: "morning",
  mid_morning: "late_morning", midmorning: "late_morning", brunch: "late_morning",
  midday: "lunch", noon: "lunch", lunchtime: "lunch", early_afternoon: "afternoon", late_afternoon: "afternoon",
  dusk: "evening", sunset: "evening", early_evening: "evening", late_evening: "night", late_night: "night", midnight: "night",
};
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** Map near-miss slot names ("early_morning", "Midday") onto the schema's slots; unknown values are left for the validator to report. */
export function normalizeSlot(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (SLOTS as string[]).includes(k) ? k : (SLOT_ALIASES[k] ?? v);
}
/** "Sun", "Sunday", "SUNDAYS" → "sunday". */
export function normalizeDay(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase();
  return DAYS.find((d) => k === d || k === `${d}s` || (k.length >= 3 && d.startsWith(k))) ?? v;
}

/** Forgive the spellings models (and people) commonly use before strict validation. */
function normalize(raw: unknown): unknown {
  const o = raw as { visual?: { locations?: unknown; character?: { closet?: { occasions?: unknown } } }; daily_life?: { activities?: unknown } } | null;
  if (!o || typeof o !== "object") return raw;
  const days = (x: { days?: unknown }) => {
    if (Array.isArray(x.days)) x.days = x.days.map(normalizeDay);
  };
  if (Array.isArray(o.visual?.locations)) for (const l of o.visual.locations as Array<{ slots?: unknown }>) if (l && Array.isArray(l.slots)) l.slots = [...new Set(l.slots.map(normalizeSlot))];
  if (Array.isArray(o.daily_life?.activities))
    for (const a of o.daily_life.activities as Array<{ slot?: unknown; days?: unknown }>) {
      if (!a) continue;
      a.slot = normalizeSlot(a.slot);
      days(a);
    }
  const occ = o.visual?.character?.closet?.occasions;
  if (Array.isArray(occ)) for (const x of occ as Array<{ days?: unknown }>) if (x) days(x);
  return raw;
}

/** Parse + validate persona YAML, including cross-references the schema can't express. */
export function parsePersona(source: string): Persona {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (e) {
    throw new Error(`Invalid persona: YAML syntax: ${(e as Error).message.split("\n")[0]}`);
  }
  const parsed = personaSchema.safeParse(normalize(raw));
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
