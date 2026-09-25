import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicProvider, supportsTemperature } from "../../src/llm/providers.js";

describe("Anthropic sampling parameters", () => {
  it("omits temperature for Claude 5-generation models", () => {
    expect(supportsTemperature("claude-sonnet-5")).toBe(false);
    expect(supportsTemperature("claude-opus-5-5")).toBe(false);
    expect(supportsTemperature("claude-haiku-4-5-20251001")).toBe(true);
  });

  // A fake Messages API that rejects temperature the way the real one does.
  let server: Server;
  const bodies: Array<Record<string, unknown>> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        bodies.push(body);
        res.setHeader("content-type", "application/json");
        if ("temperature" in body) {
          res.statusCode = 400;
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." } }));
          return;
        }
        res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("retries without temperature when a model refuses it", async () => {
    const port = (server.address() as { port: number }).port;
    // An unknown future model is assumed to accept temperature, so this exercises the fallback.
    const p = new AnthropicProvider({ apiKey: "k", model: "claude-future-9", fastModel: "claude-future-9", timeoutMs: 5000, baseURL: `http://127.0.0.1:${port}` });
    const out = await p.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tier: "smart", maxTokens: 10, temperature: 0.7, operation: "t" });
    expect(out.text).toBe("ok");
    expect(bodies.map((b) => "temperature" in b)).toEqual([true, false]);
  });
});

describe("image labels", () => {
  it("places each label directly before its image, prompt last", async () => {
    const { withImagesAnthropic } = await import("../../src/llm/providers.js");
    const msgs = withImagesAnthropic({
      system: "s",
      messages: [{ role: "user", content: "judge" }],
      images: [
        { label: "REFERENCE:", data: "AAA", mediaType: "image/jpeg" },
        { label: "CANDIDATE:", data: "BBB", mediaType: "image/jpeg" },
      ],
      tier: "fast",
      maxTokens: 10,
      operation: "t",
    });
    const blocks = msgs[0].content as Array<{ type: string; text?: string; source?: { data: string } }>;
    expect(blocks.map((b) => b.text ?? b.source?.data)).toEqual(["REFERENCE:", "AAA", "CANDIDATE:", "BBB", "judge"]);
  });
});
