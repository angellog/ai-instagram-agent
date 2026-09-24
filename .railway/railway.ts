/**
 * Railway infrastructure (Infrastructure as Code; railway.json is deprecated
 * and stops being read 2026-12-01, see docs/RESEARCH.md §0).
 *
 *   railway config plan    # preview
 *   railway config apply   # converge
 *
 * Secrets are never in this file: `preserve()` keeps the value set in Railway
 * (see docs/deployment/RAILWAY.md for the one-time `railway variables` step).
 */
import { defineRailway, github, postgres, preserve, project, redis, service } from "railway/iac";

const SECRETS = [
  "ADMIN_TOKEN",
  "ENCRYPTION_KEY",
  "OPENREPLY_RELAY_SECRET",
  "OPENREPLY_DEFER_KEYWORDS",
  "WEBHOOK_VERIFY_TOKEN",
  "INSTAGRAM_APP_ID",
  "INSTAGRAM_APP_SECRET",
  "INSTAGRAM_ACCOUNT_ID",
  "INSTAGRAM_ACCESS_TOKEN",
  "LLM_API_KEY",
  "KIE_API_KEY",
  "KIE_API_KEY_2",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "IMGBB_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
] as const;

export default defineRailway(() => {
  const db = postgres("postgres");
  const cache = redis("redis");
  const source = github("angellog/ai-instagram-agent", { branch: "main" });

  const shared = {
    NODE_ENV: "production",
    DATABASE_URL: db.env.DATABASE_URL,
    REDIS_URL: cache.env.REDIS_URL,
    LLM_PROVIDER: "anthropic",
    LLM_MODEL: "claude-sonnet-5",
    LLM_FAST_MODEL: "claude-haiku-4-5-20251001",
    KIE_IMAGE_MODEL: "nano-banana-pro",
    ...Object.fromEntries(SECRETS.map((k) => [k, preserve()])),
  };

  // Webhooks (Meta direct + OpenReply relay), OAuth, admin dashboard.
  const web = service("web", {
    source,
    build: "npm run build",
    start: "node dist/main.js",
    healthcheck: "/health",
    healthcheckTimeout: 60,
    env: { ...shared, ROLE: "web", PUBLIC_BASE_URL: preserve() },
  });

  // BullMQ workers + job schedulers. Split from web so image generation or a
  // crash in a job never costs webhook availability.
  const worker = service("worker", {
    source,
    build: "npm run build",
    start: "node dist/main.js",
    env: { ...shared, ROLE: "worker", PUBLIC_BASE_URL: preserve() },
  });

  return project("ai-instagram-agent", { resources: [db, cache, web, worker] });
});
