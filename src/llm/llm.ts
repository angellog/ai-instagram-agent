import { z } from "zod";
import { env } from "../config/env.js";
import { assertBudget, llmCostUsd, recordCost } from "../cost/ledger.js";
import { withTimeout } from "../lib/async.js";
import { PermanentError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { SettingsProvider, type LLMConfig } from "./providers.js";
import { setting } from "../config/settings.js";
import type { ChatMessage, InputImage, LLMProvider, Tier } from "./types.js";

export class MalformedOutputError extends PermanentError {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "MalformedOutputError";
  }
}

export interface CallOptions {
  system: string;
  prompt: string | ChatMessage[];
  tier?: Tier;
  maxTokens?: number;
  temperature?: number;
  operation: string;
  ref?: { type: string; id: string };
  images?: InputImage[];
}

export const moderationSchema = z.object({
  level: z.enum(["green", "yellow", "red"]),
  categories: z.array(z.string()),
  reason: z.string(),
});
export type Moderation = z.infer<typeof moderationSchema>;

/**
 * The provider-agnostic LLM surface from brief §17:
 * generate / structured / classify / summarize / moderate.
 * Every call is budget-checked before, cost-recorded after, and time-boxed.
 */
export class LLM {
  constructor(
    readonly provider: LLMProvider,
    private readonly timeoutMs = 90_000,
  ) {}

  async generate(o: CallOptions): Promise<string> {
    return (await this.call(o)).text;
  }

  async structured<S extends z.ZodType>(schema: S, o: CallOptions & { schemaName?: string }): Promise<z.infer<S>> {
    const messages = toMessages(o.prompt);
    const first = await this.call({ ...o, prompt: messages }, { schema, name: o.schemaName ?? o.operation });
    const parsed = parseJson(schema, first.text);
    if (parsed.ok) return parsed.value;

    // One repair round: show the model its own output and the validation error.
    logger.warn({ operation: o.operation, error: parsed.error }, "malformed LLM output, attempting repair");
    const repair = await this.call(
      {
        ...o,
        operation: `${o.operation}.repair`,
        prompt: [
          ...messages,
          { role: "assistant", content: first.text || "(empty)" },
          {
            role: "user",
            content: `That output was invalid: ${parsed.error}. Reply again with ONLY a single JSON object that satisfies the schema. No prose, no code fences.`,
          },
        ],
      },
      { schema, name: o.schemaName ?? o.operation },
    );
    const second = parseJson(schema, repair.text);
    if (second.ok) return second.value;
    throw new MalformedOutputError(`LLM output for ${o.operation} failed validation twice: ${second.error}`, repair.text);
  }

  async classify<L extends string>(
    text: string,
    labels: readonly [L, ...L[]],
    o: Omit<CallOptions, "prompt" | "system"> & { instructions?: string },
  ): Promise<{ label: L; confidence: number }> {
    const schema = z.object({ label: z.enum(labels), confidence: z.number().min(0).max(1) });
    return this.structured(schema, {
      ...o,
      tier: o.tier ?? "fast",
      system: `You are a precise classifier. ${o.instructions ?? ""} Labels: ${labels.join(", ")}. Return JSON {"label","confidence"}.`,
      prompt: text,
    }) as Promise<{ label: L; confidence: number }>;
  }

  async summarize(text: string, o: Omit<CallOptions, "prompt" | "system"> & { focus?: string; maxWords?: number }): Promise<string> {
    return (
      await this.generate({
        ...o,
        tier: o.tier ?? "fast",
        maxTokens: o.maxTokens ?? 400,
        system: `Summarize factually in at most ${o.maxWords ?? 80} words. ${o.focus ?? ""} Never add facts that are not in the text.`,
        prompt: text,
      })
    ).trim();
  }

  async moderate(text: string, o: Omit<CallOptions, "prompt" | "system"> & { context?: string }): Promise<Moderation> {
    return this.structured(moderationSchema, {
      ...o,
      tier: o.tier ?? "fast",
      maxTokens: o.maxTokens ?? 300,
      system: MODERATION_SYSTEM,
      prompt: `${o.context ? `Context: ${o.context}\n\n` : ""}Text to review:\n"""${text}"""`,
    });
  }

