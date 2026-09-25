import { UnrecoverableError, Worker, type Job } from "bullmq";
import { env } from "../config/env.js";
import { currentInfluencer, listInfluencers, loadInfluencer, withInfluencer } from "../context.js";
import { recapCalendar } from "../calendar/recap.js";
import { runBenchmark } from "../generation/benchmark.js";
import { generateFaceCandidates } from "../influencers/hatch.js";
import { one } from "../db/pool.js";
import { processWebhookEvent } from "../ingest/process.js";
import { processInteraction } from "../conversation/agent.js";
import { extractMemories } from "../memory/extract.js";
import { expireMemories } from "../memory/store.js";
import { planContent } from "../content/director.js";
import { failPost, producePost } from "../content/produce.js";
import { publishPost } from "../content/publish.js";
import { collectAccount, collectEngagement, processAnalytics } from "../analytics/learnings.js";
import { refreshExpiringTokens } from "../instagram/accounts.js";
import { errorMessage, PermanentError, RateLimitedError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { logger } from "../lib/logger.js";
import { notify } from "../notify/telegram.js";
import { expireReviews } from "../web/reviews.js";
import { JOBS, newRedis, queue, type QueueName } from "./queues.js";
import { sweep } from "./sweeper.js";

type Handler = (job: Job) => Promise<unknown>;

/**
 * Jobs created before v1.0.0 carry no influencerId; they all belonged to the
 * first (and then only) influencer.
 */
function ownerOf(job: Job): number {
  const id = Number(job.data?.influencerId ?? 1);
  if (!Number.isInteger(id) || id < 1) throw new PermanentError(`job ${job.name} has invalid influencerId`);
  return id;
}

/** Run a handler inside the owning influencer's context (persona, keys, account, budgets). */
const scoped =
  (fn: (job: Job) => Promise<unknown>): Handler =>
  (job) =>
    withInfluencer(ownerOf(job), () => fn(job));

/** Run a periodic per-influencer task for every active influencer; one failure never blocks the rest. */
export async function forEachActiveInfluencer<T>(label: string, fn: () => Promise<T>): Promise<Record<string, T | { error: string }>> {
  const out: Record<string, T | { error: string }> = {};
  for (const inf of await listInfluencers(["active"])) {
    try {
      out[inf.slug] = await withInfluencer(Number(inf.id), fn);
    } catch (e) {
      out[inf.slug] = { error: errorMessage(e) };
      await recordEvent("error", "worker", `${label} failed for ${inf.slug}`, { influencerId: inf.id, error: errorMessage(e) });
    }
  }
  return out;
}

/** Content planning only runs for active influencers (paused/hatching ones stay quiet). */
async function planIfActive(): Promise<unknown> {
  const inf = currentInfluencer();
  if (inf.status !== "active") return { skipped: `influencer is ${inf.status}` };
  return planContent();
}

/** Job name → handler. Every handler is idempotent (see each module). */
export const HANDLERS: Record<string, Handler> = {
  // Platform: routes each entry to its owning influencer itself.
  [JOBS.instagramEvent]: (j) => processWebhookEvent(j.data.webhookEventId),
  // Entity jobs: scoped to the owner carried in the job data.
  [JOBS.conversationProcess]: scoped((j) => processInteraction(j.data.interactionId)),
  [JOBS.memoryExtract]: scoped((j) => extractMemories(j.data.interactionId)),
  [JOBS.contentPlan]: (j) => (j.data?.influencerId ? scoped(planIfActive)(j) : forEachActiveInfluencer("content plan", planContent)),
  [JOBS.contentProduce]: scoped((j) => producePost(j.data.postId)),
  [JOBS.postPublish]: scoped((j) => publishPost(j.data.postId)),
  [JOBS.engagementCollect]: scoped((j) => collectEngagement(j.data.postId, j.data.checkpoint)),
  // Periodic per-influencer work.
  [JOBS.analyticsProcess]: () => forEachActiveInfluencer("analytics", processAnalytics),
  [JOBS.accountCollect]: () => forEachActiveInfluencer("account snapshot", () => collectAccount()),
  [JOBS.memoryExpire]: () => forEachActiveInfluencer("memory expiry", expireMemories),
  [JOBS.calendarRecap]: () => forEachActiveInfluencer("calendar recap", () => recapCalendar()),
  [JOBS.hatchFaces]: scoped((j) => generateFaceCandidates(String(j.data.batch ?? Date.now()))),
  [JOBS.benchmarkRun]: scoped((j) => runBenchmark((j.data.modelIds as number[]).map(Number), Number(j.data.maxUsd ?? 2), String(j.data.tag ?? Date.now()))),
  // Platform-wide maintenance.
  [JOBS.tokenRefresh]: () => refreshExpiringTokens(),
  [JOBS.reviewsExpire]: () => expireReviews(),
  [JOBS.sweep]: () => sweep(),
};

const CONCURRENCY: Record<QueueName, number> = {
  events: 10,
  conversation: 4,
  content: 1,
  publish: 1,
  analytics: 2,
  maintenance: 1,
};

// Per-job time limits (brief §15: every job supports a timeout).
const TIMEOUT_MS: Record<string, number> = {
  [JOBS.instagramEvent]: 30_000,
  [JOBS.conversationProcess]: 3 * 60_000,
  [JOBS.memoryExtract]: 2 * 60_000,
  [JOBS.contentPlan]: 6 * 60_000,
  [JOBS.contentProduce]: 45 * 60_000,
  [JOBS.benchmarkRun]: 60 * 60_000,
  [JOBS.hatchFaces]: 20 * 60_000,
  [JOBS.postPublish]: 15 * 60_000,
};

export async function runJob(job: Job): Promise<unknown> {
  const handler = HANDLERS[job.name];
  if (!handler) throw new UnrecoverableError(`No handler for job "${job.name}"`);
  const limit = TIMEOUT_MS[job.name] ?? 5 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handler(job),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`job ${job.name} timed out after ${limit}ms`)), limit);
      }),
    ]);
  } catch (e) {
    // Permanent errors fail once and loudly instead of burning retries.
    if (e instanceof PermanentError) throw new UnrecoverableError(`${e.name}: ${e.message}`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function backoffStrategy(attemptsMade: number, _type?: string, err?: Error): number {
  if (err instanceof RateLimitedError && err.retryAfterMs) return err.retryAfterMs;
  if (err?.name === "RateLimitedError") return 15 * 60_000;
  return Math.min(10_000 * 2 ** Math.max(0, attemptsMade - 1), 30 * 60_000);
}

async function logRun(queueName: string, job: Job, status: "completed" | "failed" | "retrying", error?: string): Promise<void> {
  const duration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null;
  await one("INSERT INTO job_runs (queue, job_name, job_id, status, attempt, duration_ms, error, influencer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
    queueName,
    job.name,
    job.id ?? "",
    status,
    job.attemptsMade,
    duration,
    error?.slice(0, 1000) ?? null,
    job.data?.influencerId ? Number(job.data.influencerId) : null,
  ]).catch((err) => logger.error({ err }, "failed to log job run"));
}

/** Final-failure compensation: leave no entity stuck in a transient state. */
async function onFinalFailure(job: Job, err: Error): Promise<void> {
  if (job.data?.influencerId) {
    await withInfluencer(ownerOf(job), () => compensate(job, err)).catch((e) => logger.error({ err: e }, "compensation failed"));
  } else {
    await compensate(job, err);
  }
}

async function compensate(job: Job, err: Error): Promise<void> {
  const msg = errorMessage(err);
  switch (job.name) {
    case JOBS.contentProduce:
      await failPost(job.data.postId, "failed", `production failed: ${msg}`);
      await notify(`❌ Content production failed: ${msg.slice(0, 200)}`, `/admin/posts/${job.data.postId}`);
      break;
    case JOBS.postPublish:
      await one("UPDATE posts SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND influencer_id = $3 AND status IN ('approved','publishing')", [
        job.data.postId,
        msg.slice(0, 1000),
        ownerOf(job),
      ]);
      await notify(`❌ Publishing gave up after retries: ${msg.slice(0, 200)}`, `/admin/posts/${job.data.postId}`);
      break;
    case JOBS.conversationProcess:
      await one("UPDATE interactions SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND influencer_id = $3 AND status IN ('pending','processing')", [
        job.data.interactionId,
        msg.slice(0, 500),
        ownerOf(job),
      ]);
      break;
    case JOBS.instagramEvent:
      await one("UPDATE webhook_events SET status = 'failed', error = $2 WHERE id = $1", [job.data.webhookEventId, msg.slice(0, 500)]);
      break;
  }
  await recordEvent("error", "worker", `Job ${job.name} failed permanently`, { jobId: job.id, attempts: job.attemptsMade, error: msg });
}

export function startWorkers(): Worker[] {
  const e = env();
  const workers: Worker[] = [];
  for (const name of Object.keys(CONCURRENCY) as QueueName[]) {
    const w = new Worker(name, runJob, {
      connection: newRedis(),
      prefix: e.QUEUE_PREFIX,
      concurrency: CONCURRENCY[name],
      settings: { backoffStrategy },
      // Long jobs (image generation) must not be declared stalled while waiting on kie.
      lockDuration: name === "content" ? 10 * 60_000 : 60_000,
      maxStalledCount: 2,
    });
    w.on("completed", (job) => void logRun(name, job, "completed"));
    w.on("failed", (job, err) => {
      if (!job) return;
      const final = err instanceof UnrecoverableError || err.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);
      void logRun(name, job, final ? "failed" : "retrying", errorMessage(err));
      if (final) void onFinalFailure(job, err);
    });
    w.on("error", (err) => logger.error({ err, queue: name }, "worker error"));
    workers.push(w);
  }
  logger.info({ queues: Object.keys(CONCURRENCY) }, "workers started");
  return workers;
}

