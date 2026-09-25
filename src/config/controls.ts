import { z } from "zod";
import { maybeInfluencer } from "../context.js";
import { many, one } from "../db/pool.js";

/**
 * Runtime operational controls (brief §27). Stored in the `controls` table so
 * they can be changed from the admin dashboard without a deploy. Defaults are
 * deliberately conservative: a fresh install runs in human-approval mode.
 */
export const controlsSchema = z.object({
  // development: mock providers allowed, no external writes
  // dry_run: full pipeline incl. LLM/images, but nothing is sent or published
  // human_approval: everything that would go out waits for a reviewer
  // autonomous: GREEN goes out automatically, YELLOW per require_review_for_yellow
  mode: z.enum(["development", "dry_run", "human_approval", "autonomous"]).default("human_approval"),
  paused: z.boolean().default(false),

  conversation_enabled: z.boolean().default(true),
  content_enabled: z.boolean().default(true),
  image_generation_enabled: z.boolean().default(true),
  carousel_generation_enabled: z.boolean().default(true),
  require_review_for_yellow: z.boolean().default(true),

  max_posts_per_day: z.number().int().min(0).default(2),
  min_hours_between_posts: z.number().min(0).default(6),
  max_comment_replies_per_hour: z.number().int().min(0).default(30),
  max_dms_per_hour: z.number().int().min(0).default(40),
  // Probability of replying to a comment the agent judged worth answering but
  // not required (keeps the account from answering everything).
  optional_reply_rate: z.number().min(0).max(1).default(0.6),

  daily_budget_usd: z.number().min(0).default(3),
  monthly_budget_usd: z.number().min(0).default(60),
  daily_llm_budget_usd: z.number().min(0).default(1.5),
  daily_image_budget_usd: z.number().min(0).default(2),
  max_retries_per_image: z.number().int().min(0).max(5).default(2),

  repetition_threshold: z.number().min(0).max(1).default(0.62),
  max_concept_attempts: z.number().int().min(1).max(10).default(4),
  // Local hours (persona timezone) when publishing is allowed.
  posting_window_start_hour: z.number().int().min(0).max(23).default(8),
  posting_window_end_hour: z.number().int().min(1).max(24).default(22),
  // Platform-wide ceilings across ALL influencers (read from influencer 0 only).
  platform_daily_budget_usd: z.number().min(0).default(15),
  platform_monthly_budget_usd: z.number().min(0).default(300),
});

export type Controls = z.infer<typeof controlsSchema>;
export type ControlKey = keyof Controls;

/** influencer_id 0 holds platform-wide values: defaults for every influencer. */
export const PLATFORM = 0;

const TTL_MS = 5_000;
const cache = new Map<number, { at: number; value: Controls }>();

async function rows(influencerId: number): Promise<Record<string, unknown>> {
  const r = await many<{ key: string; value: unknown }>("SELECT key, value FROM controls WHERE influencer_id = $1", [influencerId]);
  const out: Record<string, unknown> = {};
  for (const row of r) if (row.key in controlsSchema.shape) out[row.key] = row.value;
  return out;
}

/**
 * Effective controls: schema defaults < platform values < influencer values.
 * Without an explicit id the current influencer context is used.
 */
export async function getControls(force = false, id?: number): Promise<Controls> {
  const influencer = id ?? maybeInfluencer()?.id ?? PLATFORM;
  const hit = cache.get(influencer);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const platform = await rows(PLATFORM);
  const own = influencer === PLATFORM ? {} : await rows(influencer);
  const value = controlsSchema.parse({ ...platform, ...own });
  cache.set(influencer, { at: Date.now(), value });
  return value;
}

export async function setControls(patch: Partial<Controls>, by = "operator", id?: number): Promise<Controls> {
  const influencer = id ?? maybeInfluencer()?.id ?? PLATFORM;
  const current = await getControls(true, influencer);
  const next = controlsSchema.parse({ ...current, ...patch });
  for (const key of Object.keys(patch)) {
    await one(
      `INSERT INTO controls (influencer_id, key, value, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (influencer_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [influencer, key, JSON.stringify((next as Record<string, unknown>)[key]), by],
    );
  }
  invalidateControls();
  return next;
}

export function invalidateControls(): void {
  cache.clear();
}

/** True when nothing may leave the system (no IG writes). */
export function isSendingDisabled(c: Controls): boolean {
  return c.paused || c.mode === "development" || c.mode === "dry_run";
}
