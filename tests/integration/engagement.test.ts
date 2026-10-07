import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setControls } from "../../src/config/controls.js";
import { setSetting } from "../../src/config/settings.js";
import { processInteraction } from "../../src/conversation/agent.js";
import { many, one } from "../../src/db/pool.js";
import { chooseHashtags, HASHTAG_WEEKLY_LIMIT, parseLinks, runScout, scoutLinks, setScoutFetch } from "../../src/engagement/scout.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { processWebhookEvent } from "../../src/ingest/process.js";
import { storeWebhookEvent } from "../../src/ingest/webhook.js";
import { persona } from "../../src/persona/loader.js";
import { planReel } from "../../src/reels/plan.js";
import { buildServer } from "../../src/web/server.js";
import { FakeInstagram, commentPayload } from "../helpers/fakeInstagram.js";
import { resetState, teardown, TEST_IG_ID } from "../helpers/db.js";

let fake: FakeInstagram;
let app: FastifyInstance;
beforeEach(async () => {
  await resetState();
  fake = new FakeInstagram();
  setInstagramClient(fake.client());
  app ??= await buildServer();
});
afterEach(() => setScoutFetch(undefined));
afterAll(async () => {
  await app?.close();
  await teardown();
});

async function ingest(payload: object): Promise<{ id: number; kind: string }> {
  const ev = await storeWebhookEvent("meta", JSON.stringify(payload), payload);
  await processWebhookEvent(ev!.id);
  return (await one<{ id: number; kind: string }>("SELECT id, kind FROM interactions WHERE webhook_event_id = $1", [ev!.id]))!;
}
const form = (url: string, body: Record<string, string>) => app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("@mentions on other people's posts", () => {
  it("answers through Instagram's mentions API, under the comment that tagged her", async () => {
    const it0 = await ingest(commentPayload({ commentId: "c_m1", text: "@zuri.test which pair would you wear with this fit?", mediaId: "m_someone_else", username: "kampala_fits" }));
    expect(it0.kind).toBe("mention");
    expect(await processInteraction(it0.id)).toBe("replied");
    expect(fake.mentionReplies).toHaveLength(1);
    expect(fake.mentionReplies[0]).toMatchObject({ mediaId: "m_someone_else", commentId: "c_m1" });
    expect(fake.replies).toHaveLength(0); // never the /replies edge on someone else's media
    const msg = await one<{ channel: string; status: string }>("SELECT channel, status FROM messages WHERE interaction_id = $1 AND direction = 'out'", [it0.id]);
    expect(msg).toEqual({ channel: "mention_reply", status: "sent" });
  });

  it("keeps comments on her own posts (and comments without her handle) as ordinary comments", async () => {
    await one("INSERT INTO posts (influencer_id, media_type, caption, status, ig_media_id) VALUES (1, 'IMAGE', 'x', 'published', 'm_ours')");
    expect((await ingest(commentPayload({ commentId: "c_o1", text: "@zuri.test love this", mediaId: "m_ours" }))).kind).toBe("comment");
    expect((await ingest(commentPayload({ commentId: "c_o2", text: "@zuri.testing is someone else", mediaId: "m_other" }))).kind).toBe("comment");
  });

  it("reads Meta's mentions field and respects the Controls switch", async () => {
    const payload = { object: "instagram", entry: [{ id: TEST_IG_ID, time: Math.floor(Date.now() / 1000), changes: [{ field: "mentions", value: { comment_id: "c_m2", media_id: "m_x", text: "@zuri.test you need to see this", from: { id: "77", username: "brian_k" } } }] }] };
    const it1 = await ingest(payload);
    expect(it1.kind).toBe("mention");
    await setControls({ mention_replies_enabled: false });
    expect(await processInteraction(it1.id)).toBe("ignored");
    expect(fake.mentionReplies).toHaveLength(0);
  });
});

