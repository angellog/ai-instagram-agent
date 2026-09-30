import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withInfluencerLoose } from "../../src/context.js";
import { many, one } from "../../src/db/pool.js";
import { LLMBillingError } from "../../src/lib/errors.js";
import { billingBlocks } from "../../src/llm/billing.js";
import { createDevLLM } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { OpenAICompatibleProvider } from "../../src/llm/providers.js";
import type { CompletionRequest, CompletionResult, LLMProvider } from "../../src/llm/types.js";
import { queue } from "../../src/queue/queues.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";

/** A Claude-named provider we can switch between "account empty" and "working". */
class Switchable implements LLMProvider {
  readonly name = "anthropic";
  empty = true;
  modelFor(): string {
    return "claude-sonnet-5";
  }
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.empty) throw new LLMBillingError("claude");
    return { text: "OK", model: "claude-sonnet-5", inputTokens: 5, outputTokens: 1 };
  }
}

let app: FastifyInstance;
beforeEach(async () => {
  await resetState();
  app ??= await buildServer();
});
afterAll(async () => {
  setLLM(createDevLLM());
  await app?.close();
  await teardown();
});

describe("LLM account out of credit", () => {
  it("shows a banner everywhere, then clears it and re-queues held DMs once calls work again", async () => {
    const p = new Switchable();
    setLLM(new LLM(p, 5000));
    const ask = () => withInfluencerLoose(1, () => new LLM(p, 5000).generate({ operation: "t", system: "s", prompt: "hi" }));
    await expect(ask()).rejects.toThrow(/LLM out of credit: the Anthropic account/);
    expect((await billingBlocks()).map((b) => b.brain)).toEqual(["claude"]);
    await expect(ask()).rejects.toThrow(LLMBillingError); // repeated failures don't re-alert
    expect(await many("SELECT 1 FROM system_events WHERE source = 'llm' AND level = 'error'")).toHaveLength(1);

    const page = await app.inject({ url: "/admin" });
    expect(page.body).toContain("Claude (Anthropic) is out of credit since");
    expect(page.body).toContain("console.anthropic.com");

    // A DM that failed while the account was empty (new marker and the old raw Anthropic text).
    const held = await one<{ id: number }>(
      `INSERT INTO interactions (influencer_id, kind, ig_object_id, ig_account_id, sender_ig_id, text, occurred_at, status, last_error)
       VALUES (1, 'dm', 'mid-1', 'acct', 'fan', 'where is the shop?', now(), 'failed', 'LLMBillingError: LLM out of credit: the Anthropic account has no credit left.') RETURNING id`,
    );
    await one(
      `INSERT INTO interactions (influencer_id, kind, ig_object_id, ig_account_id, sender_ig_id, text, occurred_at, status, last_error)
       VALUES (1, 'dm', 'mid-2', 'acct', 'fan2', 'hi', now(), 'failed', 'some other failure')`,
    );

    p.empty = false;
    expect(await ask()).toBe("OK");
    expect(await billingBlocks()).toEqual([]);
    expect(await one("SELECT status FROM interactions WHERE id = $1", [held!.id])).toEqual({ status: "pending" });
    expect(await one("SELECT status FROM interactions WHERE ig_object_id = 'mid-2'")).toEqual({ status: "failed" });
    const jobs = await queue("conversation").getJobs(["waiting"]);
    expect(jobs.map((j) => j.data.interactionId)).toContain(held!.id);
    expect((await app.inject({ url: "/admin" })).body).not.toContain("is out of credit");
  });

  it("recognises the real provider messages for an empty account", async () => {
    const openaiEmpty = async () => new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }), { status: 429 });
    const openai = new OpenAICompatibleProvider({ apiKey: "k", baseURL: "https://api.openai.com/v1", model: "gpt-6.1-sol", fastModel: "gpt-6-luna", timeoutMs: 5000 }, openaiEmpty);
    await expect(openai.complete({ operation: "t", tier: "smart", maxTokens: 10, system: "s", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ name: "LLMBillingError", brain: "openai" });

    const { classifyAnthropicError } = await import("../../src/llm/providers.js");
    const raw = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, "Your credit balance is too low to access the Anthropic API.", new Headers());
    expect(classifyAnthropicError(raw)).toBeInstanceOf(LLMBillingError);
  });
});
