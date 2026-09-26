import { describe, expect, it } from "vitest";
import { planActivities } from "../../src/content/activities.js";
import type { RecentItem } from "../../src/content/history.js";
import { enforceOutfit, outfits, planOutfits } from "../../src/content/wardrobe.js";
import { loadPersonaFromFile, parsePersona } from "../../src/persona/loader.js";
import { googleNewsUrl, parseFeed } from "../../src/trends/feeds.js";

const zuri = loadPersonaFromFile("config/persona.yaml");
const p = zuri.persona;
const post = (day: string, outfit: string): RecentItem =>
  ({ postId: day, ideaId: 1, status: "published", format: "single", structure: "moment", topic: "t", hook: "h", caption: "c", visual: { local_day: day, outfit }, createdAt: new Date(), publishedAt: new Date() }) as RecentItem;

describe("closet: remix separates like a real person", () => {
  it("has at least triple the old 16 outfits, mostly remixes of owned pieces", () => {
    const all = outfits(p);
    expect(all.length).toBeGreaterThanOrEqual(48);
    expect(all.filter((o) => o.kind === "remix").length).toBeGreaterThan(90);
    expect(all.some((o) => o.text === "rust-orange ribbed tank top with black slip midi skirt" && o.pieces.length === 2)).toBe(true);
  });

  it("rests a piece for two days, then brings it back in a NEW combination (the remix trick)", () => {
    const yesterday = "white fitted baby tee with black straight-leg jeans";
    const plan = planOutfits(p, "2026-10-02", [post("2026-10-01", yesterday)]);
    expect(plan.everyday).not.toContain("white fitted baby tee");
    expect(plan.everyday).not.toContain("black straight-leg jeans");
    // Find a day where the rotation re-uses a piece in a different look; it is labelled as a remix.
    let remix;
    for (let d = 5; d < 30 && !remix; d++) {
      const day = `2026-10-${String(d).padStart(2, "0")}`;
      remix = planOutfits(p, day, [post("2026-10-01", yesterday)]).remix;
    }
    expect(remix).toMatchObject({ lastWith: yesterday, day: "2026-10-01" });
  });

  it("never plans the same exact look within the 21-day cooldown, over a month", () => {
    const recent: RecentItem[] = [];
    for (let d = 1; d <= 30; d++) {
      const day = `2026-11-${String(d).padStart(2, "0")}`;
      const o = planOutfits(p, day, recent).everyday;
      expect(recent.filter((r) => r.visual.outfit === o && d - Number(r.visual.local_day!.slice(8)) <= 21), `${day}: ${o}`).toHaveLength(0);
      recent.unshift(post(day, o));
    }
  });

  it("puts on occasion wear for the right day and activity (church on Sunday)", () => {
    const sunday = planOutfits(p, "2026-09-27", []); // a Sunday
    expect(sunday.occasions.map((o) => o.occasion)).toContain("Sunday church service");
    expect(enforceOutfit("white fitted baby tee with olive cargo trousers", "Sunday church service", sunday)).toMatchObject({ outfit: expect.stringContaining("floral midi dress") });
    // Not on a Monday, and a weekday brunch post keeps the everyday look.
    expect(planOutfits(p, "2026-09-28", []).occasions.map((o) => o.occasion)).not.toContain("Sunday church service");
    // Calendar events trigger occasions too.
    const wedding = planOutfits(p, "2026-09-29", [], { events: ["Sarah's wedding reception"] });
    expect(enforceOutfit(undefined, "evening out", wedding, "at the wedding tonight")).toMatchObject({ outfit: expect.stringContaining("satin emerald") });
  });

  it("works for a Muslim influencer's Jumu'ah and Eid wear", () => {
    const amina = parsePersona(
      zuri.source
        .replace("name: Zuri", "name: Amina")
        .replace(/    occasions:[\s\S]*?    signature_accessories/, `    occasions:\n        - { occasion: "Jumu'ah prayers", days: [friday], keywords: [jumuah, "jumu'ah", mosque, friday prayers], outfit: "navy abaya with a soft grey hijab" }\n        - { occasion: Eid, keywords: [eid], outfit: "embroidered emerald abaya with a gold-trim hijab" }\n    signature_accessories`),
    );
    const friday = planOutfits(amina, "2026-10-02", []);
    expect(enforceOutfit(undefined, "Jumu'ah prayers at the mosque", friday)).toMatchObject({ outfit: "navy abaya with a soft grey hijab" });
    const eid = planOutfits(amina, "2026-10-05", [], { events: ["Eid al-Adha"] });
    expect(enforceOutfit(undefined, "family lunch", eid, "Eid lunch with family")).toMatchObject({ outfit: expect.stringContaining("embroidered emerald abaya") });
  });
});

describe("weekends", () => {
  it("plans weekend and day-specific activities only on their days", () => {
    const acts = (day: string, weekday: number) => planActivities(p, day, weekday).map((a) => a.activity);
    const sundays = Array.from({ length: 8 }, (_, i) => acts(`2026-10-${10 + i}`, 0)).flat();
    const mondays = Array.from({ length: 8 }, (_, i) => acts(`2026-11-${10 + i}`, 1)).flat();
    expect(sundays).toContain("Sunday church service");
    expect(mondays).not.toContain("Sunday church service");
    expect(mondays).not.toContain("weekend brunch with friends");
    expect(sundays).not.toContain("Saturday market run for fresh fruit and finds");
    expect(p.weekend_ideas.length).toBeGreaterThanOrEqual(5);
  });
});

describe("news feeds", () => {
  it("reads Google News RSS (with source), plain RSS with CDATA, and Atom", () => {
    const rss = `<rss><channel><title>Google News</title><item><title>New Jordan 4 colourway drops this week - SneakerNews</title><link>https://news.google.com/articles/abc</link><pubDate>Fri, 25 Sep 2026 10:00:00 GMT</pubDate><source url="https://sneakernews.com">Sneaker News</source></item></channel></rss>`;
    expect(parseFeed(rss, "x")).toEqual([{ title: "New Jordan 4 colourway drops this week - SneakerNews", link: "https://news.google.com/articles/abc", source: "Sneaker News", publishedAt: new Date("2026-09-25T10:00:00Z") }]);
    const cdata = `<rss><channel><title>Hypebeast</title><item><title><![CDATA[Kampala &amp; Nairobi pop-ups]]></title><link>https://hb.com/a</link></item></channel></rss>`;
    expect(parseFeed(cdata, "x")[0]).toMatchObject({ title: "Kampala & Nairobi pop-ups", source: "Hypebeast", publishedAt: null });
    const atom = `<feed><title>Blog</title><entry><title>Trend report</title><link href="https://b.com/t"/><updated>2026-09-24T08:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom, "x")[0]).toMatchObject({ title: "Trend report", link: "https://b.com/t", source: "Blog" });
    expect(googleNewsUrl("Kampala events", "ug", "en")).toBe("https://news.google.com/rss/search?q=Kampala%20events%20when%3A3d&hl=en-UG&gl=UG&ceid=UG:en");
  });
});
