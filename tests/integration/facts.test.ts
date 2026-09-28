import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { invalidateInfluencer } from "../../src/context.js";
import { processInteraction } from "../../src/conversation/agent.js";
import { one } from "../../src/db/pool.js";
import { processWebhookEvent } from "../../src/ingest/process.js";
import { storeWebhookEvent } from "../../src/ingest/webhook.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { createDevLLM, createDevMockProvider } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { FakeInstagram, commentPayload } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

/**
 * "what is the shop location?" must get the true, full address in a natural
 * sentence, never a vague or invented one.
 */
let fake: FakeInstagram;
beforeEach(async () => {
  await resetState({ mode: "autonomous" });
  await one("UPDATE influencers SET knowledge_yaml = $1 WHERE id = 1", [readFileSync("config/knowledge.yaml", "utf8")]);
  invalidateInfluencer();
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
});
afterEach(() => setLLM(createDevLLM()));
afterAll(() => teardown());

async function ingest(payload: object): Promise<number> {
  const ev = await storeWebhookEvent("meta", JSON.stringify(payload), payload);
  await processWebhookEvent(ev!.id);
  return (await one<{ id: number }>("SELECT id FROM interactions WHERE webhook_event_id = $1", [ev!.id]))!.id;
}

const classify = () => ({ intent: "question_product", confidence: 0.95, sentiment: "neutral", language: "en", is_question: true, needs_memory: false, needs_business_info: true });
const decide = (response: string) => () => ({
  action: "reply", channel: "public", reply_value: "required", response, used_memory_ids: [], used_knowledge_ids: ["feetbit-store"],
  workflow: "none", content_request_topic: null, confidence: 0.9, reason: "Where the shop is.",
});
const FULL = "We're at Pioneer Mall, Level 5, Shop PH-100 in Kampala 📍 come through and say hi!";

describe("replies that state business facts", () => {
  it("send a complete, true answer straight away", async () => {
    const mock = createDevMockProvider().on("conversation.classify", classify).on("conversation.decide", decide(FULL));
    setLLM(new LLM(mock));
    const id = await ingest(commentPayload({ commentId: "loc1", text: "what is the shop location?" }));
    expect(await processInteraction(id)).toBe("replied");
    expect(fake.replies[0].message).toBe(FULL);
    // The model was shown the true address and told to give it in full.
    const d = mock.calls.find((c) => c.operation === "conversation.decide")!;
    expect(d.messages[0].content).toContain("Pioneer Mall, Level 5, Shop PH-100, Kampala");
    expect(d.system).toMatch(/give the full address or contact exactly as written/);
    expect(mock.calls.some((c) => c.operation === "conversation.fix_facts")).toBe(false);
  });

  it("rewrite a vague answer into the full address", async () => {
    const mock = createDevMockProvider()
      .on("conversation.classify", classify)
      .on("conversation.decide", decide("It's at Pioneer Mall, come through! 👟"))
      .on("conversation.fix_facts", () => FULL);
    setLLM(new LLM(mock));
    const id = await ingest(commentPayload({ commentId: "loc2", text: "where's the shop?" }));
    expect(await processInteraction(id)).toBe("replied");
    expect(fake.replies[0].message).toBe(FULL);
    const d = await one<{ reason: string; output: { fact_check: { note: string } } }>("SELECT reason, output FROM agent_decisions WHERE subject_id = $1", [String(id)]);
    expect(d!.output.fact_check.note).toMatch(/rewrote the reply \(missing "Level 5", missing "Shop PH-100", missing "Kampala"\)/);
  });

  it("hold an answer with a wrong floor for review instead of sending it", async () => {
    const wrong = "We're at Pioneer Mall, Level 4, Shop PH-100, Kampala!";
    const mock = createDevMockProvider()
      .on("conversation.classify", classify)
      .on("conversation.decide", decide(wrong))
      .on("conversation.fix_facts", () => wrong); // the rewrite doesn't fix it either
    setLLM(new LLM(mock));
    const id = await ingest(commentPayload({ commentId: "loc3", text: "which floor is the shop on?" }));
    expect(await processInteraction(id)).toBe("pending_review");
    expect(fake.replies).toHaveLength(0);
    const r = await one<{ categories: string[] }>("SELECT categories FROM safety_reviews ORDER BY id DESC LIMIT 1");
    expect(r!.categories).toContain("fact_check");
  });

  it("share the WhatsApp number in local format without tripping the contact filter", async () => {
    const mock = createDevMockProvider()
      .on("conversation.classify", () => ({ ...classify(), intent: "order_intent" }))
      .on("conversation.decide", () => ({
        ...decide("")(), used_knowledge_ids: ["feetbit-order"],
        response: "The team sorts orders on WhatsApp 0789 652 909, or DM @feetbitstores 🙌",
      }));
    setLLM(new LLM(mock));
    const id = await ingest(commentPayload({ commentId: "loc4", text: "what's the whatsapp number to order?" }));
    expect(await processInteraction(id)).toBe("replied");
    expect(fake.replies[0].message).toContain("0789 652 909");
  });
});
