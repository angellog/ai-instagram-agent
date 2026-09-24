import { getControls } from "../config/controls.js";
import { many, one } from "../db/pool.js";
import { BudgetExceededError } from "../lib/errors.js";

export type CostCategory = "llm" | "image" | "storage" | "api" | "compute";

export interface CostEntry {
  category: CostCategory;
  provider: string;
  model?: string;
  operation: string;
  units?: Record<string, number>;
  costUsd: number;
  refType?: string;
  refId?: string;
}

/** USD per million tokens (input, output). Update COSTS.md with any change. */
export const LLM_PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 4, output: 20 },
  mock: { input: 0, output: 0 },
};

export function llmCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  // Unknown models (e.g. an OpenRouter slug) are priced like Sonnet so budgets
  // stay conservative rather than silently free.
  const key = Object.keys(LLM_PRICES).find((k) => model === k || model.endsWith(`/${k}`));
  const p = key ? LLM_PRICES[key] : LLM_PRICES["claude-sonnet-5"];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export async function recordCost(e: CostEntry): Promise<void> {
  await one(
    `INSERT INTO cost_ledger (category, provider, model, operation, units, cost_usd, ref_type, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.category, e.provider, e.model ?? null, e.operation, JSON.stringify(e.units ?? {}), e.costUsd, e.refType ?? null, e.refId ?? null],
  );
}

export interface SpendSummary {
  today: number;
  todayLlm: number;
  todayImage: number;
  week: number;
  month: number;
}

export async function spendSummary(): Promise<SpendSummary> {
  const r = await one<{ today: number; today_llm: number; today_image: number; week: number; month: number }>(`
    SELECT
      coalesce(sum(cost_usd) FILTER (WHERE occurred_at >= date_trunc('day', now())), 0)                          AS today,
      coalesce(sum(cost_usd) FILTER (WHERE occurred_at >= date_trunc('day', now()) AND category = 'llm'), 0)     AS today_llm,
      coalesce(sum(cost_usd) FILTER (WHERE occurred_at >= date_trunc('day', now()) AND category = 'image'), 0)   AS today_image,
      coalesce(sum(cost_usd) FILTER (WHERE occurred_at >= now() - interval '7 days'), 0)                         AS week,
      coalesce(sum(cost_usd) FILTER (WHERE occurred_at >= date_trunc('month', now())), 0)                        AS month
    FROM cost_ledger`);
  return {
    today: Number(r?.today ?? 0),
    todayLlm: Number(r?.today_llm ?? 0),
    todayImage: Number(r?.today_image ?? 0),
    week: Number(r?.week ?? 0),
    month: Number(r?.month ?? 0),
  };
}

/**
 * Refuse work that would push spend past a configured limit. Called *before*
 * the money is spent, with a conservative estimate.
 */
export async function assertBudget(category: CostCategory, estimateUsd: number): Promise<void> {
  const [c, s] = await Promise.all([getControls(), spendSummary()]);
  if (over(s.today, estimateUsd, c.daily_budget_usd)) {
    throw new BudgetExceededError(`Daily budget $${c.daily_budget_usd} reached (spent $${s.today.toFixed(4)})`);
  }
  if (over(s.month, estimateUsd, c.monthly_budget_usd)) {
    throw new BudgetExceededError(`Monthly budget $${c.monthly_budget_usd} reached (spent $${s.month.toFixed(4)})`);
  }
  if (category === "llm" && over(s.todayLlm, estimateUsd, c.daily_llm_budget_usd)) {
    throw new BudgetExceededError(`Daily LLM budget $${c.daily_llm_budget_usd} reached`);
  }
  if (category === "image" && over(s.todayImage, estimateUsd, c.daily_image_budget_usd)) {
    throw new BudgetExceededError(`Daily image budget $${c.daily_image_budget_usd} reached`);
  }
}

/** A limit of 0 means "no spend of this kind at all", even for free calls. */
function over(spent: number, estimate: number, limit: number): boolean {
  return limit <= 0 || spent + estimate > limit;
}

/** Cost report rows for the dashboard and COSTS.md (brief §21). */
export async function costReport(): Promise<Record<string, number>> {
  const [perPost, perConv, perImage, perCarousel] = await Promise.all([
    one<{ v: number }>(`SELECT coalesce(avg(t), 0) AS v FROM (
        SELECT p.id, sum(c.cost_usd) AS t FROM posts p
        JOIN cost_ledger c ON c.ref_type = 'post' AND c.ref_id = p.id::text
        WHERE p.status = 'published' GROUP BY p.id) x`),
    one<{ v: number }>(`SELECT coalesce(avg(t), 0) AS v FROM (
        SELECT ref_id, sum(cost_usd) AS t FROM cost_ledger WHERE ref_type = 'interaction' GROUP BY ref_id) x`),
    one<{ v: number }>(`SELECT coalesce(avg(cost_usd), 0) AS v FROM cost_ledger WHERE category = 'image'`),
    one<{ v: number }>(`SELECT coalesce(avg(t), 0) AS v FROM (
        SELECT p.id, sum(c.cost_usd) AS t FROM posts p
        JOIN cost_ledger c ON c.ref_type = 'post' AND c.ref_id = p.id::text
        WHERE p.media_type = 'CAROUSEL' GROUP BY p.id) x`),
  ]);
  const s = await spendSummary();
  return {
    daily_cost: s.today,
    weekly_cost: s.week,
    monthly_cost: s.month,
    cost_per_post: Number(perPost?.v ?? 0),
    cost_per_conversation: Number(perConv?.v ?? 0),
    cost_per_image: Number(perImage?.v ?? 0),
    cost_per_carousel: Number(perCarousel?.v ?? 0),
  };
}

export async function costByOperation(days = 30): Promise<Array<{ category: string; operation: string; n: number; usd: number }>> {
  return many(
    `SELECT category, operation, count(*)::int AS n, sum(cost_usd)::float AS usd
     FROM cost_ledger WHERE occurred_at >= now() - ($1 || ' days')::interval
     GROUP BY 1, 2 ORDER BY usd DESC`,
    [String(days)],
  );
}
