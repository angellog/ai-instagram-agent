import { describe, expect, it } from "vitest";
import { llmCostUsd } from "../../src/cost/ledger.js";
import { OpenAICompatibleProvider } from "../../src/llm/providers.js";
import type { CompletionRequest } from "../../src/llm/types.js";

type Call = { url: string; body: Record<string, unknown> };
function fakeFetch(replies: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const f = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const r = replies.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return { f, calls };
}
const ok = (content: string, model = "gpt-6.1-sol-2026-08-12") => ({ status: 200, body: { model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } } });
const req: CompletionRequest = { operation: "t", tier: "smart", maxTokens: 900, temperature: 0.9, system: "s", messages: [{ role: "user", content: "hi" }] };
const openai = (f: ReturnType<typeof fakeFetch>["f"], baseURL = "https://api.openai.com/v1") =>
  new OpenAICompatibleProvider({ apiKey: "k", baseURL, model: "gpt-6.1-sol", fastModel: "gpt-6-luna", timeoutMs: 5000 }, f);

describe("OpenAI provider", () => {
  it("uses max_completion_tokens with room for reasoning on api.openai.com, and reports the dated model", async () => {
    const { f, calls } = fakeFetch([ok("OK")]);
    const r = await openai(f).complete(req);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].body).toMatchObject({ model: "gpt-6.1-sol", max_completion_tokens: 4900, temperature: 0.9 });
    expect(calls[0].body).not.toHaveProperty("max_tokens");
    expect(r).toMatchObject({ text: "OK", model: "gpt-6.1-sol-2026-08-12", inputTokens: 100, outputTokens: 20 });
  });

  it("keeps max_tokens for other OpenAI-compatible hosts", async () => {
    const { f, calls } = fakeFetch([ok("OK")]);
    await openai(f, "https://openrouter.ai/api/v1").complete(req);
    expect(calls[0].body).toMatchObject({ max_tokens: 900 });
  });

  it("retries once without temperature when the model only allows the default", async () => {
    const { f, calls } = fakeFetch([
      { status: 400, body: { error: { message: "Unsupported value: 'temperature' does not support 0.9 with this model." } } },
      ok("OK"),
    ]);
    expect((await openai(f).complete(req)).text).toBe("OK");
    expect(calls).toHaveLength(2);
    expect(calls[1].body).not.toHaveProperty("temperature");
  });

  it("turns an empty reply cut off by reasoning into a retryable error, and a bad key into a clear one", async () => {
    const empty = fakeFetch([{ status: 200, body: { choices: [{ message: { content: "" }, finish_reason: "length" }] } }]);
    await expect(openai(empty.f).complete(req)).rejects.toThrow(/ran out of tokens/);
    const bad = fakeFetch([{ status: 401, body: { error: { message: "Incorrect API key" } } }]);
    await expect(openai(bad.f).complete(req)).rejects.toThrow(/key was refused/);
  });

  it("prices OpenAI models, including dated snapshots, and never confuses a mini with its big sibling", () => {
    expect(llmCostUsd("gpt-6.1-sol", 1_000_000, 1_000_000)).toBeCloseTo(12);
    expect(llmCostUsd("gpt-6.1-sol-2026-08-12", 1_000_000, 0)).toBeCloseTo(2);
    expect(llmCostUsd("gpt-6-luna", 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(llmCostUsd("gpt-4o-mini-2024-07-18", 1_000_000, 0)).toBeCloseTo(0.15);
    expect(llmCostUsd("openai/gpt-6-luna", 1_000_000, 0)).toBeCloseTo(0.1);
    expect(llmCostUsd("claude-haiku-4-5-20251001", 1_000_000, 0)).toBeCloseTo(1);
  });
});
