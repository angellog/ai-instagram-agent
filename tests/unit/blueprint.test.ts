import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { personaChecks } from "../../src/influencers/standard.js";
import { parsePersona } from "../../src/persona/parse.js";

/**
 * Zuri is the blueprint. Any field she has is standard for every influencer:
 * the hatch template must carry it (so new influencers are born with it) and
 * she must pass every Standard check (so existing ones are measured on it).
 */

/** Every field path in a YAML document; list items collapse to "[]". */
function paths(v: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(v)) {
    for (const item of v) for (const p of paths(item, `${prefix}[]`)) out.add(p);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      for (const q of paths(x, p)) out.add(q);
    }
  }
  return out;
}

const zuri = parse(readFileSync("config/persona.yaml", "utf8"));
const template = parse(readFileSync("config/persona.template.yaml", "utf8"));

describe("Zuri is the blueprint", () => {
  it("every field Zuri has is in the hatch template, so new influencers are born with it", () => {
    const missing = [...paths(zuri)].filter((p) => !paths(template).has(p));
    expect(missing, `Zuri has fields the template lacks: add them to config/persona.template.yaml (and a Standard check if existing influencers need them)`).toEqual([]);
  });

  it("Zuri passes every Standard persona check, so the standard is what she already is", () => {
    const failing = personaChecks(parsePersona(readFileSync("config/persona.yaml", "utf8"))).filter((c) => !c.ok);
    expect(failing.map((c) => `${c.label}: ${c.detail}`)).toEqual([]);
  });
});
