import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setting } from "../../src/config/settings.js";
import { setControls } from "../../src/config/controls.js";
import { withInfluencer } from "../../src/context.js";
import { many, one } from "../../src/db/pool.js";
import { runBenchmark } from "../../src/generation/benchmark.js";
import { listModels } from "../../src/generation/registry.js";
import { JOBS, queue } from "../../src/queue/queues.js";
import { HANDLERS } from "../../src/queue/worker.js";
import { setStorageFetch } from "../../src/storage/host.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";
import sharp from "sharp";

let app: FastifyInstance;
beforeEach(async () => {
  await resetState();
  app ??= await buildServer();
});
afterAll(async () => {
  await app?.close();
  await teardown();
});

const form = (url: string, body: Record<string, string | string[]>, cookie = "") => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) for (const x of ([] as string[]).concat(v)) p.append(k, x);
  return app.inject({ method: "POST", url, payload: p.toString(), headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) } });
};
const json = (url: string, body: unknown, cookie = "") =>
  app.inject({ method: "POST", url, payload: JSON.stringify(body), headers: { "content-type": "application/json", accept: "application/json", ...(cookie ? { cookie } : {}) } });
const flash = (r: { headers: Record<string, unknown> }) => decodeURIComponent(String(r.headers.location ?? "").split("#")[0]).replace(/^.*flash=/, "");
const cookieOf = (r: { headers: Record<string, unknown> }) => String(([] as string[]).concat((r.headers["set-cookie"] as string | string[]) ?? [])[0] ?? "").split(";")[0];

describe("Config page", () => {
  it("saves keys encrypted, shows them masked, and clears back to env", async () => {
    const r = await form("/admin/config", { _group: "generation", FAL_KEY: "fal-abcdef-1234567890", REPLICATE_API_TOKEN: "" });
    expect(flash(r)).toBe("Saved 1 setting");
    expect(await setting("FAL_KEY")).toBe("fal-abcdef-1234567890");
    const page = await app.inject({ url: "/admin/config" });
    expect(page.body).toContain("fal-••••7890");
    expect(page.body).not.toContain("fal-abcdef-1234567890");
    expect(page.body).toMatch(/Setup checklist/);
    const cleared = await form("/admin/config", { _group: "generation", clear: "FAL_KEY" });
    expect(flash(cleared)).toBe("Saved 1 setting");
    expect(await setting("FAL_KEY")).toBeUndefined();
  });

  it("rejects invalid choices with a readable message", async () => {
    const r = await form("/admin/config", { _group: "llm", LLM_PROVIDER: "skynet" });
    expect(flash(r)).toMatch(/^Not saved: .*must be one of/);
  });

  it("Test buttons answer JSON for async forms", async () => {
    const r = await app.inject({ method: "POST", url: "/admin/config/test/llm", headers: { accept: "application/json" } });
    expect(r.json()).toEqual({ ok: true, message: "LLM answered: OK" });
    const g = await app.inject({ method: "POST", url: "/admin/config/test/fal", headers: { accept: "application/json" } });
    expect(g.json()).toMatchObject({ ok: false, message: "fal: not configured" });
  });
});

