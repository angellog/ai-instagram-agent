import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, LLM, MalformedOutputError, parseJson } from "../../src/llm/llm.js";
import { MockProvider } from "../../src/llm/providers.js";
import { TimeoutError } from "../../src/lib/async.js";
import { resetState, teardown } from "../helpers/db.js";
import { afterAll, beforeEach } from "vitest";

beforeEach(() => resetState());
afterAll(() => teardown());

const schema = z.object({ intent: z.enum(["question", "other"]), confidence: z.number() });

describe("JSON extraction", () => {
  it("handles fences, prose and trailing text", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":{"b":2}} hope that helps')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json here")).toThrow();
  });
  it("reports schema violations with paths", () => {
    const r = parseJson(schema, '{"intent":"nope","confidence":"x"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/intent/);
  });
});

describe("structured output", () => {
  it("repairs a malformed first answer", async () => {
    let n = 0;
    const p = new MockProvider().on("t", () => (++n === 1 ? "I think it's a question" : { intent: "question", confidence: 0.9 })).on("t.repair", () => ({ intent: "question", confidence: 0.9 }));
    const out = await new LLM(p).structured(schema, { operation: "t", system: "s", prompt: "p" });
    expect(out).toEqual({ intent: "question", confidence: 0.9 });
    expect(p.calls.map((c) => c.operation)).toEqual(["t", "t.repair"]);
    // The repair round shows the model its own bad output.
    expect(p.calls[1].messages.at(-2)?.content).toBe("I think it's a question");
  });

  it("throws MalformedOutputError (permanent) after two bad answers", async () => {
    const p = new MockProvider(() => "garbage");
    await expect(new LLM(p).structured(schema, { operation: "t", system: "s", prompt: "p" })).rejects.toBeInstanceOf(MalformedOutputError);
  });

  it("times out a hung provider", async () => {
    const p = new MockProvider(() => new Promise(() => {}));
    await expect(new LLM(p, 50).generate({ operation: "t", system: "s", prompt: "p" })).rejects.toBeInstanceOf(TimeoutError);
  });

  it("records token cost for every call", async () => {
    const { many } = await import("../../src/db/pool.js");
    await new LLM(new MockProvider(() => "hello")).generate({ operation: "cost.test", system: "s", prompt: "p" });
    const rows = await many<{ operation: string }>("SELECT operation FROM cost_ledger");
    expect(rows.map((r) => r.operation)).toContain("cost.test");
  });
});
