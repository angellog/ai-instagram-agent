import { z } from "zod";

/**
 * Process environment. Everything secret or deployment-specific lives here;
 * everything behavioural (limits, modes, budgets) lives in the `controls`
 * table so it can change at runtime from the admin dashboard.
 */
const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ROLE: z.enum(["all", "web", "worker"]).default("all"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  QUEUE_PREFIX: z.string().default("aia"),

  // Admin dashboard + API. Required outside development.
  ADMIN_TOKEN: optionalString,
  // 32-byte hex key for encrypting stored Instagram tokens (AES-256-GCM).
  ENCRYPTION_KEY: optionalString,

  // Meta / Instagram (Instagram API with Instagram Login)
  META_GRAPH_HOST: z.string().default("https://graph.instagram.com"),
  META_GRAPH_API_VERSION: z.string().default("v25.0"),
  INSTAGRAM_APP_ID: optionalString,
  INSTAGRAM_APP_SECRET: optionalString,
  FACEBOOK_APP_SECRET: optionalString,
  WEBHOOK_VERIFY_TOKEN: optionalString,
  // Seed credentials for the persona's account. The DB copy wins once stored.
  INSTAGRAM_ACCOUNT_ID: optionalString,
  INSTAGRAM_ACCESS_TOKEN: optionalString,

  // OpenReply relay. OpenReply owns the Meta webhook URL; it forwards raw,
  // already-verified events here signed with this shared secret.
  OPENREPLY_RELAY_SECRET: optionalString,
  // Keywords OpenReply campaigns already answer; the agent stays silent on them.
  OPENREPLY_DEFER_KEYWORDS: optionalString,

  // LLM
  LLM_PROVIDER: z.enum(["anthropic", "openai_compatible", "mock"]).default("anthropic"),
  LLM_API_KEY: optionalString,
  LLM_BASE_URL: optionalString,
  LLM_MODEL: z.string().default("claude-sonnet-5"),
  LLM_FAST_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  // kie.ai
  KIE_API_KEY: optionalString,
  KIE_API_KEY_2: optionalString,
  KIE_API_KEY_3: optionalString,
  KIE_BASE_URL: z.string().default("https://api.kie.ai"),
  KIE_UPLOAD_BASE_URL: z.string().default("https://kieai.redpandaai.co"),
  KIE_IMAGE_MODEL: z.string().default("nano-banana-pro"),
  KIE_USD_PER_CREDIT: z.coerce.number().positive().default(0.005),
  MOCK_IMAGES: bool.default(false),

  // Media storage: Supabase first, imgbb fallback (FeetBit standing rule).
  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  SUPABASE_BUCKET: z.string().default("ai-agent-media"),
  IMGBB_API_KEY: optionalString,
  LOCAL_MEDIA_DIR: z.string().default("output/media"),

  // Optional Telegram notifications for review items and failures.
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,

  PERSONA_PATH: z.string().default("config/persona.yaml"),
  KNOWLEDGE_PATH: z.string().default("config/knowledge.yaml"),
  TZ_PERSONA: optionalString,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production") {
    const missing = (["ADMIN_TOKEN", "ENCRYPTION_KEY"] as const).filter((k) => !env[k]);
    if (missing.length) throw new Error(`Missing required production env: ${missing.join(", ")}`);
  }
  if (env.ENCRYPTION_KEY && !/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY)) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return env;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test hook: drop the cached env so a test can load a modified one. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function kieKeys(e: Env = env()): string[] {
  return [e.KIE_API_KEY, e.KIE_API_KEY_2, e.KIE_API_KEY_3].filter((k): k is string => Boolean(k));
}

export function deferKeywords(e: Env = env()): string[] {
  return (e.OPENREPLY_DEFER_KEYWORDS ?? "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}
