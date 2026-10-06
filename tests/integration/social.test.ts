import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { processInteraction } from "../../src/conversation/agent.js";
import { many, one } from "../../src/db/pool.js";
import { processWebhookEvent } from "../../src/ingest/process.js";
import { storeWebhookEvent } from "../../src/ingest/webhook.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { createDevLLM, createDevMockProvider } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { extractMemories } from "../../src/memory/extract.js";
import { setControls } from "../../src/config/controls.js";
import { dmPayload, FakeInstagram } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

let fake: FakeInstagram;
beforeEach(async () => {
  await resetState({ mode: "autonomous" });
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
const decide = (response: string) => ({ action: "reply", channel: "dm", reply_value: "required", response, used_memory_ids: [], used_knowledge_ids: [], workflow: "none", content_request_topic: null, confidence: 0.9, reason: "chatting" });

describe("social conversation", () => {
  it("rewrites a help-desk paragraph into one short line before it goes out", async () => {
    const mock = createDevMockProvider().on("conversation.decide", () =>
      decide("Hi there! Thank you for reaching out. How can I help you today? Let me know if you have any questions about our latest sneaker drops!"),
    );
    setLLM(new LLM(mock, 90_000));
    const id = await ingest(dmPayload({ mid: "m.s1", text: "hey" }));
    expect(await processInteraction(id)).toBe("replied");
    const sent = (await one<{ text: string }>("SELECT text FROM messages WHERE direction = 'out' ORDER BY id DESC LIMIT 1"))!.text;
    expect(sent).toBe("haha same, honestly");
    expect(mock.calls.map((c) => c.operation)).toContain("conversation.social_rewrite");
    const d = await one<{ reason: string }>("SELECT reason FROM agent_decisions WHERE subject_id = $1 ORDER BY id DESC LIMIT 1", [String(id)]);
    expect(d!.reason).toMatch(/social check rewrote the reply/);
  });

  it("keeps her own story: what she tells one person is canon in everyone's chat", async () => {
    await setControls({ mode: "dry_run" });
    const mock = createDevMockProvider().on("conversation.decide", () => decide("haha I'm watching Black Panther tonight, finally"));
    setLLM(new LLM(mock, 90_000));
    const a = await ingest(dmPayload({ mid: "m.c1", text: "what are you up to tonight?", senderId: "fan-a" }));
    await processInteraction(a);
    await extractMemories(a);
    const self = await many<{ layer: string; kind: string; content: string }>("SELECT layer, kind, content FROM memories WHERE layer = 'identity'");
    expect(self).toEqual([expect.objectContaining({ kind: "self_fact", content: expect.stringMatching(/watching black panther/i) })]);
    expect(await many("SELECT 1 FROM memories WHERE layer = 'relationship' AND kind = 'shared'")).toHaveLength(1);

    // A different person asks about movies: the canon is in her context.
    mock.calls.length = 0;
    const b = await ingest(dmPayload({ mid: "m.c2", text: "seen any good movies? like black panther", senderId: "fan-b" }));
    await processInteraction(b);
    const call = mock.calls.find((c) => c.operation === "conversation.decide")!;
    expect(call.messages.map((m) => m.content).join("\n")).toMatch(/YOUR OWN LIFE[\s\S]*watching black panther/i);
    expect(call.system).toMatch(/HOW YOU TALK/);
  });
});
