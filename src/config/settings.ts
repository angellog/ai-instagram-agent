import { many, one } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { env } from "./env.js";

/**
 * In-app configuration (the Config page). Resolution order for every key:
 *   1. app_settings row (set from the dashboard; secrets AES-256-GCM encrypted)
 *   2. the environment variable of the same name
 * Bootstrap values the app needs before it can reach the database
 * (DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, ADMIN_TOKEN, PORT, ROLE) stay
 * environment-only and are deliberately absent from this catalog.
 */

export type SettingGroup = "llm" | "generation" | "storage" | "instagram" | "openreply" | "alerts";

export interface SettingDef {
  key: string;
  label: string;
  group: SettingGroup;
  secret: boolean;
  help: string;
  placeholder?: string;
  /** Provider this key belongs to, for the "Test" button. */
  provider?: string;
  choices?: string[];
}

export const SETTINGS: SettingDef[] = [
  // LLM
  { key: "LLM_PROVIDER", label: "LLM provider", group: "llm", secret: false, help: "anthropic (recommended) or openai_compatible (OpenRouter, Fireworks, …).", choices: ["anthropic", "openai_compatible"], provider: "llm" },
  { key: "LLM_API_KEY", label: "LLM API key", group: "llm", secret: true, help: "console.anthropic.com → API keys (the organization must have credit).", placeholder: "sk-ant-…", provider: "llm" },
  { key: "LLM_BASE_URL", label: "LLM base URL", group: "llm", secret: false, help: "Only for openai_compatible, e.g. https://openrouter.ai/api/v1.", provider: "llm" },
  { key: "LLM_MODEL", label: "Reasoning model", group: "llm", secret: false, help: "Planning, replies, vision QC. Default claude-sonnet-5.", placeholder: "claude-sonnet-5" },
  { key: "LLM_FAST_MODEL", label: "Fast model", group: "llm", secret: false, help: "Classification, moderation, memory. Default claude-haiku-4-5-20251001.", placeholder: "claude-haiku-4-5-20251001" },
  // Generation providers
  { key: "KIE_API_KEY", label: "kie.ai key", group: "generation", secret: true, help: "kie.ai → API keys. The default image provider.", provider: "kie" },
  { key: "KIE_API_KEY_2", label: "kie.ai key 2 (failover)", group: "generation", secret: true, help: "Used when key 1 is out of credits (402).", provider: "kie" },
  { key: "KIE_API_KEY_3", label: "kie.ai key 3 (failover)", group: "generation", secret: true, help: "Second failover key.", provider: "kie" },
  { key: "HIGGSFIELD_API_KEY", label: "Higgsfield API key", group: "generation", secret: true, help: "cloud.higgsfield.ai → API keys. Enables Soul ID character models.", provider: "higgsfield" },
  { key: "HIGGSFIELD_API_SECRET", label: "Higgsfield API secret", group: "generation", secret: true, help: "Paired with the Higgsfield key.", provider: "higgsfield" },
  { key: "FAL_KEY", label: "fal.ai key", group: "generation", secret: true, help: "fal.ai → Keys. Large model marketplace (images, upscale, video).", provider: "fal" },
  { key: "REPLICATE_API_TOKEN", label: "Replicate token", group: "generation", secret: true, help: "replicate.com → Account → API tokens.", provider: "replicate" },
  { key: "RUNWAY_API_KEY", label: "Runway key", group: "generation", secret: true, help: "dev.runwayml.com → API keys. Video.", provider: "runway" },
  { key: "LUMA_API_KEY", label: "Luma key", group: "generation", secret: true, help: "lumalabs.ai → API. Images and video.", provider: "luma" },
  { key: "TOPVIEW_API_KEY", label: "Topview key", group: "generation", secret: true, help: "topview.ai → API. Video and reference workflows.", provider: "topview" },
  { key: "TOPVIEW_UID", label: "Topview UID", group: "generation", secret: false, help: "Topview account UID sent with the key.", provider: "topview" },
  // Storage
  { key: "SUPABASE_URL", label: "Supabase URL", group: "storage", secret: false, help: "Public media hosting (first choice).", placeholder: "https://xxxx.supabase.co", provider: "supabase" },
  { key: "SUPABASE_SERVICE_ROLE_KEY", label: "Supabase service role key", group: "storage", secret: true, help: "Supabase → Project settings → API.", provider: "supabase" },
  { key: "SUPABASE_BUCKET", label: "Supabase bucket", group: "storage", secret: false, help: "Created automatically if missing.", placeholder: "ai-agent-media" },
  { key: "IMGBB_API_KEY", label: "imgbb key", group: "storage", secret: true, help: "Fallback public hosting.", provider: "imgbb" },
  // Instagram / Meta
  { key: "INSTAGRAM_APP_ID", label: "Instagram app ID", group: "instagram", secret: false, help: "Meta app → Instagram → API setup with Instagram login.", provider: "meta" },
  { key: "INSTAGRAM_APP_SECRET", label: "Instagram app secret", group: "instagram", secret: true, help: "Same page. Verifies webhooks and powers Connect Instagram.", provider: "meta" },
  { key: "FACEBOOK_APP_SECRET", label: "Facebook app secret", group: "instagram", secret: true, help: "Only if your app signs webhooks with the Facebook secret." },
  { key: "WEBHOOK_VERIFY_TOKEN", label: "Webhook verify token", group: "instagram", secret: true, help: "Only if Meta points straight at this service (not via OpenReply)." },
  // OpenReply
  { key: "OPENREPLY_RELAY_SECRET", label: "OpenReply relay secret", group: "openreply", secret: true, help: "Must equal AGENT_RELAY_SECRET on OpenReply." },
  { key: "OPENREPLY_DEFER_KEYWORDS", label: "Keywords OpenReply answers", group: "openreply", secret: false, help: "Comma-separated campaign keywords; the agent stays silent on them.", placeholder: "LINK, GUIDE" },
  // Alerts
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", group: "alerts", secret: true, help: "@BotFather token for review/failure alerts.", provider: "telegram" },
  { key: "TELEGRAM_CHAT_ID", label: "Telegram chat ID", group: "alerts", secret: false, help: "Your chat id (send /start to the bot, then check getUpdates).", provider: "telegram" },
];

