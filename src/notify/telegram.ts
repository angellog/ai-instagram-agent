import { env } from "../config/env.js";
import { setting } from "../config/settings.js";
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
  const [token, chatId] = [await setting("TELEGRAM_BOT_TOKEN"), await setting("TELEGRAM_CHAT_ID")];
  if (!token || !chatId) return;
  const link = adminPath ? `\n${e.PUBLIC_BASE_URL.replace(/\/$/, "")}${adminPath}` : "";
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `${text}${link}`.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) logger.warn({ status: r.status }, "telegram notify failed");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "telegram notify failed");
  }
}

/** One Bot API call that throws a readable error (for setup and tests, unlike notify()). */
async function botApi<T>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`couldn't reach Telegram (${(e as Error).message})`);
  }
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (r.status === 401 || r.status === 404) throw new Error("Telegram refused the bot token. Copy it again from @BotFather (it looks like 123456789:AA…).");
  if (r.status === 409) throw new Error("another app is already reading this bot's messages. Create a separate bot just for these alerts with @BotFather and use its token.");
  if (!r.ok || !j.ok) throw new Error(`Telegram ${method}: ${j.description ?? `HTTP ${r.status}`}`);
  return j.result as T;
}

interface Update {
  update_id: number;
  message?: { date: number; chat: { id: number; type: string; first_name?: string; username?: string; title?: string }; text?: string };
}

/**
 * Find the chat to alert: the most recent private chat that messaged the bot
 * (the operator sends it /start). Returns who it is so the console can confirm.
 */
export async function detectChatId(token: string): Promise<{ chatId: string; who: string; bot: string }> {
  const me = await botApi<{ username: string }>(token, "getMe");
  const updates = await botApi<Update[]>(token, "getUpdates", { limit: 100, allowed_updates: ["message"] });
  const latest = updates
    .map((u) => u.message)
    .filter((m): m is NonNullable<Update["message"]> => Boolean(m))
    .sort((a, b) => b.date - a.date)
    .find((m) => m.chat.type === "private") ?? updates.map((u) => u.message).filter(Boolean).at(-1);
  if (!latest) throw new Error(`no messages yet. Open Telegram, search @${me.username}, tap Start (or send it "hi"), then click Find my chat ID again.`);
  const c = latest.chat;
  return { chatId: String(c.id), who: c.username ? `@${c.username}` : (c.first_name ?? c.title ?? String(c.id)), bot: `@${me.username}` };
}

/** Send a message and throw if Telegram doesn't accept it (Config → Test telegram). */
export async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  await botApi(token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}
