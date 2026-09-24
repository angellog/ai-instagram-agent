import type { z } from "zod";

export type Tier = "smart" | "fast";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface InputImage {
  /** base64 (no data: prefix) */
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  /** Attached to the last user message (vision QC). */
  images?: InputImage[];
  tier: Tier;
  maxTokens: number;
  temperature?: number;
  /** JSON schema the provider should constrain output to, when it can. */
  jsonSchema?: { schema: z.ZodType; name: string };
  /** Free-form label for logs, cost ledger and the mock provider's routing. */
  operation: string;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
}

/**
 * Minimal surface every provider implements. The higher-level operations the
 * brief asks for (generate, structured_output, classify, summarize, moderate)
 * are built once on top of this in `llm.ts`, so swapping providers never
 * touches agent code.
 */
export interface LLMProvider {
  readonly name: string;
  modelFor(tier: Tier): string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
