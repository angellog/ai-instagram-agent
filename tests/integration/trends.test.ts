import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setControls } from "../../src/config/controls.js";
import { planContent } from "../../src/content/director.js";
import { many, one } from "../../src/db/pool.js";
import { createDevMockProvider } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { setTrendsFetch } from "../../src/trends/feeds.js";
import { refreshTrends, trendsForPrompt } from "../../src/trends/trends.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";

const now = new Date().toUTCString();
const rss = (items: string[]) =>
  `<rss><channel><title>Feed</title>${items.map((t, i) => `<item><title>${t}</title><link>https://news.example/${encodeURIComponent(t)}-${i}</link><pubDate>${now}</pubDate></item>`).join("")}</channel></rss>`;

let app: FastifyInstance;
let requested: string[];
beforeEach(async () => {
  await resetState({ posting_window_start_hour: 0, posting_window_end_hour: 24 });
  requested = [];
  setTrendsFetch(async (url) => {
    requested.push(String(url));
    const u = String(url);
    const items = u.includes("sneakernews")
      ? ["Air Max Day restock lands in East Africa", "President speaks at opposition rally"]
      : ["Kampala street style week draws big crowds", "Three killed in highway accident", "Nyege Nyege lineup announced"];
    return new Response(rss(items), { status: 200 });
  });
  app ??= await buildServer();
});
afterAll(async () => {
  setTrendsFetch(undefined);
  await app?.close();
  await teardown();
});

describe("trends and news awareness", () => {
  it("reads every source, drops politics and tragedy, and keeps a short brief", async () => {
    const r = await refreshTrends();
    expect(requested.some((u) => u.startsWith("https://news.google.com/rss/search?q=sneakers%20release"))).toBe(true);
    expect(requested).toContain("https://sneakernews.com/feed/");
    expect(r.kept).toBeGreaterThan(0);
    const b = await one<{ items: Array<{ title: string }> }>("SELECT items FROM trend_briefs ORDER BY id DESC LIMIT 1");
    const titles = b!.items.map((i) => i.title).join(" | ");
    expect(titles).not.toMatch(/President|killed/);
    expect(await many("SELECT 1 FROM trend_items")).not.toHaveLength(0);
    expect(await trendsForPrompt("content")).toMatch(/^- /);
  });

  it("the director and replies see this week's trends; weekends get weekend ideas", async () => {
    await refreshTrends();
    const mock = createDevMockProvider();
    setLLM(new LLM(mock));
    const saturday = new Date("2026-10-03T09:00:00Z"); // 12:00 in Kampala
    await setControls({ paused: false });
    await planContent(saturday, { operator: true });
    const prompt = mock.calls.find((c) => c.operation === "content.plan")!.messages[0].content as string;
    expect(prompt).toMatch(/TRENDS AND NEWS THIS WEEK/);
    expect(prompt).toMatch(/IT'S THE WEEKEND/);
    expect(prompt).toMatch(/one piece, three ways/);
  });

  it("the Trends page renders, refreshes and turns a headline into a calendar event", async () => {
    expect(new URL(String((await app.inject({ method: "POST", url: "/admin/trends/refresh" })).headers.location), "http://x").searchParams.get("flash")).toMatch(/kept from/);
    const page = await app.inject({ url: "/admin/trends" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("This week&#39;s brief");
    await app.inject({ method: "POST", url: "/admin/trends/0/calendar" });
    expect(await one("SELECT kind FROM calendar_events")).toEqual({ kind: "culture" });
    const again = await app.inject({ method: "POST", url: "/admin/trends/0/calendar" });
    expect(new URL(String(again.headers.location), "http://x").searchParams.get("flash")).toBe("Already on the calendar");
  });
});