describe("engagement scout", () => {
  const posts = [
    { id: "h1", caption: "New Jordans at Acacia Mall today, the colourway is unreal", permalink: "https://www.instagram.com/p/AAA111/", like_count: 40, comments_count: 6 },
    { id: "h2", caption: "RIP to a legend, Kampala won't be the same", permalink: "https://www.instagram.com/p/AAA222/", like_count: 400, comments_count: 90 },
    { id: "h3", caption: "Giveaway! DM us to order, link in bio", permalink: "https://www.instagram.com/p/AAA333/", like_count: 10, comments_count: 1 },
    { id: "h4", caption: "Sunday run at Kololo airstrip before the rain came", permalink: "https://www.instagram.com/p/AAA444/", like_count: 25, comments_count: 3 },
  ];
  const calls: string[] = [];
  const graph: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.endsWith("/ig_hashtag_search")) return Response.json({ data: [{ id: `tag_${url.searchParams.get("q")}` }] });
    if (url.pathname.endsWith("/recent_media")) return Response.json({ data: posts });
    return Response.json({ error: { message: "unexpected" } }, { status: 400 });
  };

  it("waits for a scout token instead of failing", async () => {
    expect(await runScout()).toMatchObject({ status: "skipped", reason: expect.stringContaining("paste links instead") });
  });

  it("reads hashtags within Meta's weekly limit, skips ads and grief, drafts comments for a person to post", async () => {
    calls.length = 0;
    setScoutFetch(graph);
    await setSetting("META_SCOUT_TOKEN", "fb-test-token");
    await setSetting("META_SCOUT_IG_USER_ID", "17841499999999999");
    const out = await runScout(new Date("2026-10-08T09:00:00Z"));
    expect(out).toMatchObject({ status: "done", drafted: 2 });
    const drafts = await many<{ permalink: string; comment: string; status: string; hashtag: string }>("SELECT permalink, comment, status, hashtag FROM engagement_drafts ORDER BY id");
    expect(drafts.map((d) => d.permalink).sort()).toEqual(["https://www.instagram.com/p/AAA111/", "https://www.instagram.com/p/AAA444/"]);
    expect(drafts.every((d) => d.status === "new" && d.comment.length > 10 && !/[@#]|http/.test(d.comment))).toBe(true);
    expect(await many("SELECT DISTINCT hashtag FROM hashtag_queries")).toHaveLength(2);
    // Nothing was ever posted, liked or commented through the API.
    expect(calls.every((c) => /ig_hashtag_search|recent_media/.test(c))).toBe(true);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(0);

    // Run again: the same posts are never drafted twice; known hashtags cost nothing new.
    const again = await runScout(new Date("2026-10-08T09:00:00Z"));
    expect(again).toMatchObject({ status: "done", drafted: 0 });
    expect(await many("SELECT DISTINCT hashtag FROM hashtag_queries")).toHaveLength(2);
  });

  it("spends the 30-hashtag week on known tags first, then only what's left", () => {
    const used = new Map(Array.from({ length: HASHTAG_WEEKLY_LIMIT - 1 }, (_, i) => [`t${i}`, "x"]));
    used.set("kampala", "x");
    expect(used.size).toBe(HASHTAG_WEEKLY_LIMIT);
    expect(chooseHashtags(["#kampala", "brandnew"], used, 2, 0)).toEqual(["kampala"]);
    expect(chooseHashtags(["a", "b", "c"], new Map(), 2, 0)).toEqual(["a", "b"]);
    expect(chooseHashtags(["a", "b", "c"], new Map(), 2, 86_400_000)).toEqual(["b", "c"]); // rotates day by day
  });

  it("drafts from pasted links with no token, and the queue is one tap: copy, open, mark posted", async () => {
    const parsed = parseLinks("https://www.instagram.com/p/XYZ123/ | white pairs after a rainy walk in Ntinda\nhttps://instagram.com/reel/RRR999\nso the reel is her shop tour at Pioneer Mall\nnot a link");
    expect(parsed.posts.map((p) => p.permalink)).toEqual(["https://www.instagram.com/p/XYZ123/", "https://www.instagram.com/reel/RRR999/"]);
    expect(parsed.problems).toEqual(['not an Instagram post link: "not a link"']);

    const r = await form("/admin/engagement/links", { links: "https://www.instagram.com/p/XYZ123/ | white pairs after a rainy walk in Ntinda" });
    expect(decodeURIComponent(String(r.headers.location))).toContain("1 comment drafted");
    expect((await scoutLinks("https://www.instagram.com/p/XYZ123/ | white pairs after a rainy walk in Ntinda")).drafted).toBe(0); // already queued
    const page = await app.inject({ url: "/admin/engagement" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('data-copy-open="https://www.instagram.com/p/XYZ123/"');
    expect(page.body).toMatch(/Short-form ideas for today/);
    expect(page.body).toMatch(/Arsenal vs Tottenham/);
    const d = (await one<{ id: number }>("SELECT id FROM engagement_drafts"))!;
    await form(`/admin/engagement/drafts/${d.id}`, { status: "done", comment: "edited before posting, the way she'd say it" });
    expect(await one("SELECT status, comment, acted_by IS NOT NULL AS by FROM engagement_drafts WHERE id = $1", [d.id])).toEqual({ status: "done", comment: "edited before posting, the way she'd say it", by: true });
  });
});

describe("short-form that gets replies", () => {
  it("makes a talk reel: one front-camera clip, the question as the hook, the caption asking for answers", async () => {
    const out = await planReel(new Date(), { operator: true, direction: "talk reel, funny question: be honest, how many pairs do you actually wear?" });
    expect(out.status).toBe("accepted");
    const idea = await one<{ structure: string; angle: string; plan: { kind: string; format: string; clips: unknown[]; intro: { include_character: boolean; seconds: number }; hook: string } }>(
      "SELECT structure, angle, plan FROM content_ideas WHERE id = $1",
      [(out as { ideaId: number }).ideaId],
    );
    expect(idea).toMatchObject({ structure: "talk", angle: "funny_question", plan: { kind: "talk", format: "funny_question", clips: [], intro: { include_character: true } } });
    expect(idea!.plan.intro.seconds).toBeGreaterThanOrEqual(5);
    expect(persona().engagement.questions.some((q) => q.startsWith(idea!.plan.hook.slice(0, 20)))).toBe(true);
  });
});
