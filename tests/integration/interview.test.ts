import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { invalidateInfluencer } from "../../src/context.js";
import { many, one } from "../../src/db/pool.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";

let app: FastifyInstance;
beforeEach(async () => {
  await resetState();
  await one("UPDATE influencers SET knowledge_yaml = '' WHERE id = 1");
  invalidateInfluencer();
  app ??= await buildServer();
});
afterAll(async () => {
  await app?.close();
  await teardown();
});
const form = (url: string, body: Record<string, string>) => app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("interview", () => {
  it("asks for missing business facts first", async () => {
    const page = await app.inject({ url: "/admin/interview" });
    expect(page.body).toMatch(/Where exactly is FeetBit\?/);
    expect(page.body).toMatch(/How do customers order/);
  });

  it("turns answers into a reviewable change set and saves only on confirm", async () => {
    const draft = await form("/admin/interview/draft", {
      topic_0: "business_location", question_0: "Where exactly is FeetBit?", answer_0: "Pioneer Mall, Level 5, Shop PH-100, Kampala",
      topic_1: "life_recent", question_1: "What has Zuri been up to?", answer_1: "went to Blankets and Wine on Sunday",
    });
    expect(draft.body).toContain("Business fact: the shop is at Pioneer Mall, Level 5, Shop PH-100, Kampala");
    expect((await one<{ knowledge_yaml: string }>("SELECT knowledge_yaml FROM influencers WHERE id = 1"))!.knowledge_yaml).toBe(""); // not saved yet
    const set = /name="set" value="([^"]+)"/.exec(draft.body)![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const qa = /name="qa" value="([^"]+)"/.exec(draft.body)![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const saved = await form("/admin/interview/apply", { set, qa });
    expect(decodeURIComponent(String(saved.headers.location))).toContain("Saved 2 changes");
    const kb = (await one<{ knowledge_yaml: string }>("SELECT knowledge_yaml FROM influencers WHERE id = 1"))!.knowledge_yaml;
    expect(kb).toContain("shop-location");
    expect(kb).toContain("must_include");
    expect(await many("SELECT 1 FROM memories WHERE layer = 'identity' AND content LIKE '%Blankets and Wine%'")).toHaveLength(1);
    expect(await many("SELECT topic FROM interview_answers")).toHaveLength(2);
    // Asked and answered: not asked again for two weeks.
    expect((await app.inject({ url: "/admin/interview" })).body).not.toMatch(/name="topic_\d" value="business_location"/);
  });

  it("rejects a tampered change set", async () => {
    const r = await form("/admin/interview/apply", { set: JSON.stringify({ interests_add: "not a list" }), qa: "[]" });
    expect(decodeURIComponent(String(r.headers.location))).toMatch(/Not saved/);
  });

  it("adds an experience straight into the remembered story", async () => {
    const r = await form("/admin/interview/experience", { text: "watched the Cranes match at a sports bar in Kamwokya" });
    expect(decodeURIComponent(String(r.headers.location))).toMatch(/Remembered:/);
    expect(await many("SELECT 1 FROM memories WHERE layer = 'identity' AND kind = 'self_fact'")).toHaveLength(1);
  });
});
