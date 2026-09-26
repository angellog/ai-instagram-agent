import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { many, one } from "../../src/db/pool.js";
import { COMPOSE_TIMEOUT_MS } from "../../src/influencers/compose.js";
import { PERSONA_STALE_MS } from "../../src/influencers/hatch.js";
import { TimeoutError } from "../../src/lib/async.js";
import { createDevLLM, createDevMockProvider } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { JOBS, queue } from "../../src/queue/queues.js";
import { HANDLERS } from "../../src/queue/worker.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";

/**
 * Regression: hatching "Kemigisha Cynthiana" failed with "llm persona.compose
 * timed out after 90000ms". A whole persona takes the model longer than the
 * default per-call limit, and it used to run inside the page request.
 */
let app: FastifyInstance;
beforeEach(async () => {
  await resetState({ mode: "human_approval" });
  app ??= await buildServer();
});
afterEach(() => setLLM(createDevLLM()));
afterAll(async () => {
  await app?.close();
  await teardown();
});

const post = (url: string, body: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const loc = (r: { headers: Record<string, unknown> }) => decodeURIComponent(String(r.headers.location ?? ""));
const brief = { name: "Kemigisha Cynthiana", niche: "fashion and campus life", city: "Mbarara, Uganda", language: "English,Runyankore, Luganda" };
const personaJobs = async () => (await queue("maintenance").getJobs(["waiting", "delayed"])).filter((j) => j.name === JOBS.hatchPersona);
const runJob = (j: Job) => HANDLERS[JOBS.hatchPersona]({ name: JOBS.hatchPersona, data: j.data } as unknown as Job);
const state = async (id: number) => (await one<{ hatch_state: Record<string, unknown> }>("SELECT hatch_state FROM influencers WHERE id = $1", [id]))!.hatch_state;

describe("Hatch: persona is written in the background", () => {
  it("answers at once, gives the model a long time limit, and lands on the persona step", async () => {
    const mock = createDevMockProvider();
    setLLM(new LLM(mock, 90_000));
    const r = await post("/admin/hatch", brief);
    const inf = (await one<{ id: number }>("SELECT id FROM influencers WHERE name = 'Kemigisha Cynthiana'"))!;
    expect(loc(r)).toMatch(new RegExp(`/admin/hatch/${inf.id}\\?flash=Writing Kemigisha Cynthiana's persona`));
    expect(mock.calls).toHaveLength(0); // nothing slow ran inside the request
    const [job] = await personaJobs();
    expect(await runJob(job)).toMatchObject({ status: "done" });
    const call = mock.calls.find((c) => c.operation === "persona.compose")!;
    expect(call.timeoutMs).toBe(COMPOSE_TIMEOUT_MS);
    expect(call.maxTokens).toBeGreaterThanOrEqual(10_000); // room for the whole closet
    expect(call.messages[0].content).toContain("Languages: English,Runyankore, Luganda");
    // The instructions name only slots the schema accepts (they used to ask for "early_morning"/"midday").
    expect(call.system).toContain("EXACTLY one of: morning, late_morning, lunch, afternoon, evening, night");
    expect(call.system).not.toMatch(/early_morning|midday/);
    expect(await state(inf.id)).toMatchObject({ persona_status: "done", step: "persona" });
    // Costs and events belong to the new influencer, not whoever is selected.
    expect(await many("SELECT DISTINCT influencer_id::int AS i FROM cost_ledger WHERE operation = 'persona.compose'")).toEqual([{ i: Number(inf.id) }]);
  });

  it("a failed draft keeps the brief and offers a retry that works", async () => {
    setLLM(new LLM(createDevMockProvider().on("persona.compose", () => Promise.reject(new TimeoutError("llm persona.compose", 90_000))), 90_000));
    await post("/admin/hatch", brief);
    const inf = (await one<{ id: number }>("SELECT id FROM influencers WHERE name = 'Kemigisha Cynthiana'"))!;
    const [job] = await personaJobs();
    expect(await runJob(job)).toMatchObject({ status: "failed" });
    const page = await app.inject({ url: `/admin/hatch/${inf.id}` });
    expect(page.body).toContain("The persona draft failed");
    expect(page.body).toContain("timed out");
    expect(page.body).toContain('value="fashion and campus life"'); // brief kept
    expect(page.body).not.toContain('http-equiv="refresh"');
    expect(await one("SELECT 1 AS x FROM system_events WHERE influencer_id = $1 AND message LIKE 'Persona draft failed%'", [inf.id])).toEqual({ x: 1 });

    setLLM(createDevLLM());
    const retry = await post(`/admin/hatch/${inf.id}/compose`, brief);
    expect(loc(retry)).toMatch(/Writing Kemigisha Cynthiana's persona/);
    const latest = (await state(inf.id)).persona_batch;
    const again = (await personaJobs()).find((j) => j.data.batch === latest)!;
    expect(await runJob(again)).toMatchObject({ status: "done" });
    expect((await one<{ persona_yaml: string }>("SELECT persona_yaml FROM influencers WHERE id = $1", [inf.id]))!.persona_yaml).toMatch(/name: Kemigisha Cynthiana/);
  });

  it("ignores double taps, superseded jobs and lost jobs", async () => {
    await post("/admin/hatch", brief);
    const inf = (await one<{ id: number }>("SELECT id FROM influencers WHERE name = 'Kemigisha Cynthiana'"))!;
    const busy = await post(`/admin/hatch/${inf.id}/compose`, brief);
    expect(loc(busy)).toMatch(/Already writing/);
    expect(await personaJobs()).toHaveLength(1);
    const [first] = await personaJobs();
    // A newer request wins; the older job does nothing.
    await one("UPDATE influencers SET hatch_state = hatch_state || '{\"persona_batch\":\"newer\"}' WHERE id = $1", [inf.id]);
    expect(await runJob(first)).toMatchObject({ status: "superseded" });
    // A job the worker lost (restart) stops the spinner and offers a retry.
    const old = new Date(Date.now() - PERSONA_STALE_MS - 1000).toISOString();
    await one(`UPDATE influencers SET hatch_state = hatch_state || jsonb_build_object('persona_status','running','persona_queued_at',$2::text) WHERE id = $1`, [inf.id, old]);
    const page = await app.inject({ url: `/admin/hatch/${inf.id}` });
    expect(page.body).toContain("worker restarted");
    expect(page.body).toContain("Compose persona");
  });

  it("refuses an incomplete brief without creating a half influencer", async () => {
    const r = await post("/admin/hatch", { name: "Nobody", niche: "", city: "Kampala" });
    expect(loc(r)).toMatch(/Not saved: name, niche and city are required.*tone=bad/);
    expect(await one("SELECT 1 AS x FROM influencers WHERE name = 'Nobody'")).toBeUndefined();
  });
});
