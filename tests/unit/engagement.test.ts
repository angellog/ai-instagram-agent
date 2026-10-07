import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commentProblems } from "../../src/engagement/scout.js";
import { footballNews, pickLines, shortFormBlock } from "../../src/engagement/shortform.js";
import { coerceShapes, personaChecks, shortForm } from "../../src/influencers/standard.js";
import { parsePersona } from "../../src/persona/parse.js";

const yaml = readFileSync("config/persona.yaml", "utf8");
const zuri = parsePersona(yaml);

describe("drafted comments", () => {
  it("are one specific line: no links, tags, hashtags, brand or generic praise", () => {
    expect(commentProblems("the Kololo airstrip at 6am is a different planet, respect for the early start", zuri)).toBeUndefined();
    expect(commentProblems("check https://x.co", zuri)).toBe("has a link");
    expect(commentProblems("so good @feetbit.sneakers", zuri)).toBe("has a tag or hashtag");
    expect(commentProblems("these look like FeetBit pairs", zuri)).toBe("names the brand");
    expect(commentProblems("Nice! 🔥", zuri)).toBe("generic");
    expect(commentProblems("x".repeat(200), zuri)).toBe("too long");
  });
});

describe("short-form material", () => {
  it("gives the planner today's lines, the club and the playful-only rule", () => {
    const block = shortFormBlock(zuri, { day: "2026-10-08", recent: [], trends: "Arsenal beat Tottenham in the north London derby", kind: "reel" });
    expect(block).toMatch(/kind "talk"/);
    expect(block).toMatch(/Your club: Arsenal \(Premier League\); rivals: Tottenham, Chelsea, Manchester United\. There's football news/);
    expect(block).toMatch(/never romantic or sexual/);
    expect(footballNews(zuri, "Chelsea sign a striker")).toBe(true);
    expect(footballNews(zuri, "Ugandan TikTok trend")).toBe(false);
  });

  it("doesn't offer a line that was just used", () => {
    const lines = ["alpha question here", "beta question here", "gamma question here"];
    const pick = pickLines(lines, ["caption: alpha question here?"], "seed", 2);
    expect(pick).not.toContain("alpha question here");
  });

  it("is a Standard check: football banter needs a club, and Zuri passes", () => {
    expect(shortForm(zuri).ok).toBe(true);
    const noClub = parsePersona(yaml.replace(/\n  football: \{[^\n]*\}/, "\n  football: null"));
    expect(shortForm(noClub)).toMatchObject({ ok: false, detail: expect.stringContaining("football banter without a club") });
    const bare = parsePersona(yaml.replace(/\nengagement:[\s\S]*?(?=\ntrends:)/, ""));
    expect(personaChecks(bare).filter((c) => !c.ok).map((c) => c.key)).toEqual(expect.arrayContaining(["short_form", "scout"]));
  });

  it("forgives the shapes a model sends for the engagement section", () => {
    let e: unknown = { formats: ["Funny Question", "silly talk", "dancing"], football: { team: "" }, questions: [{ text: "q1" }], silly_talk: "x", scout_hashtags: ["#kampala", "ug"], comment_style: "short" };
    coerceShapes("engagement", e, (v) => (e = v));
    expect(e).toEqual({ formats: ["funny_question", "silly_talk"], football: null, questions: ["q1"], silly_talk: [], scout_hashtags: ["kampala", "ug"], comment_style: "short" });
  });
});
