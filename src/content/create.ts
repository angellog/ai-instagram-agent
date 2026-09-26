import { influencerId } from "../context.js";
import { many, one } from "../db/pool.js";
import { errorMessage } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { JOBS, jobId, queue } from "../queue/queues.js";
import { planContent } from "./director.js";
import { producePost } from "./produce.js";

/**
 * "Create a post now": one tap runs the real pipeline (plan → generate →
 * quality check → safety) for the selected influencer and always stops for
 * review. Progress is read from the rows the pipeline already writes, so the
 * progress page shows what is actually happening, not a timer.
 */

export const STAGES = [
  { key: "planning", label: "Picking an idea that fits today" },
  { key: "generating", label: "Shooting the photos" },
  { key: "checking", label: "Quality & safety check" },
  { key: "ready", label: "Ready for you" },
] as const;
export type Stage = (typeof STAGES)[number]["key"] | "queued";

export interface CreateRun {
  id: string;
  influencer_id: number;
  status: "queued" | "running" | "done" | "failed";
  stage: Stage;
  post_id: string | null;
  outcome: string | null;
  message: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

async function setRun(id: string, patch: Partial<Pick<CreateRun, "status" | "stage" | "post_id" | "outcome" | "message">>): Promise<void> {
  await one(
    `UPDATE create_runs SET status = coalesce($2, status), stage = coalesce($3, stage), post_id = coalesce($4, post_id),
       outcome = coalesce($5, outcome), message = coalesce($6, message), updated_at = now(),
       finished_at = CASE WHEN $2 IN ('done','failed') THEN now() ELSE finished_at END
     WHERE id = $1`,
    [id, patch.status ?? null, patch.stage ?? null, patch.post_id ?? null, patch.outcome ?? null, patch.message ?? null],
  );
}

/** Start a run for the current influencer; at most one active run at a time. */
export async function startCreate(by: string): Promise<{ id: string; existing: boolean }> {
  const active = await one<{ id: string }>(
    "SELECT id FROM create_runs WHERE influencer_id = $1 AND status IN ('queued','running') AND updated_at > now() - interval '30 minutes' ORDER BY created_at DESC LIMIT 1",
    [influencerId()],
  );
  if (active) return { id: active.id, existing: true };
  const run = await one<{ id: string }>("INSERT INTO create_runs (influencer_id, created_by) VALUES ($1, $2) RETURNING id", [influencerId(), by]);
  await queue("content").add(JOBS.contentCreate, { influencerId: influencerId(), runId: run!.id }, { jobId: jobId("create", run!.id), attempts: 1 });
  return { id: run!.id, existing: false };
}

/** `content.create` job. */
export async function runCreate(runId: string): Promise<string> {
  const run = await one<CreateRun>("SELECT * FROM create_runs WHERE id = $1 AND influencer_id = $2", [runId, influencerId()]);
  if (!run || run.status === "done" || run.status === "failed") return "skipped";
  try {
    await setRun(runId, { status: "running", stage: "planning" });
    const plan = await planContent(new Date(), { operator: true });
    if (plan.status !== "accepted") {
      const why = "reason" in plan && plan.reason ? plan.reason : plan.status;
      const friendly =
        plan.status === "rejected_all"
          ? "Every idea was too close to recent posts. Add something to the calendar or wait for new activity, then try again."
          : plan.status === "waited"
            ? "The director found nothing worth posting right now."
            : `Couldn't start: ${why}`;
      await setRun(runId, { status: "failed", outcome: plan.status, message: `${friendly}\n\nDetails: ${why}`.slice(0, 1200) });
      return plan.status;
    }
    await setRun(runId, { stage: "generating", post_id: plan.postId });
    const outcome = await producePost(plan.postId);
    const ok = ["awaiting_review", "dry_run", "approved"].includes(outcome);
    await setRun(runId, {
      status: ok ? "done" : "failed",
      stage: ok ? "ready" : "checking",
      outcome,
      message: ok ? "Your post is ready: publish it now or schedule it." : outcome === "qc_failed" ? "The photos didn't pass the quality check." : outcome === "rejected" ? "The safety check blocked this post." : "Production stopped (see the post for details).",
    });
    await recordEvent(ok ? "info" : "warn", "content", `Create-now run ${outcome}`, { runId, postId: plan.postId });
    return outcome;
  } catch (e) {
    await setRun(runId, { status: "failed", message: errorMessage(e).slice(0, 400) });
    throw e;
  }
}

export interface Progress {
  id: string;
  status: CreateRun["status"];
  stage: Stage;
  pct: number;
  steps: Array<{ key: string; label: string; state: "done" | "active" | "pending" | "failed" }>;
  detail: string;
  postId: string | null;
  outcome: string | null;
  message: string | null;
  slides: { done: number; total: number; urls: string[] };
  topic: string | null;
  caption: string | null;
  elapsedMs: number;
}

/**
 * Progress from real pipeline rows. Within the planning stage (a single LLM
 * call) the bar eases toward its stage ceiling over time so it never looks
 * stuck; everything after is measured (slides hosted, attempts running).
 */
export async function createProgress(runId: string, now = Date.now()): Promise<Progress | undefined> {
  const run = await one<CreateRun>("SELECT * FROM create_runs WHERE id = $1 AND influencer_id = $2", [runId, influencerId()]);
  if (!run) return undefined;
  const elapsedMs = (run.finished_at ? new Date(run.finished_at).getTime() : now) - new Date(run.created_at).getTime();
  let total = 0;
  let urls: string[] = [];
  let running = 0;
  let topic: string | null = null;
  let caption: string | null = null;
  let postStatus: string | null = null;
  if (run.post_id) {
    const p = await one<{ status: string; caption: string; topic: string | null; slides: number }>(
      `SELECT p.status, p.caption, ci.topic, coalesce(jsonb_array_length(ci.plan->'slides'), 1) AS slides
       FROM posts p LEFT JOIN content_ideas ci ON ci.id = p.content_idea_id WHERE p.id = $1`,
      [run.post_id],
    );
    total = p?.slides ?? 1;
    topic = p?.topic ?? null;
    caption = p?.caption ?? null;
    postStatus = p?.status ?? null;
    urls = (await many<{ public_url: string }>("SELECT public_url FROM post_assets WHERE post_id = $1 AND public_url IS NOT NULL ORDER BY position", [run.post_id])).map((r) => r.public_url);
    running = (await one<{ n: number }>("SELECT count(*)::int AS n FROM generation_attempts WHERE post_id = $1 AND status IN ('queued','submitted')", [run.post_id]))?.n ?? 0;
  }
  const done = urls.length;
  const allShot = total > 0 && done >= total;
  let stage: Stage = run.stage;
  if (stage === "generating" && allShot) stage = "checking";
  if (run.status === "done") stage = "ready";

  const ease = (ms: number, span: number) => 1 - Math.exp(-ms / span);
  let pct: number;
  if (run.status === "done") pct = 100;
  else if (stage === "queued") pct = 2;
  else if (stage === "planning") pct = 4 + 18 * ease(elapsedMs, 25_000);
  else if (stage === "generating") pct = 24 + 62 * ((done + (running ? 0.5 : 0)) / Math.max(total, 1));
  else pct = 90;
  // Only a finished run reaches 100%; a running one never claims it.
  if (run.status !== "done") pct = Math.min(pct, 99);
  pct = Math.round(pct * 10) / 10;

  const order = STAGES.map((s) => s.key) as string[];
  const cur = order.indexOf(stage);
  const steps = STAGES.map((s, i) => ({
    key: s.key,
    label: s.label,
    state: (run.status === "failed" && i === Math.max(cur, 0) ? "failed" : i < cur || run.status === "done" ? "done" : i === cur ? "active" : "pending") as Progress["steps"][number]["state"],
  }));
  const detail =
    run.status === "failed"
      ? "Stopped."
      : stage === "queued"
        ? "Starting…"
        : stage === "planning"
          ? "Reading the calendar, recent posts and today's outfit…"
          : stage === "generating"
            ? `Photo ${Math.min(done + 1, total)} of ${total}${running ? " is being generated" : ""}`
            : stage === "checking"
              ? "Checking identity, anatomy, text and safety…"
              : (run.message ?? "Ready");
  return { id: run.id, status: run.status, stage, pct, steps, detail, postId: run.post_id, outcome: run.outcome ?? postStatus, message: run.message, slides: { done, total, urls }, topic, caption, elapsedMs };
}

export async function recentRuns(limit = 5): Promise<CreateRun[]> {
  return many<CreateRun>("SELECT * FROM create_runs WHERE influencer_id = $1 ORDER BY created_at DESC LIMIT $2", [influencerId(), limit]);
}