describe("Calendar", () => {
  it("creates, lists, moves, records an outcome and deletes events through the JSON API", async () => {
    const start = new Date(Date.now() + 2 * 86400_000).toISOString();
    const c = await json("/admin/api/calendar", { title: "Nyege Nyege festival", starts_at: start, all_day: true, kind: "culture", importance: 3, shared: true });
    expect(c.json()).toMatchObject({ ok: true, event: { title: "★ Nyege Nyege festival", color: expect.any(String) } });
    const id = c.json().event.id;
    const list = await app.inject({ url: `/admin/api/calendar?start=${new Date().toISOString()}&end=${new Date(Date.now() + 7 * 86400_000).toISOString()}` });
    expect(list.json().map((e: { id: string }) => e.id)).toContain(id);
    const moved = await json(`/admin/api/calendar/${id}`, { starts_at: new Date(Date.now() - 86400_000).toISOString(), all_day: true });
    expect(moved.json().ok).toBe(true);
    const out = await form(`/admin/calendar/${id}/outcome`, { outcome: "Danced until sunrise by the Nile." });
    expect(flash(out)).toMatch(/becomes a memory/);
    expect(await one("SELECT outcome, influencer_id FROM calendar_events WHERE id = $1", [Number(id)])).toEqual({ outcome: "Danced until sunrise by the Nile.", influencer_id: null });
    const page = await app.inject({ url: "/admin/calendar" });
    expect(page.body).toContain("fullcalendar@7.1.0/all/global.js");
    const bad = await json("/admin/api/calendar", { title: "", starts_at: "not a date" });
    expect(bad.statusCode).toBe(400);
    expect((await json(`/admin/api/calendar/${id}/delete`, {})).json()).toMatchObject({ ok: true });
    expect(await one("SELECT 1 AS x FROM calendar_events")).toBeUndefined();
  });

  it("quick add works without JavaScript", async () => {
    const r = await form("/admin/calendar/add", { title: "Uganda Martyrs Day", starts_at: "2026-06-03", kind: "holiday", all_day: "true" });
    expect(flash(r)).toMatch(/Added/);
    expect(await one("SELECT kind, all_day FROM calendar_events")).toEqual({ kind: "holiday", all_day: true });
  });
});

