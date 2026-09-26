import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { normalizeDay, normalizeSlot, parsePersona } from "../../src/persona/parse.js";

/**
 * Regression: Kemigisha Cynthiana's persona draft was rejected twice because the
 * compose prompt asked for "early_morning"/"midday" slots the schema doesn't have.
 */
const base = () => parse(readFileSync("config/persona.yaml", "utf8")) as Record<string, any>;

describe("persona spelling forgiveness", () => {
  it("maps near-miss slots and weekday spellings", () => {
    expect(["early_morning", "Midday", "noon", "late-afternoon", "Late Night", "evening"].map(normalizeSlot)).toEqual(["morning", "lunch", "lunch", "afternoon", "night", "evening"]);
    expect(["Sun", "Sundays", "FRIDAY", "tue"].map(normalizeDay)).toEqual(["sunday", "sunday", "friday", "tuesday"]);
    expect(normalizeSlot("brunchtime")).toBe("brunchtime"); // unknown stays unknown
  });

  it("accepts a model draft that uses those spellings and stores the canonical ones", () => {
    const p = base();
    p.daily_life.activities[0].slot = "early_morning";
    p.daily_life.activities[1].slot = "midday";
    p.daily_life.activities[2].days = ["Sundays"];
    p.visual.locations[0].slots = ["early_morning", "morning", "midday"];
    p.visual.character.closet.occasions[0].days = ["Sun"];
    const parsed = parsePersona(stringify(p));
    expect(parsed.daily_life.activities[0].slot).toBe("morning");
    expect(parsed.daily_life.activities[1].slot).toBe("lunch");
    expect(parsed.daily_life.activities[2].days).toEqual(["sunday"]);
    expect(parsed.visual.locations[0].slots).toEqual(["morning", "lunch"]);
    expect(parsed.visual.character.closet.occasions[0].days).toEqual(["sunday"]);
  });

  it("still rejects values it can't place, with a readable path", () => {
    const p = base();
    p.daily_life.activities[5].slot = "whenever";
    expect(() => parsePersona(stringify(p))).toThrow(/daily_life\.activities\.5\.slot/);
  });
});
