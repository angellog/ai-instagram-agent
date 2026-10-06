import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { localeLines, placeKind } from "../../src/content/locale.js";
import { slidePrompt } from "../../src/content/visual.js";
import { parsePersona } from "../../src/persona/parse.js";

function kemi() {
  const p = parse(readFileSync("config/persona.yaml", "utf8")) as any;
  p.identity = { ...p.identity, name: "Kemigisha", location: "Kampala, Uganda" };
  p.visual.character.skin_tone = "smooth dark";
  p.visual.locations.push({ id: "see-me-studio", description: "the See-Me Cosmetics studio and shop in a Kampala mall, shelves lined with shea butter jars", slots: ["afternoon"] });
  p.brand = { name: "See-Me Cosmetics", category: "shea butter skincare", products: ["whipped shea body cream in a glass jar"], natural_moments: ["a", "b", "c", "d"], curiosity_hooks: [], mention_rate: 0.2 };
  return parsePersona(stringify(p));
}
const slide = (include_character: boolean) => ({ role: "cover" as const, shot: "pouring tea", composition: "detail" as const, include_character, overlay_kind: "none" as const, overlay_heading: "", overlay_body: "", alt_text: "x" });

describe("local realism", () => {
  it("classifies places by what they really are", () => {
    expect(placeKind("see-me-studio", "the See-Me Cosmetics studio and shop in a Kampala mall")).toBe("shop");
    expect(placeKind("ag-gadgets", "a modern phone shop in Kisaasi")).toBe("shop");
    expect(placeKind("acacia-mall", "inside Acacia Mall, Kampala, near electronics stores")).toBe("mall");
    expect(placeKind("apartment", "a bright minimalist apartment in Kisaasi")).toBe("home");
    expect(placeKind("kololo-cafe", "a sunlit specialty coffee shop in Kololo")).toBe("cafe");
  });

  it("gives hands-only shots her own skin and a Kampala home, never a default", () => {
    const p = kemi();
    const text = slidePrompt(p, { format: "story" }, slide(false), { location_id: "apartment" }, 0, 1);
    expect(text).toContain("Setting: Kampala, Uganda");
    expect(text).toContain("Any hands, arms or feet in frame belong to Kemigisha: smooth dark skin");
    expect(text).toMatch(/tiled|burglar/);
    expect(text).toContain("no Western suburban interiors");
  });

  it("makes a shop read as a business stocked with the brand, not a home", () => {
    const p = kemi();
    const lines = localeLines(p, p.visual.locations.find((l) => l.id === "see-me-studio"), true).join("\n");
    expect(lines).toContain("clearly a business and not a home");
    expect(lines).toContain("The stock on display is See-Me Cosmetics's: shea butter skincare");
  });

  it("prefers the place's own look when the persona has one", () => {
    const p = kemi();
    const lines = localeLines(p, p.visual.locations.find((l) => l.id === "pioneer-mall"), true).join("\n");
    expect(lines).toContain("FeetBit's unit has glass shelves and a wall of sneakers");
  });
});
