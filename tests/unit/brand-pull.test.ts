import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { brandMentionBudget, brandPullBlock } from "../../src/content/brandpull.js";
import { slidePrompt } from "../../src/content/visual.js";
import { decisionSystem, perceptionSystem } from "../../src/conversation/prompts.js";
import { template } from "../../src/influencers/compose.js";
import { parsePersona } from "../../src/persona/parse.js";
import { personaSystemBlock } from "../../src/persona/prompt.js";
import { pronouns } from "../../src/persona/pronouns.js";

/** A skincare creator built on the same engine: nothing of Zuri's world may reach her prompts. */
function kemi() {
  const p = parse(readFileSync("config/persona.yaml", "utf8")) as any;
  p.identity = { ...p.identity, name: "Kemi", handle: "@kemi", occupation: "AI skincare and everyday-beauty creator", pronouns: "she", bio: "Kampala girl, slow mornings, honest skin days.", affiliation: "See-Me Cosmetics (skincare shop)" };
  p.brand = { name: "See-Me Cosmetics", category: "skincare and cosmetics", products: ["a glass serum bottle", "a tinted lip balm", "a gentle cleanser"], natural_moments: ["morning sink routine", "touch-up in the car mirror", "bag contents on the cafe table", "after-gym face"], curiosity_hooks: ["what's that serum?"], mention_rate: 0.2 };
  p.interests = ["skincare", "slow mornings", "cooking", "afrobeats"];
  // Her own rules (a real hatch writes these from the neutral template, never from Zuri's).
  p.content_rules = ["Never invent prices or stock. Point to See-Me Cosmetics instead."];
  p.boundaries = ["No medical advice.", "Orders and payments go to a human at See-Me Cosmetics."];
  p.visual.photography.negative = "no text, no watermark, no logos";
  p.identity.ai_disclosure = "I'm an AI creator; my photos are AI-generated.";
  p.communication_style = { ...p.communication_style, voice: "Soft, honest, a little funny.", signature_phrases: ["skin first"] };
  return parsePersona(stringify(p));
}
const zuriWords = /sneaker|feetbit|\blaces\b|pioneer mall|jordan|\bpair\b/i;

describe("independent brains", () => {
  it("frames every prompt from the influencer's own niche and brand", () => {
    const p = kemi();
    const prompts = [perceptionSystem(p), decisionSystem(personaSystemBlock(p), 280, p), brandPullBlock(p, [], [], "post")];
    for (const text of prompts) expect(text).not.toMatch(zuriWords);
    expect(perceptionSystem(p)).toContain("See-Me Cosmetics (skincare and cosmetics)");
    expect(decisionSystem(personaSystemBlock(p), 280, p)).toContain("anything needing a human at See-Me Cosmetics");
    expect(brandPullBlock(p, [], [], "post")).toContain("A breakfast post is about breakfast");
    expect(personaSystemBlock(p)).toContain("Pronouns: she/her");
  });

  it("puts the brand's item naturally in the shot, never sneakers on the feet", () => {
    const p = kemi();
    const slide = { role: "cover" as const, shot: "making tea", composition: "full_body" as const, include_character: true, overlay_kind: "none" as const, overlay_heading: "", overlay_body: "", alt_text: "x" };
    const text = slidePrompt(p, { format: "single" }, slide, { featured_item: "a glass serum bottle", outfit: "linen set" }, 0, 1);
    expect(text).toContain("Somewhere natural in the scene (not posed with, not the subject, no visible logo text): a glass serum bottle.");
    expect(text).not.toMatch(/sneaker|on their feet/i);
  });

  it("holds the brand to its mention rate, counted from its own captions", () => {
    const p = kemi();
    expect(brandMentionBudget(p, [])).toEqual({ used: 0, allowed: 2, mayName: true });
    const named = ["my See-Me Cosmetics shelf", "see me cosmetics haul", "coffee first", "rainy day"];
    expect(brandMentionBudget(p, named)).toMatchObject({ used: 2, mayName: false });
    expect(brandPullBlock(p, named, [], "post")).toContain("NOT this time");
  });

  it("uses chosen pronouns and never guesses", () => {
    const p = kemi();
    expect(pronouns(p).poss).toBe("her");
    p.identity.pronouns = "he";
    expect(pronouns(p)).toMatchObject({ subj: "he", obj: "him", poss: "his" });
    p.identity.pronouns = undefined;
    expect(pronouns(p)).toMatchObject({ subj: "they", is: "are" });
  });

  it("hatches from a neutral template that carries no other influencer's world", () => {
    const tpl = template();
    expect(tpl.length).toBeGreaterThan(1000);
    expect(tpl).not.toMatch(/zuri|feetbit|sneaker|pioneer|kololo|ntinda/i);
    expect(tpl).toContain("brand:");
  });
});
