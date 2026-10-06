import { describe, expect, it } from "vitest";
import { overlaySvg, renderOverlayPng, STORY, STORY_STYLES } from "../../src/render/compose.js";

const brand = { primary: "#E2725B", text: "#FFFFFF", shadow: "#000000" };

describe("story text styles", () => {
  it("renders every style with and without a second line", () => {
    for (const style of STORY_STYLES) {
      for (const body of [undefined, "Pioneer Mall, Level 5, Shop PH-100"]) {
        const png = renderOverlayPng({ kind: "story", heading: "Sunday reset, skin first", body, style, seed: 42 }, brand, STORY);
        expect(png.length, `${style}`).toBeGreaterThan(1000);
      }
    }
  });

  it("uses the handwriting and marker fonts and draws stickers as shapes, not emoji", () => {
    expect(overlaySvg({ kind: "story", heading: "hi", style: "script", seed: 1 }, brand, STORY)).toContain('font-family="Pacifico"');
    expect(overlaySvg({ kind: "story", heading: "hi", style: "marker", seed: 1 }, brand, STORY)).toContain('font-family="Permanent Marker"');
    expect(overlaySvg({ kind: "story", heading: "hi", style: "marker", seed: 1 }, brand, STORY)).toMatch(/<g transform="translate\(/);
  });

  it("keeps the words inside the band Instagram doesn't cover", () => {
    for (const style of STORY_STYLES.filter((s) => s !== "panel")) {
      for (let seed = 1; seed < 40; seed++) {
        const ys = [...overlaySvg({ kind: "story", heading: "Sunday reset, skin first", style, seed }, brand, STORY).matchAll(/<text[^>]* y="(\d+)"/g)].map((m) => Number(m[1]));
        for (const y of ys) {
          expect(y, `${style} seed ${seed}`).toBeGreaterThan(1920 * 0.14);
          expect(y, `${style} seed ${seed}`).toBeLessThan(1920 * 0.82);
        }
      }
    }
  });
});
