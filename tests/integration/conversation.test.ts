import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { many, one } from "../../src/db/pool.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { processWebhookEvent } from "../../src/ingest/process.js";
import { storeWebhookEvent } from "../../src/ingest/webhook.js";
import { processInteraction } from "../../src/conversation/agent.js";
import { extractMemories } from "../../src/memory/extract.js";
import { setControls } from "../../src/config/controls.js";
import { setLLM, LLM } from "../../src/llm/llm.js";
import { createDevMockProvider } from "../../src/llm/devMock.js";
import { approveReview, listReviews, rejectReview } from "../../src/web/reviews.js";
import { FakeInstagram, commentPayload, dmPayload } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

let fake: FakeInstagram;
beforeEach(async () => {
  await resetState();
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
});
afterAll(() => teardown());

async function ingest(payload: object): Promise<number> {
  const raw = JSON.stringify(payload);
  const ev = await storeWebhookEvent("meta", raw, payload);
  await processWebhookEvent(ev!.id);
  const it = await one<{ id: number }>("SELECT id FROM interactions WHERE webhook_event_id = $1", [ev!.id]);
  return it!.id;
}

describe("conversation agent", () => {
  it("replies publicly to a comment and records the full decision", async () => {
    const id = await ingest(commentPayload({ commentId: "c1", text: "Those are clean! Which colourway is your favourite?" }));
    expect(await processInteraction(id)).toBe("replied");
    expect(fake.replies).toHaveLength(1);
    expect(fake.replies[0]).toMatchObject({ commentId: "c1" });
    const d = await one<{ intent: string; action: string; safety_level: string; context_used: string[] }>(
      "SELECT intent, action, safety_level, context_used FROM agent_decisions WHERE subject_id = $1",
      [String(id)],
    );
    expect(d).toMatchObject({ action: "reply:send", safety_level: "green" });
    expect(await one("SELECT status FROM messages WHERE interaction_id = $1 AND direction = 'out'", [id])).toEqual({ status: "sent" });
    expect(await one("SELECT status FROM interactions WHERE id = $1", [id])).toEqual({ status: "done" });
  });

  it("is idempotent: re-running the same interaction never sends twice", async () => {
    const id = await ingest(commentPayload({ commentId: "c2", text: "fire pair, where did you shoot this?" }));
    await processInteraction(id);
    await one("UPDATE interactions SET status = 'processing' WHERE id = $1", [id]); // simulate a crash after send
    await processInteraction(id);
    expect(fake.replies).toHaveLength(1);
  });

  it("answers DMs in the thread and remembers the person", async () => {
    const id = await ingest(dmPayload({ mid: "mid.a1", text: "hey Zuri, I love Jordan 4s so much" }));
    expect(await processInteraction(id)).toBe("replied");
    expect(fake.dms[0]).toMatchObject({ recipient: { id: "9002" } });
    expect(await extractMemories(id)).toMatchObject({ stored: 1 });
    const mem = await one<{ id: number; content: string; layer: string }>("SELECT id, content, layer FROM memories");
    expect(mem).toMatchObject({ layer: "relationship", content: "Likes Jordan 4s so much" });

    // Second message: the stored memory is offered to the model and cited.
    const mock = createDevMockProvider();
    setLLM(new LLM(mock));
    const id2 = await ingest(dmPayload({ mid: "mid.a2", text: "what should I wear them with?" }));
    await processInteraction(id2);
    const decide = mock.calls.find((c) => c.operation === "conversation.decide")!;
    expect(decide.messages[0].content).toContain(`[${mem!.id}] (interest) Likes Jordan 4s so much`);
    const d = await one<{ output: { used_memory_ids: number[] }; context_used: string[] }>(
      "SELECT output, context_used FROM agent_decisions WHERE subject_id = $1",
      [String(id2)],
    );
    expect(d!.output.used_memory_ids).toEqual([mem!.id]);
    expect(d!.context_used).toEqual(expect.arrayContaining(["user_memory", "conversation_history"]));
  });

  it("drops memory ids the model invents", async () => {
    const mock = createDevMockProvider().on("conversation.decide", () => ({
      action: "reply", channel: "dm", reply_value: "required", response: "Good to hear from you again!",
      used_memory_ids: [999], used_knowledge_ids: ["made-up"], workflow: "none", content_request_topic: null, confidence: 0.9, reason: "x",
    }));
    setLLM(new LLM(mock));
    const id = await ingest(dmPayload({ mid: "mid.f1", text: "remember me?" }));
    await processInteraction(id);
    const d = await one<{ output: Record<string, unknown> }>("SELECT output FROM agent_decisions WHERE subject_id = $1", [String(id)]);
    expect(d!.output).toMatchObject({ used_memory_ids: [], used_knowledge_ids: [], fabricated_memory_refs_dropped: [999] });
  });

  it("escalates product questions to a human with a draft reply", async () => {
    const id = await ingest(commentPayload({ commentId: "c3", text: "how much are these and do you have size 42?" }));
    expect(await processInteraction(id)).toBe("escalated");
    expect(fake.replies).toHaveLength(0);
    const [r] = await listReviews("pending");
    expect(r.categories).toContain("escalation");
    expect(r.proposed).toMatchObject({ channel: "private_reply", text: expect.stringContaining("FeetBit") });
    const res = await approveReview(r.id, "tester");
    expect(res).toMatchObject({ ok: true });
    expect(fake.dms).toHaveLength(1);
    expect(fake.dms[0].recipient).toEqual({ comment_id: "c3" });
  });

  it("holds everything for review in human-approval mode; rejection sends nothing", async () => {
    await setControls({ mode: "human_approval" });
    const id = await ingest(commentPayload({ commentId: "c4", text: "love this rotation" }));
    expect(await processInteraction(id)).toBe("pending_review");
    const [r] = await listReviews("pending");
    await rejectReview(r.id, "tester", "not needed");
    expect(fake.replies).toHaveLength(0);
    expect(await one("SELECT status FROM messages WHERE direction = 'out'")).toEqual({ status: "rejected" });
  });

  it("never engages with abuse and hides it in autonomous mode", async () => {
    const id = await ingest(commentPayload({ commentId: "c5", text: "you stupid bitch" }));
    expect(await processInteraction(id)).toBe("hidden");
    expect(fake.hidden).toEqual(["c5"]);
    expect(fake.replies).toHaveLength(0);
    expect(await one("SELECT level, status FROM safety_reviews")).toEqual({ level: "red", status: "rejected" });
  });

  it("sends yellow drafts to review even in autonomous mode", async () => {
    setLLM(new LLM(createDevMockProvider().on("safety.moderate", () => ({ level: "yellow", categories: ["uncertain_claim"], reason: "unverified claim" }))));
    const id = await ingest(commentPayload({ commentId: "c6", text: "is it true these are made in Uganda?" }));
    expect(await processInteraction(id)).toBe("pending_review");
    expect(fake.replies).toHaveLength(0);
  });

  it("stays silent on OpenReply keywords, emoji-only comments and self-comments", async () => {
    for (const [cid, text] of [["c7", "LINK"], ["c8", "🔥🔥🔥"]] as const) {
      const id = await ingest(commentPayload({ commentId: cid, text }));
      expect(await processInteraction(id)).toBe("ignored");
    }
    expect(fake.replies).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("respects the hourly reply limit", async () => {
    await setControls({ max_comment_replies_per_hour: 1 });
    await processInteraction(await ingest(commentPayload({ commentId: "c9", text: "nice fit today", fromId: "1" })));
    expect(await processInteraction(await ingest(commentPayload({ commentId: "c10", text: "nice fit again", fromId: "2" })))).toBe("throttled");
    expect(fake.replies).toHaveLength(1);
  });

  it("does not reply to DMs outside the 24h window", async () => {
    const id = await ingest(dmPayload({ mid: "mid.old", text: "hello from last week", timestamp: Date.now() - 30 * 3600_000 }));
    expect(await processInteraction(id)).toBe("ignored");
    expect(fake.dms).toHaveLength(0);
  });

  it("only handles the persona's own account", async () => {
    const ev = await storeWebhookEvent("meta", "x1", commentPayload({ commentId: "c11", text: "hi", accountId: "someone-else" }));
    expect(await processWebhookEvent(ev!.id)).toEqual({ queued: 0, skipped: 1 });
  });

  it("records per-interaction LLM cost", async () => {
    const id = await ingest(commentPayload({ commentId: "c12", text: "what book are you reading?" }));
    await processInteraction(id);
    const ops = await many<{ operation: string }>("SELECT operation FROM cost_ledger WHERE ref_type = 'interaction' AND ref_id = $1", [String(id)]);
    expect(ops.map((o) => o.operation)).toEqual(expect.arrayContaining(["conversation.classify", "conversation.decide", "safety.moderate"]));
  });
});

describe("direct questions", () => {
  it("are never dropped by optional-reply sampling", async () => {
    await setControls({ optional_reply_rate: 0 });
    setLLM(new LLM(createDevMockProvider()
      .on("conversation.classify", () => ({ intent: "question_about_persona", confidence: 0.9, sentiment: "positive", language: "en", is_question: true, needs_memory: false, needs_business_info: false }))
      .on("conversation.decide", () => ({ action: "reply", channel: "public", reply_value: "worthwhile", response: "A little spot near Kololo!", used_memory_ids: [], used_knowledge_ids: [], workflow: "none", content_request_topic: null, confidence: 0.8, reason: "Direct question deserves an answer." }))));
    const id = await ingest(commentPayload({ commentId: "q1", text: "Which gym is that?" }));
    expect(await processInteraction(id)).toBe("replied");
  });

  it("records when code overrides the model", async () => {
    await setControls({ optional_reply_rate: 0 });
    setLLM(new LLM(createDevMockProvider()
      .on("conversation.classify", () => ({ intent: "compliment", confidence: 0.9, sentiment: "positive", language: "en", is_question: false, needs_memory: false, needs_business_info: false }))
      .on("conversation.decide", () => ({ action: "reply", channel: "public", reply_value: "worthwhile", response: "Thank you!", used_memory_ids: [], used_knowledge_ids: [], workflow: "none", content_request_topic: null, confidence: 0.8, reason: "Kind words." }))));
    const id = await ingest(commentPayload({ commentId: "q2", text: "love this fit" }));
    expect(await processInteraction(id)).toBe("ignored");
    const d = await one<{ reason: string }>("SELECT reason FROM agent_decisions WHERE subject_id = $1", [String(id)]);
    expect(d!.reason).toMatch(/^optional reply not sampled \(rate 0\) \(model: reply\/worthwhile: Kind words\.\)/);
  });

  it("can be re-run after being ignored, but never once a reply exists", async () => {
    const { rerunInteraction } = await import("../../src/web/admin.js");
    const id = await ingest(commentPayload({ commentId: "q3", text: "🔥🔥" }));
    expect(await processInteraction(id)).toBe("ignored");
    expect(await rerunInteraction(id)).toMatch(/queued/);
    expect(await one("SELECT status FROM interactions WHERE id = $1", [id])).toEqual({ status: "pending" });
    const id2 = await ingest(commentPayload({ commentId: "q4", text: "what are you reading this week?" }));
    await processInteraction(id2);
    expect(await rerunInteraction(id2)).toMatch(/already exists|Only ignored/);
  });
});