const DEFS = new Map(SETTINGS.map((s) => [s.key, s]));
const TTL_MS = 15_000;
let cache: { at: number; values: Map<string, string> } | undefined;

async function load(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  let rows: Array<{ key: string; value_enc: string | null; value_plain: string | null }>;
  try {
    rows = await many("SELECT key, value_enc, value_plain FROM app_settings");
  } catch {
    // Database unreachable (or not migrated yet): keep serving the last known values, else env only.
    return cache?.values ?? new Map();
  }
  const values = new Map<string, string>();
  const k = env().ENCRYPTION_KEY;
  for (const r of rows) {
    if (r.value_enc && k) {
      try {
        values.set(r.key, decrypt(r.value_enc, k));
      } catch {
        // Encrypted with a different ENCRYPTION_KEY: treat as unset rather than crash.
      }
    } else if (r.value_plain !== null) values.set(r.key, r.value_plain);
  }
  cache = { at: Date.now(), values };
  return values;
}

export function invalidateSettings(): void {
  cache = undefined;
}

/** Resolved value (app setting → env var → undefined). */
export async function setting(key: string): Promise<string | undefined> {
  const v = (await load()).get(key);
  if (v !== undefined && v !== "") return v;
  const e = (env() as unknown as Record<string, unknown>)[key] ?? process.env[key];
  return typeof e === "string" && e.trim() !== "" ? e.trim() : undefined;
}

export async function settings(keys: string[]): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = await setting(k);
  return out;
}

export async function setSetting(key: string, value: string, by = "operator"): Promise<void> {
  const def = DEFS.get(key);
  if (!def) throw new Error(`Unknown setting ${key}`);
  const v = value.trim();
  if (def.choices && v && !def.choices.includes(v)) throw new Error(`${def.label} must be one of ${def.choices.join(", ")}`);
  const k = env().ENCRYPTION_KEY;
  if (def.secret && !k && env().NODE_ENV === "production") throw new Error("ENCRYPTION_KEY is required to store secrets");
  const enc = def.secret && k ? encrypt(v, k) : null;
  await one(
    `INSERT INTO app_settings (key, value_enc, value_plain, is_secret, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, value_plain = EXCLUDED.value_plain,
       is_secret = EXCLUDED.is_secret, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, enc, enc ? null : v, def.secret, by],
  );
  invalidateSettings();
}

export async function clearSetting(key: string): Promise<void> {
  await one("DELETE FROM app_settings WHERE key = $1", [key]);
  invalidateSettings();
}

export function mask(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export interface SettingView extends SettingDef {
  source: "app" | "env" | "unset";
  display: string;
  updatedAt: Date | null;
}

/** What the Config page may show: never a full secret. */
export async function settingsView(): Promise<SettingView[]> {
  const values = await load();
  const meta = new Map(
    (await many<{ key: string; updated_at: Date }>("SELECT key, updated_at FROM app_settings")).map((r) => [r.key, r.updated_at]),
  );
  return SETTINGS.map((d) => {
    const appV = values.get(d.key);
    const envV = (env() as unknown as Record<string, unknown>)[d.key] ?? process.env[d.key];
    const hasApp = appV !== undefined && appV !== "";
    const hasEnv = typeof envV === "string" && envV.trim() !== "";
    const v = hasApp ? appV : hasEnv ? String(envV) : undefined;
    return {
      ...d,
      source: hasApp ? "app" : hasEnv ? "env" : "unset",
      display: d.secret ? mask(v) : (v ?? ""),
      updatedAt: meta.get(d.key) ?? null,
    };
  });
}

export async function kieKeys(): Promise<string[]> {
  return (await Promise.all(["KIE_API_KEY", "KIE_API_KEY_2", "KIE_API_KEY_3"].map((k) => setting(k)))).filter((k): k is string => Boolean(k));
}

export async function deferKeywords(): Promise<string[]> {
  return ((await setting("OPENREPLY_DEFER_KEYWORDS")) ?? "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}
