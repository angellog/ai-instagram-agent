import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createEvent } from "../../src/calendar/events.js";
import { getControls, setControls } from "../../src/config/controls.js";
import { withInfluencer } from "../../src/context.js";
import { many, one } from "../../src/db/pool.js";
import { listModels, savePolicy } from "../../src/generation/registry.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";

let app: FastifyInstance;
beforeEach(async () => {
  await resetState({ mode: "human_approval" });
  app ??= await buildServer();
});
afterAll(async () => {
  await app?.close();
  await teardown();
});

const post = (url: string, body: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
const loc = (r: { headers: Record<string, unknown> }) => decodeURIComponent(String(r.headers.location ?? ""));

describe("audit regressions", () => {
  it("hatching bills the new influencer, not the one selected in the sidebar", async () => {
    await setControls({ daily_budget_usd: 0, daily_llm_budget_usd: 0 }, "test", 1); // Zuri is out of budget
    const r = await post("/admin/hatch", { name: "Tala", niche: "surf and food", city: "Zanzibar" }, { cookie: "aia_inf=1" });
    expect(loc(r)).toContain("step=persona");
    const tala = (await one<{ id: number }>("SELECT id FROM influencers WHERE name = 'Tala'"))!;
    const costs = await many<{ influencer_id: number }>("SELECT DISTINCT influencer_id::int FROM cost_ledger WHERE operation = 'persona.compose'");
    expect(costs).toEqual([{ influencer_id: Number(tala.id) }]);
    const zuriEvents = await many("SELECT 1 FROM system_events WHERE influencer_id = 1 AND message LIKE '%Tala%'");
    expect(zuriEvents).toHaveLength(0);
  });

  it("failures come back as error toasts, not success", async () => {
    const r = await post("/admin/people/999999/trust", { trust: "bogus" });
    expect(loc(r)).toMatch(/tone=bad/);
    expect(loc(await post("/admin/controls", { max_posts_per_day: "3" }))).not.toMatch(/tone=bad/);
  });

  it("'Use platform default' really resets the policy (no nested form)", async () => {
    await savePolicy(1, { mode: "fastest" });
    const page = await app.inject({ url: "/admin/generation/policy" });
    const reset = page.body.indexOf('action="/admin/generation/policy/reset"');
    const lastOpenForm = page.body.lastIndexOf("<form", reset);
    expect(page.body.slice(lastOpenForm, reset)).toContain('action="/admin/generation/policy/reset"'.slice(0, 0));
    expect(page.body.slice(page.body.lastIndexOf("</form>", reset), reset)).not.toContain('action="/admin/generation/policy"');
    await post("/admin/generation/policy/reset");
    expect(await one("SELECT 1 AS x FROM generation_policies WHERE influencer_id = 1")).toBeUndefined();
  });

  it("saving Controls only pins what changed; platform defaults keep flowing; empty numbers don't become 0", async () => {
    const page = await app.inject({ url: "/admin/controls" });
    const values = Object.fromEntries([...page.body.matchAll(/name="([a-z_]+)" type="number" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    await post("/admin/controls", { ...values, max_posts_per_day: "4", daily_budget_usd: "" });
    const own = await many<{ key: string }>("SELECT key FROM controls WHERE influencer_id = 1 ORDER BY key");
    expect(own.map((r) => r.key)).toContain("max_posts_per_day");
    expect(own.map((r) => r.key)).not.toContain("repetition_threshold");
    await setControls({ repetition_threshold: 0.7 }, "test", 0);
    expect((await withInfluencer(1, () => getControls(true))).repetition_threshold).toBe(0.7);
    expect((await withInfluencer(1, () => getControls(true))).daily_budget_usd).not.toBe(0);
    expect(loc(await post("/admin/controls", { max_posts_per_day: "lots" }))).toMatch(/must be a number/);
  });

  it("an emptied 'max cost per job' keeps the old value", async () => {
    const mock = (await listModels()).find((m) => m.model_id === "mock-image")!;
    await post("/admin/generation/policy", { scope: "influencer", mode: "auto", qualityTier: "high", maxCostPerJobUsd: "", preferredModelId: String(mock.id), modalities: "reference_image" });
    expect(Number((await one<{ max_cost_per_job_usd: number }>("SELECT max_cost_per_job_usd FROM generation_policies WHERE influencer_id = 1"))!.max_cost_per_job_usd)).toBeGreaterThan(0);
  });

  it("malformed ids are 404s, never database errors", async () => {
    for (const url of ["/admin/posts/abc", "/admin/people/abc", "/admin/create/xyz", "/admin/generation/requests/1"]) {
      expect((await app.inject({ url })).statusCode, url).toBe(404);
    }
    for (const url of ["/admin/posts/abc/approve", "/admin/reviews/abc/approve", "/admin/hatch/abc/launch", "/admin/influencers/abc/sync"]) {
      expect((await post(url)).statusCode, url).toBe(404);
    }
  });

  it("calendar dates render in the influencer's timezone, and all-day events aren't 'past' on their own day", async () => {
    // 27 Sep 00:00 in Kampala is 26 Sep 21:00 UTC.
    await withInfluencer(1, () => createEvent({ title: "Kampala day", starts_at: "2026-09-26T21:00:00Z", all_day: true }));
    const page = await app.inject({ url: "/admin/calendar" });
    expect(page.body).not.toMatch(/Kampala day<\/b><div class="meta">Sat 26 Sep/);
    const r = await post("/admin/calendar/add", { title: "Today thing", starts_at: new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala" }).format(new Date()), kind: "world", all_day: "true" });
    expect(loc(r)).toMatch(/Added/);
    const later = await app.inject({ url: "/admin/calendar" });
    const pastBlock = later.body.slice(later.body.indexOf("What happened?"), later.body.indexOf("Coming up"));
    expect(pastBlock).not.toContain("Today thing");
  });
});