describe("Hatch: brief → persona → soul → Instagram → launch", () => {
  it("hatches a new influencer end to end", async () => {
    // 1. brief → composed persona
    const created = await form("/admin/hatch", { name: "Nova", niche: "running and street food in Nairobi", city: "Nairobi, Kenya", appearance: "dark skin, short natural hair, athletic, big smile" });
    expect(created.statusCode).toBe(303);
    const cookie = cookieOf(created);
    const inf = (await one<{ id: number; slug: string; status: string; persona_yaml: string }>("SELECT id, slug, status, persona_yaml FROM influencers WHERE name = 'Nova'"))!;
    expect(inf).toMatchObject({ slug: "nova", status: "hatching" });
    expect(inf.persona_yaml).toMatch(/name: Nova/);
    expect(cookie).toBe(`aia_inf=${inf.id}`);
    const id = Number(inf.id);
    expect(String(created.headers.location)).toContain(`/admin/hatch/${id}?step=persona`);
    expect((await app.inject({ url: `/admin/hatch/${id}?step=persona`, headers: { cookie } })).statusCode).toBe(200);

    // 2. persona saved (validated)
    const broken = await form(`/admin/hatch/${id}/persona`, { persona: "identity: [" }, cookie);
    expect(flash(broken)).toMatch(/^Not saved/);
    const saved = await form(`/admin/hatch/${id}/persona`, { persona: inf.persona_yaml }, cookie);
    expect(flash(saved)).toBe("Saved Nova");

    // 3. soul: generate face options through the engine, pick one, name the soul
    const faces = await form(`/admin/hatch/${id}/faces`, {}, cookie);
    expect(flash(faces)).toMatch(/Generating/);
    const job = (await queue("content").getJobs(["waiting"])).find((j) => j.name === JOBS.hatchFaces)!;
    expect(job.data.influencerId).toBe(id);
    await HANDLERS[JOBS.hatchFaces]({ name: JOBS.hatchFaces, data: job.data } as unknown as Job);
    const state = (await one<{ hatch_state: { faces: Array<{ url: string }>; faces_status: string } }>("SELECT hatch_state FROM influencers WHERE id = $1", [id]))!.hatch_state;
    expect(state.faces_status).toBe("done");
    expect(state.faces).toHaveLength(3);
    expect(state.faces[0].url).toContain("/influencers/nova/gen/");
    const soulPage = await app.inject({ url: `/admin/hatch/${id}?step=soul`, headers: { cookie } });
    expect(soulPage.body).toContain("Face option 1");
    const soul = await form(`/admin/hatch/${id}/soul`, { faces: [state.faces[1].url], soul_id: "soul_nova_prime" }, cookie);
    expect(flash(soul)).toMatch(/^Soul soul_nova_prime created/);
    expect(String(soul.headers.location)).toContain(`/admin/hatch/${id}?step=profile`);
    // The profile kit is prepared right after the face is chosen: paste-ready text within Instagram's limits.
    const kit = (await one<{ profile_kit: { text: { bios: Array<{ text: string }>; display_name: string } } }>("SELECT profile_kit FROM influencers WHERE id = $1", [id]))!.profile_kit;
    expect(kit.text.display_name.length).toBeLessThanOrEqual(30);
    expect(kit.text.bios.every((b) => [...b.text].length <= 150 && /\bAI\b/i.test(b.text))).toBe(true);
    const profilePage = await app.inject({ url: `/admin/hatch/${id}?step=profile`, headers: { cookie } });
    expect(profilePage.body).toContain("data-copy");
    expect(await one("SELECT soul_id, status FROM souls WHERE influencer_id = $1", [id])).toEqual({ soul_id: "soul_nova_prime", status: "active" });
    expect(await one("SELECT avatar_url FROM influencers WHERE id = $1", [id])).toEqual({ avatar_url: state.faces[1].url });

    // 4. Instagram (skipped here; attach is covered in isolation tests)
    const bad = await form(`/admin/hatch/${id}/instagram`, { token: "short" }, cookie);
    expect(flash(bad)).toMatch(/does not look like/);
    expect(flash(await form(`/admin/hatch/${id}/instagram/skip`, {}, cookie))).toBe("Skipped Instagram for now");

    // 5. launch
    const launch = await form(`/admin/hatch/${id}/launch`, { mode: "dry_run", max_posts_per_day: "1", daily_budget_usd: "2", daily_image_budget_usd: "1", plan_now: "1" }, cookie);
    expect(flash(launch)).toMatch(/Nova is live/);
    expect(String(launch.headers.location)).toMatch(/^\/admin\?/);
    expect(await one("SELECT status FROM influencers WHERE id = $1", [id])).toEqual({ status: "active" });
    expect(await many("SELECT key, value FROM controls WHERE influencer_id = $1 AND key IN ('mode','max_posts_per_day') ORDER BY key", [id])).toEqual([
      { key: "max_posts_per_day", value: 1 },
      { key: "mode", value: "dry_run" },
    ]);
    const schedulers = await queue("content").getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toEqual(expect.arrayContaining([`content-plan-${id}`, "content-plan-1"]));
    const plan = (await queue("content").getJobs(["waiting"])).find((j) => j.name === JOBS.contentPlan);
    expect(plan?.data).toMatchObject({ influencerId: id });

    // The console now shows Nova.
    const home = await app.inject({ url: "/admin", headers: { cookie } });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("<title>Overview · Nova</title>");
    // …and the planner works in her context.
    await setControls({ posting_window_start_hour: 0, posting_window_end_hour: 24 }, "test", id); // independent of the wall clock
    const planned = (await withInfluencer(id, async () => (await import("../../src/content/director.js")).planContent())) as { status: string; reason?: string };
    expect(planned, JSON.stringify(planned)).toMatchObject({ status: "accepted" });
  });

  it("the switcher remembers the chosen influencer", async () => {
    await form("/admin/hatch", { name: "Kofi", niche: "tech reviews", city: "Accra, Ghana" });
    const kofi = (await one<{ id: number }>("SELECT id FROM influencers WHERE name = 'Kofi'"))!;
    const r = await form("/admin/switch", { id: String(kofi.id) });
    expect(cookieOf(r)).toBe(`aia_inf=${kofi.id}`);
    expect(String(r.headers.location)).toBe(`/admin/hatch/${kofi.id}`); // still hatching
    const back = await form("/admin/switch", { id: "1" });
    expect(cookieOf(back)).toBe("aia_inf=1");
    expect((await app.inject({ url: "/admin", headers: { cookie: "aia_inf=1" } })).body).toContain("Overview · Zuri");
  });
});