  private async call(o: CallOptions, jsonSchema?: { schema: z.ZodType; name: string }) {
    const tier = o.tier ?? "smart";
    const maxTokens = o.maxTokens ?? 1200;
    const messages = toMessages(o.prompt);
    // A settings-backed provider resolves its (possibly just-changed) config first.
    const provider = this.provider instanceof SettingsProvider ? await this.provider.active() : this.provider;
    const model = provider.modelFor(tier);
    // ~1.6k tokens per attached image at the 768px QC size.
    const estimate = llmCostUsd(model, estimateTokens(o.system, messages) + (o.images?.length ?? 0) * 1600, maxTokens);
    await assertBudget("llm", estimate);
    const started = Date.now();
    const res = await withTimeout(
      provider.complete({ system: o.system, messages, images: o.images, tier, maxTokens, temperature: o.temperature, jsonSchema, operation: o.operation }),
      this.timeoutMs,
      `llm ${o.operation}`,
    );
    const cost = llmCostUsd(res.model, res.inputTokens, res.outputTokens);
    await recordCost({
      category: "llm",
      provider: provider.name,
      model: res.model,
      operation: o.operation,
      units: { input_tokens: res.inputTokens, output_tokens: res.outputTokens },
      costUsd: cost,
      refType: o.ref?.type,
      refId: o.ref?.id,
    });
    logger.debug({ operation: o.operation, model: res.model, ms: Date.now() - started, cost }, "llm call");
    return res;
  }
}

const MODERATION_SYSTEM = `You are the safety reviewer for an AI Instagram creator account (sneakers, fashion, lifestyle).
Classify text into exactly one level:
- green: ordinary lifestyle, fashion, sneakers, fitness, books, coffee, friendly conversation, harmless jokes.
- yellow (needs human review): controversial or political topics, religion, sensitive or uncertain factual claims, accusations about real people or brands, potentially misleading statements, major announcements, prices/stock/release promises, health or money advice, anything legally risky.
- red (never automate): illegal activity, harassment or hate, sexual content or content involving minors, sensitive personal information (phone numbers, addresses, IDs, payment data), impersonation of real people, self-harm, dangerous or high-risk instructions, scams.
Return JSON {"level","categories":[short tags],"reason": one short sentence}.`;

function toMessages(p: string | ChatMessage[]): ChatMessage[] {
  return typeof p === "string" ? [{ role: "user", content: p }] : p;
}

function estimateTokens(system: string, messages: ChatMessage[]): number {
  return Math.ceil((system.length + messages.reduce((n, m) => n + m.content.length, 0)) / 3.5);
}

/** Lenient JSON extraction: code fences, leading prose, trailing commentary. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    if (start === -1) throw new Error("no JSON object found");
    const open = candidate[start];
    const close = open === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(close);
    if (end <= start) throw new Error("unterminated JSON");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

export function parseJson<S extends z.ZodType>(schema: S, text: string): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { ok: false, error: `not JSON (${(e as Error).message})` };
  }
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}

let instance: LLM | undefined;

export function llm(): LLM {
  if (!instance) {
    const e = env();
    if (e.LLM_PROVIDER === "mock") throw new Error("LLM_PROVIDER=mock: call setLLM(createDevLLM()) at boot");
    instance = new LLM(new SettingsProvider(llmConfig), e.LLM_TIMEOUT_MS + 30_000);
  }
  return instance;
}

/** LLM config: Config page (app_settings) first, then environment. */
export async function llmConfig(): Promise<LLMConfig> {
  const e = env();
  return {
    provider: (await setting("LLM_PROVIDER")) ?? e.LLM_PROVIDER,
    apiKey: await setting("LLM_API_KEY"),
    baseURL: await setting("LLM_BASE_URL"),
    model: (await setting("LLM_MODEL")) ?? e.LLM_MODEL,
    fastModel: (await setting("LLM_FAST_MODEL")) ?? e.LLM_FAST_MODEL,
    timeoutMs: e.LLM_TIMEOUT_MS,
  };
}

export function setLLM(l: LLM | undefined): void {
  instance = l;
}
