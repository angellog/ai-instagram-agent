import { describe, expect, it } from "vitest";
import { cooldownDays, enforceOutfit, planOutfits, wardrobe } from "../../src/content/wardrobe.js";
import type { RecentItem } from "../../src/content/history.js";
import { loadPersonaFromFile } from "../../src/persona/loader.js";

const p = loadPersonaFromFile("config/persona.yaml").persona;
const HOODIE = "plain black cropped zip hoodie with black wide-leg track pants";
const post = (day: string, outfit: string): RecentItem =>
  ({ postId: day, ideaId: 1, status: "published", format: "single", structure: "moment", topic: "t", hook: "h", caption: "c", visual: { local_day: day, outfit }, createdAt: new Date(), publishedAt: new Date() }) as RecentItem;

describe("wardrobe rotation", () => {
  it("draws from staples plus the closet", () => {
    expect(wardrobe(p).length).toBeGreaterThanOrEqual(14);
    expect(cooldownDays(16)).toBe(14);
    expect(cooldownDays(500)).toBe(21);
    expect(cooldownDays(3)).toBe(1);
  });

  it("never plans an outfit worn in the cooldown window, and is deterministic", () => {
    const recent = [post("2026-09-25", HOODIE), post("2026-09-24", "white fitted baby tee with olive cargo trousers")];
    const a = planOutfits(p, "2026-09-26", recent);
    expect(a.everyday).not.toBe(HOODIE);
    expect(a.everyday).not.toMatch(/baby tee/);
    expect(planOutfits(p, "2026-09-26", recent).everyday).toBe(a.everyday);
    expect(a.avoid.map((w) => w.day)).toEqual(["2026-09-25", "2026-09-24"]);
  });

  it("keeps the same outfit within a day", () => {
    const recent = [post("2026-09-26", "rust-orange ribbed tank top with cream wide-leg linen trousers"), post("2026-09-25", HOODIE)];
    expect(planOutfits(p, "2026-09-26", recent).everyday).toMatch(/rust-orange/);
  });

  it("rotates the day's outfits over a week without repeats", () => {
    const recent: RecentItem[] = [];
    const seen: string[] = [];
    for (let d = 1; d <= 7; d++) {
      const day = `2026-10-0${d}`;
      const o = planOutfits(p, day, recent).everyday;
      seen.push(o);
      recent.unshift(post(day, o));
    }
    expect(new Set(seen).size).toBe(7);
  });

  it("the director may choose, but not a recent repeat or the wrong kind of outfit", () => {
    const plan = planOutfits(p, "2026-09-26", [post("2026-09-25", HOODIE)]);
    expect(enforceOutfit(HOODIE, "rotation check at home", plan)).toMatchObject({ outfit: plan.everyday, adjustment: expect.stringContaining("worn on 2026-09-25") });
    expect(enforceOutfit("sage green linen button-up shirt with beige tailored shorts", "brunch", plan)).toEqual({ outfit: "sage green linen button-up shirt with beige tailored shorts" });
    expect(enforceOutfit("sage green linen button-up shirt", "morning run at Kololo airstrip", plan).adjustment).toBe("workout needs activewear");
  });
});
