import { env } from "../config/env.js";
import type { FetchLike } from "../lib/async.js";
import { logger } from "../lib/logger.js";

let fetchImpl: FetchLike = fetch;
export function setNotifyFetch(f: FetchLike): void {
  fetchImpl = f;
}

/**
 * Optional operator notification (review items, escalations, failures).
 * Send-only via the Bot API, so it can share a bot token with another app that
 * polls for updates without conflict. Silently no-ops when unconfigured and
 * never throws.
 */
export async function notify(text: string, adminPath?: string): Promise<void> {
  const e = env();
  if (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_CHAT_ID) return;
  const link = adminPath ? `\n${e.PUBLIC_BASE_URL.replace(/\/$/, "")}${adminPath}` : "";
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: e.TELEGRAM_CHAT_ID, text: `${text}${link}`.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) logger.warn({ status: r.status }, "telegram notify failed");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "telegram notify failed");
  }
}
