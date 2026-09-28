import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { knowledgeChecks, mergeSections, personaChecks } from "../../src/influencers/standard.js";
import { parsePersona } from "../../src/persona/parse.js";

const ref = readFileSync("config/persona.yaml", "utf8");

/** Zuri's persona with a thin closet and no weekend life: what an older or rushed hatch looks like. */
export function thinPersona(): string {
  const p = parse(ref) as any;
  p.visual.character.closet = { tops: ["white tee", "black tank", "grey hoodie", "denim shirt"], bottoms: ["blue jeans", "black joggers"], layers: [], one_pieces: [], activewear: ["black set"], occasions: [] };
  p.daily_life.activities = p.daily_life.activities.filter((a: any) => !a.weekends_only && !(a.days ?? []).length).slice(0, 6);
  p.weekend_ideas = [];
  return stringify(p);
}

describe("the influencer standard", () => {
  it("Zuri meets every persona check", () => {
    const failing = personaChecks(parsePersona(ref)).filter((c) => !c.ok);
    expect(failing).toEqual([]);
  });

  it("names exactly what a thin persona is missing", () => {
    const failing = personaChecks(parsePersona(thinPersona())).filter((c) => !c.ok).map((c) => c.key);
    expect(failing).toEqual(expect.arrayContaining(["closet", "occasions", "weekend", "weekend_ideas"]));
    const closet = personaChecks(parsePersona(thinPersona())).find((c) => c.key === "closet")!;
    expect(closet.detail).toMatch(/4 tops \(standard 10\)/);
  });

  it("merges only the requested sections and leaves the rest alone", () => {
    const merged = parse(mergeSections(thinPersona(), stringify({ "visual.character.closet": { tops: ["a"], bottoms: ["b"] }, weekend_ideas: ["x"] }), ["visual.character.closet", "weekend_ideas"])) as any;
    expect(merged.visual.character.closet).toEqual({ tops: ["a"], bottoms: ["b"] });
    expect(merged.weekend_ideas).toEqual(["x"]);
    expect(merged.identity.name).toBe("Zuri");
    expect(merged.visual.character.wardrobe.length).toBeGreaterThan(5);
    expect(() => mergeSections(ref, stringify({ weekend_ideas: ["x"] }), ["trends"])).toThrow(/missing section trends/);
  });

  it("asks for real business facts only when the influencer is affiliated with a brand", () => {
    const p = parsePersona(ref);
    const facts = (kb: any[]) => knowledgeChecks(p, kb).find((c) => c.key === "kb_facts")!;
    expect(facts([]).ok).toBe(!p.identity.affiliation || /independent/i.test(p.identity.affiliation));
    const affiliated = { ...p, identity: { ...p.identity, affiliation: "See-Me Cosmetics" } };
    expect(knowledgeChecks(affiliated, []).find((c) => c.key === "kb_facts")).toMatchObject({ ok: false, fix: "manual" });
    expect(knowledgeChecks(affiliated, [{ id: "store", keywords: ["shop"], content: "x", must_include: ["x"] }]).find((c) => c.key === "kb_facts")!.ok).toBe(true);
  });
});
