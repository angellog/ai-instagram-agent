import { readFileSync } from "node:fs";
import type { Job } from "bullmq";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getControls, setControls } from "../../src/config/controls.js";
import { withInfluencer } from "../../src/context.js";
import { many, one } from "../../src/db/pool.js";
import { createEvent, calendarBrief } from "../../src/calendar/events.js";
import { recapCalendar } from "../../src/calendar/recap.js";
import { MockAdapter } from "../../src/generation/adapters/mock.js";
import { attachInstagram, createInfluencer, setStatus, updatePersona } from "../../src/influencers/manage.js";
import { setInstagramClient, upsertAccount } from "../../src/instagram/accounts.js";
import { processWebhookEvent } from "../../src/ingest/process.js";
import { storeWebhookEvent } from "../../src/ingest/webhook.js";
import { createDevMockProvider } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { applyMemoryPolicy } from "../../src/memory/policy.js";
import { relationshipMemories, upsertMemory, worldMemories } from "../../src/memory/store.js";
import { JOBS, queue } from "../../src/queue/queues.js";
import { HANDLERS } from "../../src/queue/worker.js";
import { createSoul } from "../../src/souls/souls.js";
import { listReviews } from "../../src/web/reviews.js";
import { FakeInstagram, commentPayload } from "../helpers/fakeInstagram.js";
import { resetState, teardown, TEST_IG_ID } from "../helpers/db.js";

const AMARA_IG = "17841400000000002";
const AMARA_FACE = "https://cdn.test/amara/face.jpg";
let amara: number;
let fakeZuri: FakeInstagram;
let fakeAmara: FakeInstagram;
let llm: ReturnType<typeof createDevMockProvider>;

const run = (name: string, data: Record<string, unknown>) => HANDLERS[name]({ name, data } as unknown as Job);

beforeEach(async () => {
  await resetState();
  const zuriYaml = readFileSync("config/persona.yaml", "utf8");
  const amaraYaml = zuriYaml
    .replace("name: Zuri", "name: Amara")
    .replace('handle: "@zurikarale"', 'handle: "@amara.test"')
    .replace(/- https:\/\/oeaajqcssoukezpqtbtg[^\n]+/, `- ${AMARA_FACE}`);
  const inf = await createInfluencer({ name: "Amara", personaYaml: amaraYaml });
  amara = Number(inf.id);
  await createSoul({ influencerId: amara, identityRefs: [AMARA_FACE] });
  await setStatus(amara, "active");
  await upsertAccount({ influencerId: amara, igUserId: AMARA_IG, username: "amara.test", accessToken: "amara-token", makePrimary: true });
  await setControls({ mode: "autonomous", optional_reply_rate: 1, posting_window_start_hour: 0, posting_window_end_hour: 24 }, "test", amara);
  fakeZuri = new FakeInstagram();
  fakeAmara = new FakeInstagram();
  setInstagramClient(fakeZuri.client(), 1);
  setInstagramClient(fakeAmara.client(), amara);
  llm = createDevMockProvider();
  setLLM(new LLM(llm));
});
afterAll(() => teardown());

async function ingest(payload: object): Promise<void> {
  const ev = await storeWebhookEvent("meta", JSON.stringify(payload), payload);
  await processWebhookEvent(ev!.id);
}

