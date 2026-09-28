import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { getControls } from "../../src/config/controls.js";
import { one } from "../../src/db/pool.js";
import { createInfluencer, updatePersona } from "../../src/influencers/manage.js";
import { evaluate } from "../../src/influencers/standard.js";
import { createDevLLM, createDevMockProvider } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { JOBS, queue } from "../../src/queue/queues.js";
import { HANDLERS } from "../../src/queue/worker.js";
import { setStorageFetch } from "../../src/storage/host.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";
import { thinPersona } from "../helpers/personas.js";

let app: FastifyInstance;
beforeEach(async () => {
  await resetState({ mode: "human_approval" });
  const jpeg = await sharp({ create: { width: 900, height: 1100, channels: 3, background: { r: 120, g: 90, b: 70 } } }).jpeg().toBuffer();
  setStorageFetch(async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } }));
  app ??= await buildServer();
});
afterEach(() => setLLM(createDevLLM()));
afterAll(async () => {
  await app?.close();
  setStorageFetch(fetch);
  await teardown();
});

const form = (url: string, body: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
const flash = (r: { headers: Record<string, unknown> }) => new URLSearchParams(String(r.headers.location ?? "").split("?")[1]?.split("#")[0] ?? "").get("flash") ?? "";

async function thinInfluencer(): Promise<number> {
  const inf = await createInfluencer({ name: "Thin Tina" });
  await updatePersona(Number(inf.id), thinPersona().replace(/^  name: .+$/m, "  name: Thin Tina"), "", "test");
  await one("UPDATE influencers SET status = 'active' WHERE id = $1", [inf.id]);
  return Number(inf.id);
}

describe("bringing an influencer up to the standard", () => {
  it("fills only the sections that fall short, adds the AI-disclosure entry, and lists what needs a person", async () => {
    const id = await thinInfluencer();
    const before = await evaluate(id);
    expect(before.looks).toBeLessThan(250);
    expect(before.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual(expect.arrayContaining(["closet", "weekend", "weekend_ideas", "kb_ai", "soul", "instagram"]));
    const originalVoice = (parse((await one<{ persona_yaml: string }>("SELECT persona_yaml FROM influencers WHERE id = $1", [id]))!.persona_yaml) as any).communication_style;

    const mock = createDevMockProvider();
    setLLM(new LLM(mock));
    const r = await form(`/admin/standard/${id}`);
    expect(flash(r)).toMatch(/Bringing it up to standard/);
    expect(flash(await form(`/admin/standard/${id}`))).toBe("Already running"); // no duplicate runs
    const job = (await queue("maintenance").getJobs(["waiting"])).find((j) => j.name === JOBS.standardize)!;
    const run = (await HANDLERS[JOBS.standardize]({ name: JOBS.standardize, data: job.data } as unknown as Job)) as { status: string; fixed: string[]; remaining: string[] };
    expect(run.status).toBe("done");

    const after = await evaluate(id);
    const ok = (k: string) => after.checks.find((c) => c.key === k)?.ok;
    expect(after.looks).toBeGreaterThanOrEqual(250);
    for (const k of ["closet", "occasions", "weekend", "weekend_ideas", "kb_ai"]) expect(ok(k), k).toBe(true);
    expect(run.remaining.join(" | ")).toMatch(/Soul face.*Instagram connected|Instagram connected/);
    // Only the failing sections were sent and changed; the rest of her is untouched.
    const upgrade = mock.calls.find((c) => c.operation === "persona.upgrade")!;
    expect(upgrade.messages[0].content).toMatch(/exactly these keys: .*visual\.character\.closet/);
    expect(upgrade.messages[0].content).not.toMatch(/exactly these keys: .*communication_style/);
    const p = parse((await one<{ persona_yaml: string }>("SELECT persona_yaml FROM influencers WHERE id = $1", [id]))!.persona_yaml) as any;
    expect(p.identity.name).toBe("Thin Tina");
    expect(p.communication_style).toEqual(originalVoice);
  });

  it("shows every influencer on the Standard page with what's missing and how it gets fixed", async () => {
    const id = await thinInfluencer();
    const page = await app.inject({ url: "/admin/standard" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Influencer Standard");
    expect(page.body).toContain("Thin Tina");
    expect(page.body).toMatch(/4 tops \(standard 10\)/);
    expect(page.body).toContain(`action="/admin/standard/${id}"`);
    expect(page.body).toContain("AI fills it in");
    // Manual fixes switch to THIS influencer, then open the page to fix it.
    expect(page.body).toMatch(new RegExp(`name="id" value="${id}"><input type="hidden" name="to" value="/admin/persona#soul"`));
    const go = await form("/admin/switch", { id: String(id), to: "/admin/persona#soul" });
    expect(go.headers.location).toBe("/admin/persona#soul");
    expect(String(go.headers["set-cookie"])).toContain(`aia_inf=${id}`);
    expect((await form("/admin/switch", { id: String(id), to: "https://evil.example/x" })).headers.location).not.toContain("evil");
  });

  it("brings a freshly hatched persona up to standard before the operator sees it", async () => {
    const thin = thinPersona();
    setLLM(new LLM(createDevMockProvider().on("persona.compose", (r) => thin.replace(/^  name: .+$/m, `  name: ${/Name: (.+)/.exec(String(r.messages.at(-1)?.content))?.[1] ?? "X"}`))));
    await form("/admin/hatch", { name: "Nadia", niche: "running in Kampala", city: "Kampala, Uganda" });
    const inf = (await one<{ id: number }>("SELECT id FROM influencers WHERE name = 'Nadia'"))!;
    const job = (await queue("maintenance").getJobs(["waiting"])).find((j) => j.name === JOBS.hatchPersona)!;
    expect(await HANDLERS[JOBS.hatchPersona]({ name: JOBS.hatchPersona, data: job.data } as unknown as Job)).toMatchObject({ status: "done" });
    const report = await evaluate(Number(inf.id));
    expect(report.looks).toBeGreaterThanOrEqual(250);
    expect(report.checks.filter((c) => c.fix === "ai" && !c.ok)).toEqual([]);
  });
});

describe("operating-mode button", () => {
  it("sits in the sidebar switcher and changes this influencer's mode in one tap", async () => {
    const page = await app.inject({ url: "/admin/posts" });
    expect(page.body).toContain('class="modeset"');
    expect(page.body).toContain("Operating mode: Human approval");
    const r = await form("/admin/mode", { mode: "autonomous" }, { referer: "https://console.example/admin/posts?x=1" });
    expect(String(r.headers.location)).toMatch(/^\/admin\/posts\?flash=/);
    expect(flash(r)).toBe("Zuri: autonomous");
    expect((await getControls(true, 1)).mode).toBe("autonomous");
    expect((await app.inject({ url: "/admin/posts" })).body).toContain("Operating mode: Autonomous");
    expect(flash(await form("/admin/mode", { mode: "yolo" }))).toBe("Unknown mode");
    expect((await getControls(true, 1)).mode).toBe("autonomous");
  });
});
