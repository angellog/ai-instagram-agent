import { describe, expect, it } from "vitest";
import { evaluateRules, levelOf, maxLevel, redactPersonalData } from "../../src/safety/rules.js";
import { gate } from "../../src/safety/safety.js";
import { controlsSchema } from "../../src/config/controls.js";

const out = (t: string, allowed: string[] = []) => levelOf(evaluateRules(t, { direction: "outbound", allowedContacts: allowed }));
const inb = (t: string) => levelOf(evaluateRules(t, { direction: "inbound" }));

describe("safety rules: GREEN", () => {
  it.each(["Coffee first, then a sunrise run 👟", "Those Jordan 4s are clean!", "Reading on the rooftop tonight", "Suede needs a dry brush, never water"])(
    "%s is green",
    (t) => expect(out(t)).toBe("green"),
  );
});

describe("safety rules: YELLOW (review)", () => {
  it.each([
    ["politics", "What do you think about the election and the president?"],
    ["accusation", "That store is a scam and they sell fake pairs"],
    ["commercial promise", "They are in stock and the price is 250,000 UGX"],
    ["release claim", "The new colourway drops on friday at the shop"],
    ["financial", "You should invest in crypto, guaranteed returns"],
  ])("%s", (_name, t) => expect(out(t)).toBe("yellow"));

  it("flags an inbound complaint for review", () => {
    expect(inb("My order never arrived, I want a refund")).toBe("yellow");
  });
});

describe("safety rules: RED (never automate)", () => {
  it.each([
    ["harassment", "you are a stupid bitch"],
    ["self harm", "kys"],
    ["sexual", "send nudes"],
    ["personal data", "Call me on +256 772 123 456"],
    ["email", "write to someone@example.com"],
    ["card number", "card 4111 1111 1111 1111"],
    ["human claim", "I'm a real human, not an AI"],
    ["credentials", "my password: hunter2"],
  ])("%s", (_name, t) => expect(out(t)).toBe("red"));

  it("allows the published business contact", () => {
    expect(out("WhatsApp the team on +256 789 652 909", ["+256 789 652 909"])).toBe("green");
  });
  it("does not treat an invalid card-like number as payment data", () => {
    expect(evaluateRules("order 1234 5678 9012 3456", { direction: "outbound" }).some((h) => h.category === "payment_data")).toBe(false);
  });
  it("lets an AI creator describe itself", () => {
    expect(out("I'm an AI creator made by the FeetBit team")).toBe("green");
  });
});

describe("helpers", () => {
  it("maxLevel picks the strictest", () => {
    expect(maxLevel("green", "yellow")).toBe("yellow");
    expect(maxLevel("yellow", "red", "green")).toBe("red");
  });
  it("redacts personal data but keeps allowed contacts", () => {
    expect(redactPersonalData("me: +256 772 123 456, shop: +256 789 652 909", ["+256 789 652 909"])).toBe("me: [phone], shop: +256 789 652 909");
  });
});

describe("gate matrix", () => {
  const c = (patch: object) => controlsSchema.parse(patch);
  it("red is always blocked", () => {
    for (const mode of ["development", "dry_run", "human_approval", "autonomous"] as const) expect(gate("red", c({ mode }))).toBe("block");
  });
  it("human approval sends everything to review", () => {
    expect(gate("green", c({ mode: "human_approval" }))).toBe("review");
  });
  it("autonomous sends green, reviews yellow unless configured otherwise", () => {
    expect(gate("green", c({ mode: "autonomous" }))).toBe("send");
    expect(gate("yellow", c({ mode: "autonomous" }))).toBe("review");
    expect(gate("yellow", c({ mode: "autonomous", require_review_for_yellow: false }))).toBe("send");
  });
  it("dry run and pause never send", () => {
    expect(gate("green", c({ mode: "dry_run" }))).toBe("dry_run");
    expect(gate("green", c({ mode: "autonomous", paused: true }))).toBe("dry_run");
  });
});
