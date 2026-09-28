import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { knowledgeChecks, mergeSections, personaChecks, structureExamples } from "../../src/influencers/standard.js";
import { parsePersona } from "../../src/persona/parse.js";
import { thinPersona } from "../helpers/personas.js";

const ref = readFileSync("config/persona.yaml", "utf8");

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

  it("repairs the shape slips that sank Paresh's first upgrade (objects where plain lists belong)", () => {
    const sent = stringify({
      "visual.character.wardrobe": { casual: { outfit: "white tee with olive chinos" }, smart: "navy linen shirt with cream trousers" },
      weekend_ideas: [{ idea: "Saturday football fit" }, { title: "Sunday reset" }, "market run haul"],
      "visual.character.closet": { tops: [{ name: "white tee" }, "black tee"], bottoms: ["jeans"], layers: [], one_pieces: [], activewear: ["track set"], occasions: [] },
    });
    const merged = parse(mergeSections(thinPersona(), sent, ["visual.character.wardrobe", "weekend_ideas", "visual.character.closet"])) as any;
    expect(merged.visual.character.wardrobe).toEqual(["white tee with olive chinos", "navy linen shirt with cream trousers"]);
    expect(merged.weekend_ideas).toEqual(["Saturday football fit", "Sunday reset", "market run haul"]);
    expect(merged.visual.character.closet.tops).toEqual(["white tee", "black tee"]);
  });

  it("shows the model the exact structure of each section it must write", () => {
    const ex = parse(structureExamples(["visual.character.wardrobe", "daily_life.activities"])) as any;
    expect(typeof ex["visual.character.wardrobe"][0]).toBe("string");
    expect(ex["visual.character.wardrobe"]).toHaveLength(2);
    expect(ex["daily_life.activities"][0]).toHaveProperty("slot");
  });
});
