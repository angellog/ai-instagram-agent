import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseKnowledge } from "../../src/context.js";
import { checkFacts, missingDetails, numbersIn, unverifiedNumbers } from "../../src/conversation/facts.js";
import { evaluateRules } from "../../src/safety/rules.js";

const kb = parseKnowledge(readFileSync("config/knowledge.yaml", "utf8"));
const store = kb.find((k) => k.id === "feetbit-store")!;
const order = kb.find((k) => k.id === "feetbit-order")!;

describe("business knowledge", () => {
  it("has the confirmed shop address (Level 5, not Level 4)", () => {
    expect(store.content).toContain("Pioneer Mall, Level 5, Shop PH-100, Kampala");
    expect(store.content).not.toMatch(/Level 4/);
    for (const phrase of [...(store.must_include ?? []), ...(order.must_include ?? [])]) {
      expect(missingDetails(`${store.content} ${order.content}`, [{ ...store, must_include: [phrase] }])).toEqual([]);
    }
  });

  it("finds the store entry for the ways people ask", async () => {
    const { retrieveKnowledge } = await import("../../src/conversation/knowledge.js");
    const { maybeInfluencer, setFallbackInfluencer } = await import("../../src/context.js");
    const before = maybeInfluencer();
    setFallbackInfluencer({ ...(before ?? {}), knowledge: kb } as never);
    try {
      for (const q of ["what is the shop location?", "where are you located?", "which floor are you on", "can I pass by the store?"]) {
        expect(retrieveKnowledge(q).map((k) => k.id), q).toContain("feetbit-store");
      }
    } finally {
      setFallbackInfluencer(before);
    }
  });
});

describe("fact check", () => {
  it("wants the full address, not a vague answer", () => {
    expect(missingDetails("It's at Pioneer Mall, come through! 👟", [store])).toEqual(["Level 5", "Shop PH-100", "Kampala"]);
    expect(missingDetails("We're at Pioneer Mall, Level 5, Shop PH-100 in Kampala, come say hi 👟", [store])).toEqual([]);
    expect(missingDetails("pioneer mall level 5, shop ph - 100, kampala", [store])).toEqual([]); // case and dash spacing don't matter
  });

  it("accepts the WhatsApp number in local or international format", () => {
    expect(missingDetails("WhatsApp 0789 652 909 or DM @feetbit.sneakers", [order])).toEqual([]);
    expect(missingDetails("WhatsApp +256789652909 or DM @feetbit.sneakers", [order])).toEqual([]);
    expect(missingDetails("just DM @feetbit.sneakers", [order])).toEqual(["+256 789 652 909"]);
  });

  it("catches numbers the knowledge doesn't give", () => {
    expect(unverifiedNumbers("Pioneer Mall, Level 4, Shop PH-100", [store], "where is the shop?")).toEqual(["4"]);
    expect(unverifiedNumbers("Call 0772 123 456", [store, order], "number?")).toEqual(["772123456"]);
    expect(unverifiedNumbers("Size 42 is a good call", [store], "do you think size 42 fits?")).toEqual([]); // from their own message
    expect(checkFacts("Pioneer Mall, Level 5, Shop PH-100, Kampala", { used: [store], shown: [store], inbound: "where?" })).toEqual({ missing: [], unverified: [] });
  });

  it("matches a number with its unit, so one fact can't vouch for another", () => {
    const delivery = { ...order, content: "A rider brings it within 40 minutes to 2 hours. Open 9am to 7pm." };
    expect(unverifiedNumbers("Only 2 pairs left!", [delivery], "")).toEqual(["2"]);
    expect(unverifiedNumbers("Usually 2 hours, sometimes 40 minutes", [delivery], "")).toEqual([]);
    expect(unverifiedNumbers("We open at 9 am", [delivery], "")).toEqual([]);
    expect(unverifiedNumbers("2 is the limit", [delivery], "")).toEqual([]); // no unit: the bare number is enough
  });

  it("reads numbers the way people write them", () => {
    expect(numbersIn("Level 5, Shop PH-100")).toEqual(["5", "100"]);
    expect(numbersIn("+256 789 652 909")).toEqual(["789652909"]);
  });
});

describe("safety filter", () => {
  it("lets the business WhatsApp through in local format, still blocks other numbers", () => {
    const allowed = ["+256 789 652 909"];
    expect(evaluateRules("WhatsApp us on 0789 652 909", { direction: "outbound", allowedContacts: allowed })).toEqual([]);
    expect(evaluateRules("text me on 0772 123 456", { direction: "outbound", allowedContacts: allowed })[0]).toMatchObject({ level: "red", category: "personal_contact" });
  });
});

describe("TikTok ids", () => {
  it("keeps 19-digit post ids exact", async () => {
    const { parseLosslessly } = await import("../../src/tiktok/client.js");
    expect(parseLosslessly('{"data":{"publicaly_available_post_id":[7450000000000000001, 7450000000000000002]}}')).toEqual({ data: { publicaly_available_post_id: ["7450000000000000001", "7450000000000000002"] } });
    expect(parseLosslessly('{"a":12,"b":"x"}')).toEqual({ a: 12, b: "x" });
  });
});
