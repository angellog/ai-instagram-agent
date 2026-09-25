import { FlowProducer, Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

/**
 * Queue topology (brief §15). Job names follow the brief; queues group them by
 * resource profile so each gets its own concurrency:
 *
 *   events        instagram.event                       fast, many
 *   conversation  conversation.process, memory.extract  LLM-bound
 *   content       content.plan, carousel.compose,
 *                 image.generate (flow children)        slow, costly
 *   publish       post.publish                          strictly serial
 *   analytics     engagement.collect, analytics.process, account.collect
 *   maintenance   token.refresh, memory.expire, reviews.expire
 */
export const QUEUES = ["events", "conversation", "content", "publish", "analytics", "maintenance"] as const;
export type QueueName = (typeof QUEUES)[number];

export const JOBS = {
  instagramEvent: "instagram.event",
  conversationProcess: "conversation.process",
  memoryExtract: "memory.extract",
  contentPlan: "content.plan",
  contentProduce: "content.produce",
  imageGenerate: "image.generate",
  carouselCompose: "carousel.compose",
  postPublish: "post.publish",
  engagementCollect: "engagement.collect",
  analyticsProcess: "analytics.process",
  accountCollect: "account.collect",
  tokenRefresh: "token.refresh",
  memoryExpire: "memory.expire",
  reviewsExpire: "reviews.expire",
  calendarRecap: "calendar.recap",
  benchmarkRun: "generation.benchmark",
  hatchFaces: "hatch.faces",
  sweep: "maintenance.sweep",
} as const;

export const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 5,
  // "smart" = exponential from 10s, but honours a RateLimitedError's retryAfter
  // (see backoffStrategy in worker.ts).
  backoff: { type: "smart", delay: 10_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

let connection: Redis | undefined;
const queues = new Map<QueueName, Queue>();
let flow: FlowProducer | undefined;

export function redis(): Redis {
  // Producer connection (web requests, schedulers). Unlike worker connections
  // it must fail fast when Redis is down, so the webhook can answer 503 and
  // let Meta retry instead of hanging the request.
  connection ??= new Redis(env().REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 5_000, enableReadyCheck: true, family: 0 });
  return connection;
}

/** A fresh connection (BullMQ workers need their own blocking connection). */
export function newRedis(): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, family: 0 });
}

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redis(), prefix: env().QUEUE_PREFIX, defaultJobOptions: DEFAULT_JOB_OPTS });
    queues.set(name, q);
  }
  return q;
}

export function flowProducer(): FlowProducer {
  flow ??= new FlowProducer({ connection: redis(), prefix: env().QUEUE_PREFIX });
  return flow;
}

/** BullMQ custom ids may not contain ":" and may not be purely numeric. */
export function jobId(...parts: Array<string | number>): string {
  return parts
    .map((p) => String(p).replace(/[^A-Za-z0-9_.-]/g, "_"))
    .join("-");
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (flow) {
    await flow.close();
    flow = undefined;
  }
  if (connection) {
    const c = connection;
    connection = undefined;
    await c.quit().catch(() => c.disconnect());
  }
}

export async function queueCounts(): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const name of QUEUES) {
    out[name] = await queue(name).getJobCounts("waiting", "active", "delayed", "failed", "completed", "waiting-children");
  }
  return out;
}
