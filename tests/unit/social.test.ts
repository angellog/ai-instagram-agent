import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { socialProblems, socialStyleBlock } from "../../src/conversation/social.js";
import { parsePersona } from "../../src/persona/parse.js";

const zuri = parsePersona(stringify(parse(readFileSync("config/persona.yaml", "utf8"))));

describe("social replies", () => {
  it("lets short, warm small talk through", () => {
    expect(socialProblems("hey you! just got back from a run 😅", "hey", zuri, "greeting").problems).toEqual([]);
    expect(socialProblems("haha the Jordans on Saturday were a vibe", "were you at the sneaker meetup?", zuri, "niche_talk").problems).toEqual([]);
  });

  it("flags a help-desk paragraph answering a one-word hello", () => {
    const draft = "Hi there! Thank you for reaching out. How can I help you today? Let me know if you have any questions about sneakers or our latest drops!";
    const c = socialProblems(draft, "hey", zuri, "greeting");
    expect(c.problems.join(" | ")).toMatch(/too long/);
    expect(c.problems.join(" | ")).toMatch(/help desk or an ad/);
    expect(socialProblems("you good? what you up to?", "yo", zuri, "greeting").problems.join(" | ")).toMatch(/more than one question/);
    expect(c.maxChars).toBeLessThan(90);
  });

  it("never sells in small talk, but answers buying questions with the shop", () => {
    expect(socialProblems("love that! FeetBit has those in stock btw", "your fit is fire", zuri, "compliment").problems.join(" | ")).toMatch(/brings up FeetBit/);
    expect(socialProblems("FeetBit at Pioneer Mall, Level 5, Shop PH-100, Kampala 👟", "where did you get those?", zuri, "question_product").problems).toEqual([]);
  });

  it("rejects lists and line breaks", () => {
    expect(socialProblems("my top 3:\n- AJ1\n- AF1", "fave sneakers?", zuri, "niche_talk").problems.join(" | ")).toMatch(/line breaks|list/);
  });

  it("tells the brain to chat like a person, stay honest when sincerely asked, and keep its own story straight", () => {
    const b = socialStyleBlock(zuri);
    expect(b).toMatch(/Length mirrors theirs/);
    expect(b).toMatch(/You're an influencer, not a salesperson/);
    expect(b).toMatch(/sincerely asks whether you're real, human or a bot, tell the truth/);
    expect(b).toMatch(/never contradict YOUR OWN LIFE/);
  });
});
