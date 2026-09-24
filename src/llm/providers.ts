import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { FetchLike } from "../lib/async.js";
import { PermanentError, RateLimitedError, TransientError } from "../lib/errors.js";
import type { CompletionRequest, CompletionResult, LLMProvider, Tier } from "./types.js";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(
    private readonly cfg: { apiKey: string; model: string; fastModel: string; timeoutMs: number; baseURL?: string },
  ) {
    // maxRetries 2: the SDK retries 429/5xx/connection errors with backoff;
    // anything still failing is surfaced to the job queue, which retries again.
    this.client = new Anthropic({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: 2, baseURL: cfg.baseURL });
  }

  modelFor(tier: Tier): string {
    return tier === "fast" ? this.cfg.fastModel : this.cfg.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = this.modelFor(req.tier);
    try {
      const res = await this.client.messages.create({
        model,
        max_tokens: req.maxTokens,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: withImagesAnthropic(req),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.jsonSchema ? { output_config: { format: zodOutputFormat(req.jsonSchema.schema as never) } } : {}),
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return {
        text,
        model,
        inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
        outputTokens: res.usage.output_tokens,
        stopReason: res.stop_reason ?? undefined,
      };
    } catch (e) {
      throw classifyAnthropicError(e);
    }
  }
}

function withImagesAnthropic(req: CompletionRequest): Anthropic.MessageParam[] {
  if (!req.images?.length) return req.messages;
  const msgs: Anthropic.MessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
  const last = msgs[msgs.length - 1];
  last.content = [
    ...req.images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType, data: img.data } })),
    { type: "text" as const, text: typeof last.content === "string" ? last.content : "" },
  ];
  return msgs;
}

function classifyAnthropicError(e: unknown): Error {
  if (e instanceof Anthropic.RateLimitError) return new RateLimitedError(`anthropic rate limited: ${e.message}`, 30_000);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new TransientError(`anthropic timeout: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new TransientError(`anthropic connection: ${e.message}`);
  if (e instanceof Anthropic.InternalServerError) return new TransientError(`anthropic 5xx: ${e.message}`);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new PermanentError(`anthropic auth: ${e.message}`);
  }
  if (e instanceof Anthropic.BadRequestError) return new PermanentError(`anthropic bad request: ${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Any OpenAI Chat Completions compatible endpoint (OpenRouter, Fireworks,
 * DeepSeek, a local server...). Structured output is requested with
 * response_format json_schema; the caller validates with zod either way.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai_compatible";

  constructor(
    private readonly cfg: { apiKey: string; baseURL: string; model: string; fastModel: string; timeoutMs: number },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  modelFor(tier: Tier): string {
    return tier === "fast" ? this.cfg.fastModel : this.cfg.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = this.modelFor(req.tier);
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens,
      messages: [{ role: "system", content: req.system }, ...withImagesOpenAI(req)],
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    if (req.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: req.jsonSchema.name, schema: z.toJSONSchema(req.jsonSchema.schema), strict: false },
      };
    }
    const ctrl = AbortSignal.timeout(this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl,
      });
    } catch (e) {
      throw new TransientError(`llm connection: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (res.status === 429) throw new RateLimitedError("llm rate limited", 30_000);
    if (res.status >= 500) throw new TransientError(`llm ${res.status}: ${text.slice(0, 200)}`);
    if (!res.ok) throw new PermanentError(`llm ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      model,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      stopReason: json.choices?.[0]?.finish_reason,
    };
  }
}

function withImagesOpenAI(req: CompletionRequest): Array<{ role: string; content: unknown }> {
  if (!req.images?.length) return req.messages;
  const msgs: Array<{ role: string; content: unknown }> = req.messages.map((m) => ({ ...m }));
  const last = msgs[msgs.length - 1];
  last.content = [
    ...req.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
    { type: "text", text: last.content },
  ];
  return msgs;
}

export type MockHandler = (req: CompletionRequest) => string | object | Promise<string | object>;

/**
 * Deterministic provider for development mode and tests. Handlers are routed
 * by `operation`; the default handler returns schema-valid placeholder output
 * so the full pipeline runs with no API key.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly calls: CompletionRequest[] = [];
  private handlers = new Map<string, MockHandler>();

  constructor(private readonly fallback?: MockHandler) {}

  on(operation: string, handler: MockHandler): this {
    this.handlers.set(operation, handler);
    return this;
  }

  modelFor(): string {
    return "mock";
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    const h = this.handlers.get(req.operation) ?? this.fallback;
    if (!h) throw new PermanentError(`MockProvider: no handler for operation "${req.operation}"`);
    const out = await h(req);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    return { text, model: "mock", inputTokens: Math.ceil(req.system.length / 4), outputTokens: Math.ceil(text.length / 4) };
  }
}

export function providerFromEnv(e: Env): LLMProvider {
  if (e.LLM_PROVIDER === "mock") {
    // Imported lazily so production bundles never depend on dev fixtures.
    throw new Error("mock provider must be constructed via createDevMockProvider()");
  }
  if (!e.LLM_API_KEY) throw new Error(`LLM_API_KEY is required for LLM_PROVIDER=${e.LLM_PROVIDER}`);
  if (e.LLM_PROVIDER === "openai_compatible") {
    if (!e.LLM_BASE_URL) throw new Error("LLM_BASE_URL is required for LLM_PROVIDER=openai_compatible");
    return new OpenAICompatibleProvider({
      apiKey: e.LLM_API_KEY,
      baseURL: e.LLM_BASE_URL,
      model: e.LLM_MODEL,
      fastModel: e.LLM_FAST_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
    });
  }
  return new AnthropicProvider({
    apiKey: e.LLM_API_KEY,
    model: e.LLM_MODEL,
    fastModel: e.LLM_FAST_MODEL,
    timeoutMs: e.LLM_TIMEOUT_MS,
    baseURL: e.LLM_BASE_URL,
  });
}