/**
 * Recurring work (brief §19). BullMQ v6 job schedulers are idempotent by id,
 * so every boot simply upserts them. Platform jobs run in UTC; each active
 * influencer gets its own content-plan scheduler in *their* timezone.
 */
export async function upsertSchedulers(): Promise<void> {
  const s: Array<[QueueName, string, { pattern?: string; every?: number }, string]> = [
    ["analytics", "analytics-process", { pattern: "30 3 * * *" }, JOBS.analyticsProcess],
    ["analytics", "account-collect", { pattern: "50 23 * * *" }, JOBS.accountCollect],
    ["maintenance", "token-refresh", { pattern: "10 4 * * *" }, JOBS.tokenRefresh],
    ["maintenance", "memory-expire", { pattern: "40 2 * * *" }, JOBS.memoryExpire],
    ["maintenance", "calendar-recap", { pattern: "15 * * * *" }, JOBS.calendarRecap],
    ["maintenance", "reviews-expire", { pattern: "5 * * * *" }, JOBS.reviewsExpire],
    ["maintenance", "sweep", { every: 10 * 60_000 }, JOBS.sweep],
  ];
  for (const [q, id, repeat, name] of s) {
    await queue(q).upsertJobScheduler(id, repeat.pattern ? { pattern: repeat.pattern, tz: "UTC" } : { every: repeat.every! }, {
      name,
      data: {},
      opts: { attempts: 3, backoff: { type: "smart", delay: 30_000 } },
    });
  }
  // v0 had one global content-plan scheduler; it is replaced by per-influencer ones.
  await queue("content").removeJobScheduler("content-plan").catch(() => undefined);
  await syncInfluencerSchedulers();
}

