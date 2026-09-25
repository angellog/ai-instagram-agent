import { maybeInfluencer } from "../context.js";
import { one } from "../db/pool.js";
import { logger } from "./logger.js";

export type EventLevel = "debug" | "info" | "warn" | "error";

/**
 * Durable operational event (shown on the dashboard) + structured log line.
 * Never throws: observability must not break the pipeline it observes.
 */
export async function recordEvent(level: EventLevel, source: string, message: string, data: Record<string, unknown> = {}): Promise<void> {
  const inf = maybeInfluencer();
  logger[level]({ source, influencer: inf?.slug, ...data }, message);
  try {
    await one("INSERT INTO system_events (influencer_id, level, source, message, data) VALUES ($1, $2, $3, $4, $5)", [
      inf?.id ?? null,
      level,
      source,
      message,
      JSON.stringify(data),
    ]);
  } catch (err) {
    logger.error({ err, source, message }, "failed to persist system event");
  }
}
