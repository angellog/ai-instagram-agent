import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setSetting, setting } from "../../src/config/settings.js";
import { detectChatId, setNotifyFetch } from "../../src/notify/telegram.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";

const TOKEN = "123456789:AAtest-token";
function fakeTelegram(o: { updates?: unknown[]; status?: number } = {}) {
  const sent: Array<{ chat_id: string; text: string }> = [];
  const f = async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (o.status) return new Response(JSON.stringify({ ok: false, description: "nope" }), { status: o.status });
    if (method === "getMe") return Response.json({ ok: true, result: { username: "feetbit_alerts_bot" } });
    if (method === "getUpdates") return Response.json({ ok: true, result: o.updates ?? [] });
    if (method === "sendMessage") {
      sent.push(body);
      return Response.json({ ok: true, result: {} });
    }
    return new Response("{}", { status: 404 });
  };
  return { f, sent };
}
const msg = (id: number, date: number, chat: Record<string, unknown>) => ({ update_id: id, message: { date, text: "/start", chat } });

let app: FastifyInstance;
beforeEach(async () => {
  await resetState();
  app ??= await buildServer();
});
afterAll(async () => {
  setNotifyFetch(fetch);
  await app?.close();
  await teardown();
});

describe("Telegram alerts setup", () => {
  it("finds the operator's private chat from the latest message to the bot", async () => {
    const t = fakeTelegram({ updates: [msg(1, 100, { id: -100, type: "group", title: "Team" }), msg(2, 200, { id: 4242, type: "private", first_name: "Angelo", username: "angelo" })] });
    setNotifyFetch(t.f);
    expect(await detectChatId(TOKEN)).toEqual({ chatId: "4242", who: "@angelo", bot: "@feetbit_alerts_bot" });
  });

  it("explains exactly what to do when the bot has no messages, a bad token, or another app reads it", async () => {
    setNotifyFetch(fakeTelegram().f);
    await expect(detectChatId(TOKEN)).rejects.toThrow(/search @feetbit_alerts_bot, tap Start/);
    setNotifyFetch(fakeTelegram({ status: 401 }).f);
    await expect(detectChatId(TOKEN)).rejects.toThrow(/refused the bot token/);
    setNotifyFetch(fakeTelegram({ status: 409 }).f);
    await expect(detectChatId(TOKEN)).rejects.toThrow(/separate bot just for these alerts/);
  });

  it("Find my chat ID saves the chat and sends a confirmation; Test telegram then really sends", async () => {
    const t = fakeTelegram({ updates: [msg(5, 300, { id: 777, type: "private", first_name: "Angelo" })] });
    setNotifyFetch(t.f);
    await setSetting("TELEGRAM_BOT_TOKEN", TOKEN);
    const r = await app.inject({ method: "POST", url: "/admin/config/telegram/detect" });
    expect(decodeURIComponent(String(r.headers.location))).toContain("Connected: alerts go to Angelo via @feetbit_alerts_bot");
    expect(await setting("TELEGRAM_CHAT_ID")).toBe("777");
    expect(t.sent[0]).toMatchObject({ chat_id: "777" });
    const test = await app.inject({ method: "POST", url: "/admin/config/test/telegram" });
    expect(decodeURIComponent(String(test.headers.location))).toContain("Test message sent");
    expect(t.sent).toHaveLength(2);
    const page = await app.inject({ url: "/admin/config" });
    expect(page.body).toContain('action="/admin/config/telegram/detect"');
  });
});
