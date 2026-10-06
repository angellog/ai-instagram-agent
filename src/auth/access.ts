import type { ControlKey } from "../config/controls.js";

/**
 * What a tenant (an influencer's business) may reach. Enforced once, before any
 * route runs, so a typed URL is refused the same as a hidden menu item. Tenants
 * operate their own influencer day to day; onboarding, platform settings,
 * routing and anything that spends across influencers stay with the admin.
 */

/** Admin-only path prefixes (method-independent). */
const ADMIN_ONLY = [
  "/admin/influencers",
  "/admin/hatch",
  "/admin/standard",
  "/admin/config",
  "/admin/users",
  "/admin/switch",
  "/admin/connect",
  "/admin/costs/platform",
  "/admin/generation/policy",
  "/admin/generation/benchmarks",
  "/admin/generation/models",
  "/admin/generation/providers",
  "/admin/actions/sweep",
  "/admin/soul",
  "/admin/instagram/attach",
  "/admin/instagram/subscribe",
  "/admin/simulate",
  "/api/",
];

/** Admin-only on write (tenants may look but not change). */
const ADMIN_WRITE_ONLY = ["/admin/persona"];

export function tenantMayAccess(method: string, path: string): boolean {
  const p = path.split("?")[0].replace(/\/+$/, "") || "/";
  if (ADMIN_ONLY.some((a) => p === a || p.startsWith(`${a}/`) || (a.endsWith("/") && p.startsWith(a)))) return false;
  if (method !== "GET" && method !== "HEAD" && ADMIN_WRITE_ONLY.some((a) => p === a)) return false;
  return true;
}

/** Controls a tenant sees but can't change: spend, the AI brain, platform caps. */
export const ADMIN_CONTROLS: ControlKey[] = [
  "llm_brain",
  "daily_budget_usd",
  "monthly_budget_usd",
  "daily_llm_budget_usd",
  "daily_image_budget_usd",
  "max_retries_per_image",
  "daily_x_api_budget_usd",
  "x_daily_read_cap",
  "reels_per_week",
  "max_reel_seconds",
];
