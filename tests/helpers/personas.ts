import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";

const ref = readFileSync("config/persona.yaml", "utf8");

/** Zuri's persona with a thin closet and no weekend life: what an older or rushed hatch looks like. */
export function thinPersona(): string {
  const p = parse(ref) as any;
  p.visual.character.closet = { tops: ["white tee", "black tank", "grey hoodie", "denim shirt"], bottoms: ["blue jeans", "black joggers"], layers: [], one_pieces: [], activewear: ["black set"], occasions: [] };
  p.daily_life.activities = p.daily_life.activities.filter((a: any) => !a.weekends_only && !(a.days ?? []).length).slice(0, 6);
  p.weekend_ideas = [];
  return stringify(p);
}

