import { describe, expect, it } from "vitest";
import { captionProblems, fitCaption, sentences, tidyCaption } from "../../src/content/caption.js";

// Real captions from @zurikarale that motivated these rules.
const ROOFTOP =
  "Some days don't need a plan. Just a rooftop, cooling coffee, and a clean pair doing their job quietly. Kampala's doing that gold-to-grey thing again and I'm not mad about it. Rotation's been solid this week - low-tops earning their keep. What's holding down your rotation right now?";
const NIGHT = "Some nights the wifi is bad, the timeline is boring, and I just end up staring at the shelf like it owes me answers. Rotation check turned into a whole mood. Which pair would you grab for a night like this?";

describe("caption quality rules", () => {
  it("rejects the old paragraph-style captions with specific, actionable reasons", () => {
    const p = captionProblems(ROOFTOP, { educational: false, recent: [] });
    expect(p.join(" | ")).toMatch(/too long/);
    expect(p.join(" | ")).toMatch(/5 sentences/);
    expect(p.join(" | ")).toMatch(/doing its thing/);
    expect(p.join(" | ")).toMatch(/not mad about it/);
    expect(p.join(" | ")).toMatch(/earning their keep/);
    expect(p.join(" | ")).toMatch(/Some days\/nights/);
    expect(captionProblems(NIGHT, { educational: false, recent: [] }).join(" | ")).toMatch(/owes me.*|rotation check/);
  });

  it("accepts short, simple captions", () => {
    for (const ok of ["golden hour > everything", "new laces, same me", "Sunday reset. Coffee first, decisions later ☕️", "which one tomorrow?"]) {
      expect(captionProblems(ok, { educational: false, recent: [] }), ok).toEqual([]);
    }
  });

  it("refuses a repeated opening and a third question in a row", () => {
    expect(captionProblems("Coffee first, then the city.", { educational: false, recent: ["Coffee first, decisions later"] })[0]).toMatch(/same opening/);
    expect(captionProblems("which one?", { educational: false, recent: ["this or that?", "left or right?", "calm day."] })[0]).toMatch(/ended with a question/);
    expect(captionProblems("which one?", { educational: false, recent: ["calm day.", "this or that?"] })).toEqual([]);
  });

  it("gives educational carousels a bit more room", () => {
    const edu = "3 ways to keep white pairs clean\n1. Brush dry dirt first\n2. Mild soap, never bleach\n3. Air dry, no sun";
    expect(captionProblems(edu, { educational: true, recent: [] })).toEqual([]);
    expect(captionProblems(edu, { educational: false, recent: [] }).join()).toMatch(/sentences/);
  });

  it("lays captions out one line per sentence and trims at a sentence boundary as a last resort", () => {
    expect(tidyCaption("New laces, same me.   Tomorrow we run.", false)).toBe("New laces, same me.\nTomorrow we run.");
    const t = tidyCaption(ROOFTOP, false);
    expect(t).toBe("Some days don't need a plan.\nJust a rooftop, cooling coffee, and a clean pair doing their job quietly.");
    expect([...t].length).toBeLessThanOrEqual(150);
    expect(sentences("a. #tag b!")).toEqual(["a.", "b!"]);
    expect(fitCaption("New laces, same me.", ["#sneakers"], { hashtags: { always: [], pool: [], max: 3 } })).toBe("New laces, same me.\n\n#sneakers");
  });
});
