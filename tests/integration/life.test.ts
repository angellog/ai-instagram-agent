import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { planContent } from "../../src/content/director.js";
import { arcProgress, callbackCandidates, lifeContext, usedMoments } from "../../src/content/life.js";
import { many, one } from "../../src/db/pool.js";
import { createDevMockProvider } from "../../src/llm/devMock.js";
import { LLM, setLLM } from "../../src/llm/llm.js";
import { persona } from "../../src/persona/loader.js";
import { buildServer } from "../../src/web/server.js";
import { resetState, teardown } from "../helpers/db.js";

beforeEach(() => resetState());
afterAll(() => teardown());

const lifeOf = async (postId: string) => (await one<{ life: Record<string, unknown> | null }>("SELECT ci.life FROM posts p JOIN content_ideas ci ON ci.id = p.content_idea_id WHERE p.id = $1", [postId]))!.life;

describe("the feed follows the influencer's life", () => {
  it("moves a storyline one beat per post, at its pace, and records the moment it stood on", async () => {
    const p = persona();
    const first = await planContent(new Date(), { operator: true });
    expect(first.status).toBe("accepted");
    const a = await lifeOf((first as { postId: string }).postId);
    expect(a).toMatchObject({ arc_id: p.life.arcs[0].id, beat_index: 0, beat: p.life.arcs[0].beats[0] });
    expect(p.life.moments).toContain(a!.moment);

    // The first storyline isn't due again for days: the next post takes the next storyline's first beat.
    await one("UPDATE posts SET status = 'published', published_at = now()");
    const second = await planContent(new Date(), { operator: true });
    const b = await lifeOf((second as { postId: string }).postId);
    expect(b).toMatchObject({ arc_id: p.life.arcs[1].id, beat_index: 0 });
    expect(b!.moment).not.toBe(a!.moment); // a used moment isn't offered again

    const progress = await arcProgress(p);
    expect(progress[0]).toMatchObject({ done: 1, next: p.life.arcs[0].beats[1], due: false });
    expect(progress[0].waitDays).toBe(p.life.arcs[0].every_days);
    expect(await usedMoments()).toHaveLength(2);
  });

  it("gives a beat back when its post is rejected", async () => {
    const plan = await planContent(new Date(), { operator: true });
    expect((await arcProgress(persona()))[0].done).toBe(1);
    await one("UPDATE posts SET status = 'rejected' WHERE id = $1", [(plan as { postId: string }).postId]);
    const again = (await arcProgress(persona()))[0];
    expect(again).toMatchObject({ done: 0, due: true, next: persona().life.arcs[0].beats[0] });
  });

  it("sends a generic idea back to be anchored in something real", async () => {
    let calls = 0;
    const prompts: string[] = [];
    const base = createDevMockProvider();
    setLLM(
      new LLM(
        createDevMockProvider().on("content.plan", async (r) => {
          calls++;
          const u = r.messages[r.messages.length - 1]?.content ?? "";
          prompts.push(typeof u === "string" ? u : JSON.stringify(u));
          const out = JSON.parse((await base.complete(r)).text) as { idea: Record<string, unknown> };
          if (calls === 1) Object.assign(out.idea, { caption: "Living my best life, good vibes only", hook: "Golden hour", topic: "Golden hour", arc_id: null, moment: "" });
          return out;
        }),
      ),
    );
    const plan = await planContent(new Date(), { operator: true });
    expect(plan).toMatchObject({ status: "accepted", attempts: 2 });
    const rejected = await one<{ reject_reason: string }>("SELECT reject_reason FROM content_ideas WHERE status = 'rejected'");
    expect(rejected!.reject_reason).toMatch(/^generic: stock phrase: living my best life; stock phrase: good vibes; stock phrase: golden hour/);
    expect(prompts[1]).toMatch(/read as generic AI content/);
    expect(prompts[0]).toMatch(/YOUR LIFE RIGHT NOW/);
    expect(prompts[0]).toMatch(/PEOPLE IN YOUR LIFE[^\n]*Nana/);
  });

  it("offers older published posts as callbacks, once each", async () => {
    const plan = await planContent(new Date(), { operator: true });
    const id = (plan as { postId: string }).postId;
    await one("UPDATE posts SET status = 'published', published_at = now() - interval '10 days' WHERE id = $1", [id]);
    expect((await callbackCandidates()).map((c) => c.postId)).toEqual([id]);
    await one("UPDATE content_ideas SET life = jsonb_build_object('callback_post_id', $1::text) WHERE id = (SELECT max(id) FROM content_ideas)", [id]);
    await one("INSERT INTO content_ideas (format, structure, topic, hook, angle, plan, caption, visual_state, status, influencer_id, life) VALUES ('single','moment','t','h','a','{}','c','{}','accepted',1, jsonb_build_object('callback_post_id', $1::text))", [id]);
    expect(await callbackCandidates()).toEqual([]);
    const ctx = await lifeContext(persona(), "2026-10-08");
    expect(ctx.moments).toHaveLength(4);
  });

  it("shows the timeline: storylines with progress, people, moments and what posts stood on", async () => {
    await planContent(new Date(), { operator: true });
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/admin/timeline" });
    expect(res.statusCode).toBe(200);
    const p = persona();
    expect(res.body).toContain(p.life.arcs[0].title);
    expect(res.body).toContain("1 of 7 beats");
    expect(res.body).toContain("next, in 5 days");
    expect(res.body).toContain("Nana");
    expect(res.body).toMatch(/used [^<]*ago/);
    expect((await many("SELECT 1 FROM content_ideas WHERE life IS NOT NULL")).length).toBe(1);
    await app.close();
  });
});