describe("two influencers on one platform", () => {
  it("routes each webhook entry to the influencer that owns the account", async () => {
    const zuri = commentPayload({ commentId: "cz", text: "Love this fit!", fromId: "9001" });
    const am = commentPayload({ commentId: "ca", text: "Where is this?", fromId: "9001", accountId: AMARA_IG });
    await ingest({ object: "instagram", entry: [...zuri.entry, ...am.entry] });
    expect(await many("SELECT ig_object_id, influencer_id::int FROM interactions ORDER BY ig_object_id")).toEqual([
      { ig_object_id: "ca", influencer_id: amara },
      { ig_object_id: "cz", influencer_id: 1 },
    ]);
    expect(await one("SELECT influencer_ids FROM webhook_events")).toMatchObject({ influencer_ids: expect.arrayContaining(["1", String(amara)]) });
    // Unknown accounts are dropped, never guessed.
    await ingest(commentPayload({ commentId: "cx", text: "hi", accountId: "17849999999999999" }));
    expect(await one("SELECT 1 AS x FROM interactions WHERE ig_object_id = 'cx'")).toBeUndefined();
  });

  it("each reply is written in the owner's voice and sent from the owner's account", async () => {
    const zuri = commentPayload({ commentId: "cz", text: "Which pair today?", fromId: "9001" });
    const am = commentPayload({ commentId: "ca", text: "Which pair today?", fromId: "9001", accountId: AMARA_IG });
    await ingest({ object: "instagram", entry: [...zuri.entry, ...am.entry] });
    for (const r of await many<{ id: number; influencer_id: number }>("SELECT id, influencer_id FROM interactions ORDER BY id")) {
      await run(JOBS.conversationProcess, { influencerId: Number(r.influencer_id), interactionId: r.id });
    }
    expect(fakeZuri.replies.map((r) => r.commentId)).toEqual(["cz"]);
    expect(fakeAmara.replies.map((r) => r.commentId)).toEqual(["ca"]);
    const systems = llm.calls.filter((c) => c.operation === "conversation.decide").map((c) => c.system);
    expect(systems.some((s) => s.includes("You are Zuri"))).toBe(true);
    expect(systems.some((s) => s.includes("You are Amara"))).toBe(true);
    // Follow-up jobs (memory extraction) carry their owner.
    const followUps = await queue("conversation").getJobs(["delayed", "waiting"]);
    expect(followUps.filter((j) => j.name === JOBS.memoryExtract).map((j) => j.data.influencerId).sort()).toEqual([1, amara].sort());
    // Same Instagram user, two separate relationships.
    expect(await many("SELECT influencer_id::int FROM ig_users WHERE ig_scoped_id = '9001' ORDER BY influencer_id")).toEqual([{ influencer_id: 1 }, { influencer_id: amara }]);
  });

  it("a job cannot touch another influencer's entity", async () => {
    await ingest(commentPayload({ commentId: "cz", text: "hey", fromId: "9001" }));
    const z = await one<{ id: number }>("SELECT id FROM interactions");
    // Amara's context looking up Zuri's interaction finds nothing.
    await expect(run(JOBS.conversationProcess, { influencerId: amara, interactionId: z!.id })).rejects.toThrow();
    expect(fakeAmara.replies).toHaveLength(0);
    expect(fakeZuri.replies).toHaveLength(0);
  });

  it("memories never cross influencers", async () => {
    const v = applyMemoryPolicy({ kind: "interest", content: "Loves Air Max 90s", confidence: 0.9 });
    if (!v.store) throw new Error("policy refused");
    const userZ = await one<{ id: number }>("INSERT INTO ig_users (influencer_id, ig_scoped_id, username) VALUES (1, '777', 'u') RETURNING id");
    const userA = await one<{ id: number }>("INSERT INTO ig_users (influencer_id, ig_scoped_id, username) VALUES ($1, '777', 'u') RETURNING id", [amara]);
    await withInfluencer(1, () => upsertMemory("relationship", userZ!.id, v, { type: "test" }));
    await withInfluencer(1, () => upsertMemory("world", null, { ...v, kind: "theme", key: "t" }, { type: "test" }));
    expect(await withInfluencer(amara, () => relationshipMemories(userA!.id))).toHaveLength(0);
    expect(await withInfluencer(amara, () => worldMemories())).toHaveLength(0);
    expect(await withInfluencer(1, () => relationshipMemories(userZ!.id))).toHaveLength(1);
  });

  it("controls are per influencer on top of platform-wide values", async () => {
    await setControls({ paused: true }, "test", amara);
    expect((await withInfluencer(amara, () => getControls(true))).paused).toBe(true);
    expect((await withInfluencer(1, () => getControls(true))).paused).toBe(false);
    await setControls({ platform_daily_budget_usd: 3 }, "test", 0);
    expect((await withInfluencer(amara, () => getControls(true))).platform_daily_budget_usd).toBe(3);
    expect(await run(JOBS.contentPlan, { influencerId: amara })).toMatchObject({ status: "skipped", reason: "paused" });
  });

  it("content is planned, generated and hosted with the owner's soul and storage path", async () => {
    const plan = (await run(JOBS.contentPlan, { influencerId: amara })) as { status: string; postId: string };
    expect(plan.status).toBe("accepted");
    expect(await one("SELECT influencer_id::int FROM posts WHERE id = $1", [plan.postId])).toEqual({ influencer_id: amara });
    await run(JOBS.contentProduce, { influencerId: amara, postId: plan.postId });
    const refs = MockAdapter.submitted.flatMap((j) => j.references);
    expect(refs).toContain(AMARA_FACE);
    expect(refs.some((r) => r.includes("zuri"))).toBe(false);
    const urls = await many<{ public_url: string }>("SELECT public_url FROM post_assets WHERE post_id = $1", [plan.postId]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.public_url.includes("/influencers/amara/posts/"))).toBe(true);
    expect(await one("SELECT count(*)::int AS n FROM assets WHERE influencer_id <> $1", [amara])).toEqual({ n: 0 });
  });

  it("paused or hatching influencers are skipped by the platform loops", async () => {
    await setStatus(amara, "paused");
    const out = (await run(JOBS.contentPlan, {})) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["zuri"]);
  });

  it("calendar: private events stay private, world events are shared, recaps become each influencer's memory", async () => {
    const past = new Date(Date.now() - 2 * 86400_000);
    await withInfluencer(1, () => createEvent({ title: "Zuri's shoot at Skyz", starts_at: past, outcome: "Golden hour on the lounge terrace; the crew loved it." }));
    await withInfluencer(amara, () => createEvent({ title: "Kampala Fashion Week", starts_at: new Date(Date.now() + 3 * 86400_000), shared: true, importance: 3 }));
    const zBrief = await withInfluencer(1, () => calendarBrief("content"));
    const aBrief = await withInfluencer(amara, () => calendarBrief("content"));
    expect(zBrief).toContain("Kampala Fashion Week");
    expect(zBrief).toContain("Zuri's shoot");
    expect(aBrief).toContain("Kampala Fashion Week");
    expect(aBrief).not.toContain("Zuri's shoot");
    expect(await withInfluencer(1, () => recapCalendar())).toEqual({ recapped: 1 });
    expect(await withInfluencer(1, () => recapCalendar())).toEqual({ recapped: 0 });
    expect(await withInfluencer(amara, () => recapCalendar())).toEqual({ recapped: 0 });
    expect((await withInfluencer(1, () => worldMemories(["calendar_recap"]))).map((m) => m.content)[0]).toMatch(/Golden hour/);
  });

  it("reviews are listed per influencer and approved in the owner's context", async () => {
    await withInfluencer(amara, () => setControls({ mode: "human_approval" }, "test", amara));
    await ingest(commentPayload({ commentId: "ca", text: "Any tips for a first marathon?", fromId: "9001", accountId: AMARA_IG }));
    const it = await one<{ id: number }>("SELECT id FROM interactions");
    await run(JOBS.conversationProcess, { influencerId: amara, interactionId: it!.id });
    expect(await listReviews("pending", 10, 1)).toHaveLength(0);
    const [rev] = await listReviews("pending", 10, amara);
    expect(rev).toBeDefined();
    const { approveReview } = await import("../../src/web/reviews.js");
    expect((await approveReview(rev.id, "tester")).ok).toBe(true);
    expect(fakeAmara.replies).toHaveLength(1);
    expect(fakeZuri.replies).toHaveLength(0);
  });

  it("an Instagram account belongs to exactly one influencer", async () => {
    await expect(upsertAccount({ influencerId: amara, igUserId: TEST_IG_ID, accessToken: "x" })).rejects.toThrow(/already attached/);
    const graph = async () => new Response(JSON.stringify({ id: "1", user_id: TEST_IG_ID, username: "zuri.test", account_type: "MEDIA_CREATOR" }), { status: 200 });
    await expect(attachInstagram(amara, "IGAA-a-long-enough-test-token", { fetchImpl: graph })).rejects.toThrow(/already attached/);
  });

  it("persona edits are validated, versioned and take effect immediately", async () => {
    const cur = (await one<{ persona_yaml: string }>("SELECT persona_yaml FROM influencers WHERE id = $1", [amara]))!.persona_yaml;
    await expect(updatePersona(amara, "identity: [broken")).rejects.toThrow();
    const r = await updatePersona(amara, cur.replace("name: Amara", "name: Amara K"));
    expect(r.name).toBe("Amara K");
    expect((await withInfluencer(amara, async () => (await import("../../src/persona/loader.js")).persona().identity.name))).toBe("Amara K");
    expect(await one("SELECT count(*)::int AS n FROM persona_versions WHERE influencer_id = $1", [amara])).toEqual({ n: 2 });
  });
});