export const planSchedulerId = (influencerId: number) => `content-plan-${influencerId}`;

/**
 * Upsert a content-plan scheduler for every active influencer (in their
 * persona timezone) and remove it for paused/archived ones. Called at boot and
 * whenever an influencer is hatched, paused, resumed or re-personaed.
 */
export async function syncInfluencerSchedulers(): Promise<{ active: number; removed: number }> {
  const planCron = process.env.CONTENT_PLAN_CRON ?? "20 8,12,16,19 * * *";
  let active = 0;
  let removed = 0;
  for (const inf of await listInfluencers(["active", "paused", "hatching", "archived"])) {
    const id = Number(inf.id);
    if (inf.status !== "active") {
      if (await queue("content").removeJobScheduler(planSchedulerId(id)).catch(() => false)) removed++;
      continue;
    }
    let tz = "UTC";
    try {
      tz = (await loadInfluencer(id)).persona.identity.timezone;
    } catch (e) {
      await recordEvent("warn", "worker", `No valid persona for ${inf.slug}; not scheduling content`, { error: errorMessage(e) });
      continue;
    }
    try {
      await queue("content").upsertJobScheduler(planSchedulerId(id), { pattern: planCron, tz }, {
        name: JOBS.contentPlan,
        data: { influencerId: id },
        opts: { attempts: 3, backoff: { type: "smart", delay: 30_000 } },
      });
      active++;
    } catch (e) {
      // A bad cron or timezone must never take the whole worker down.
      await recordEvent("error", "worker", `Could not schedule content for ${inf.slug}`, { cron: planCron, tz, error: errorMessage(e) });
    }
  }
  logger.info({ active, removed, planCron }, "job schedulers upserted");
  return { active, removed };
}