describe("Generation Control Center", () => {
  it("saves routing policy and previews the route without spending", async () => {
    const models = await listModels();
    const mock = models.find((m) => m.model_id === "mock-image")!;
    const r = await form("/admin/generation/policy", {
      scope: "influencer",
      mode: "fixed",
      qualityTier: "standard",
      maxCostPerJobUsd: "0.4",
      preferredModelId: String(mock.id),
      fallback0: "",
      modalities: ["text_to_image", "reference_image"],
    });
    expect(flash(r)).toBe("Policy saved");
    expect(await one("SELECT mode, preferred_model_id::int AS p, allowed_modalities FROM generation_policies WHERE influencer_id = 1")).toEqual({
      mode: "fixed",
      p: mock.id,
      allowed_modalities: ["text_to_image", "reference_image"],
    });
    const page = await app.inject({ url: "/admin/generation/policy" });
    expect(page.body).toContain("Route preview");
    expect(page.body).toContain("Mock image (offline)");
    expect(flash(await form("/admin/generation/policy/reset", {}))).toMatch(/platform default/);
  });

  it("toggles models and providers", async () => {
    const m = (await listModels()).find((x) => x.model_id === "mock-image")!;
    expect(flash(await form(`/admin/generation/models/${m.id}/toggle`, {}))).toBe("mock-image disabled");
    expect(flash(await form("/admin/generation/providers/fal/toggle", {}))).toBe("fal disabled");
  });

  it("benchmarks a model, judges it and feeds scores back to the registry", async () => {
    const jpeg = await sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 120, g: 80, b: 60 } } }).jpeg().toBuffer();
    setStorageFetch(async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } }));
    const m = (await listModels()).find((x) => x.model_id === "mock-image")!;
    const r = await withInfluencer(1, () => runBenchmark([m.id], 1, "t1"));
    expect(r).toMatchObject({ runs: 3, failed: 0 });
    const rows = await many<{ case_id: string; status: string; scores: { overall: number } }>("SELECT case_id, status, scores FROM benchmark_runs ORDER BY id");
    expect(rows.map((x) => x.case_id)).toEqual(["portrait", "outfit", "detail"]);
    expect(rows.every((x) => x.status === "succeeded" && x.scores.overall > 0)).toBe(true);
    expect(await one("SELECT scores_source FROM generation_models WHERE id = $1", [m.id])).toEqual({ scores_source: "benchmark" });
    const page = await app.inject({ url: "/admin/generation/benchmarks" });
    expect(page.body).toContain("Leaderboard");
    setStorageFetch(fetch);
  });
});

describe("Profile kit", () => {
  it("writes paste-ready profile text and makes a circle-safe profile picture from the soul", async () => {
    const face = await sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 90, g: 60, b: 40 } } }).jpeg().toBuffer();
    setStorageFetch(async () => new Response(new Uint8Array(face), { status: 200, headers: { "content-type": "image/jpeg" } }));
    expect(flash(await form("/admin/profile/text", {}))).toBe("Profile text written");
    expect(flash(await form("/admin/profile/picture/crop", {}))).toMatch(/cropped/);
    expect(flash(await form("/admin/profile/picture/generate", {}))).toMatch(/designed/);
    const kit = (await one<{ profile_kit: { text: { usernames: string[]; highlights: string[]; bios: Array<{ text: string }> }; pictures: Array<{ url: string; kind: string }> } }>("SELECT profile_kit FROM influencers WHERE id = 1"))!.profile_kit;
    expect(kit.text.usernames.every((u) => /^[a-z0-9._]{3,30}$/.test(u))).toBe(true);
    expect(kit.text.highlights.every((h) => [...h].length <= 15)).toBe(true);
    expect(kit.text.bios.every((b) => [...b.text].length <= 150 && /\bAI\b/i.test(b.text))).toBe(true);
    expect(kit.pictures.map((p) => p.kind)).toEqual(["generated", "crop"]);
    expect(kit.pictures[1].url).toContain("/influencers/zuri/profile/pp-crop-");
    const page = await app.inject({ url: "/admin/profile" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("pp-circle");
    setStorageFetch(fetch);
  });
});
