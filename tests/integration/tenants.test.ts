import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { acceptInvite, inviteUser, principalForSession, setUserStatus } from "../../src/auth/users.js";
import { getControls, setControls } from "../../src/config/controls.js";
import { withInfluencer } from "../../src/context.js";
import { many, one } from "../../src/db/pool.js";
import { createInfluencer, setStatus } from "../../src/influencers/manage.js";
import { buildServer } from "../../src/web/server.js";
import { createSoul } from "../../src/souls/souls.js";
import { resetState, teardown } from "../helpers/db.js";

let app: FastifyInstance;
let amara: number;
let cookie: string;
let inviteToken: string;
let zuriPost: string;

beforeEach(async () => {
  await resetState();
  const yaml = readFileSync("config/persona.yaml", "utf8").replace("name: Zuri", "name: Amara").replace('handle: "@zurikarale"', 'handle: "@amara.test"');
  amara = Number((await createInfluencer({ name: "Amara", personaYaml: yaml })).id);
  await createSoul({ influencerId: amara, identityRefs: ["https://cdn.test/amara/face.jpg"] });
  await setStatus(amara, "active");
  zuriPost = (await one<{ id: string }>("INSERT INTO posts (influencer_id, media_type, caption, status) VALUES (1, 'IMAGE', 'Zuri secret caption', 'awaiting_review') RETURNING id"))!.id;
  app ??= await buildServer();
  const inv = await inviteUser({ email: "Owner@Amara.ug", name: "Owner", role: "tenant", influencerId: amara, by: "test" });
  inviteToken = inv.inviteToken;
  const r = await app.inject({ method: "POST", url: `/admin/invite/${inviteToken}`, payload: "password=correct-horse-battery", headers: { "content-type": "application/x-www-form-urlencoded" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
});
afterAll(async () => {
  await app?.close();
  await teardown();
});

const get = (url: string, extra = "") => app.inject({ url, headers: { cookie: [cookie, extra].filter(Boolean).join("; ") } });
const post = (url: string, body: Record<string, string>) =>
  app.inject({ method: "POST", url, payload: new URLSearchParams(body).toString(), headers: { cookie, "content-type": "application/x-www-form-urlencoded" } });

describe("tenant set-up", () => {
  it("a tenant sees only their own influencer's dashboard: no switcher, no other names, no platform nav", async () => {
    expect(cookie).toMatch(/^aia_user=/);
    const page = await get("/admin");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Amara");
    expect(page.body).not.toMatch(/>Zuri</);
    expect(page.body).not.toContain('action="/admin/switch"');
    expect(page.body).not.toContain('href="/admin/influencers"');
    expect(page.body).not.toContain('href="/admin/config"');
    expect(page.body).toContain('href="/admin/interview"');
  });

  it("refuses every admin and platform URL, even typed or posted", async () => {
    for (const url of ["/admin/influencers", "/admin/hatch", "/admin/standard", "/admin/config", "/admin/users", "/admin/generation/policy", "/admin/generation/benchmarks", "/api/status"]) {
      expect((await get(url)).statusCode, url).toBe(403);
    }
    expect((await post("/admin/switch", { id: "1" })).statusCode).toBe(403);
    expect((await post("/admin/persona", { persona: "x" })).statusCode).toBe(403);
    expect((await post("/admin/costs/platform", { platform_daily_budget_usd: "999" })).statusCode).toBe(403);
  });

  it("can't reach another influencer's data, whatever cookie or id it sends", async () => {
    const forced = await get("/admin/posts", "aia_inf=1");
    expect(forced.body).not.toContain("Zuri secret caption");
    expect((await get(`/admin/posts/${zuriPost}`)).statusCode).toBe(404);
    await post(`/admin/posts/${zuriPost}/delete`, {});
    expect(await one("SELECT status FROM posts WHERE id = $1", [zuriPost])).toEqual({ status: "awaiting_review" });
    const events = await get("/admin/events");
    expect(events.body).not.toContain("scope=platform");
    const costs = await get("/admin/costs");
    expect(costs.body).not.toContain("Platform budget");
  });

  it("can't change spend or the AI brain, but can run their influencer", async () => {
    await post("/admin/controls", { daily_budget_usd: "999", llm_brain: "openai", stories_per_day: "2" });
    const c = await withInfluencer(amara, () => getControls(true));
    expect(c.daily_budget_usd).not.toBe(999);
    expect(c.llm_brain).toBe("claude");
    expect(c.stories_per_day).toBe(2);
    expect((await get("/admin/controls")).body).toContain("Set by your platform admin");
  });

  it("signs in with email and password, refuses wrong ones and disabled users, and invites work once", async () => {
    const ok = await app.inject({ method: "POST", url: "/admin/login", payload: "email=owner%40amara.ug&password=correct-horse-battery", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(ok.headers.location).toBe("/admin");
    const bad = await app.inject({ method: "POST", url: "/admin/login", payload: "email=owner%40amara.ug&password=nope-nope-nope", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(bad.headers.location).toBe("/admin/login?e=1");
    await expect(acceptInvite(inviteToken, "another-password-1")).rejects.toThrow(/expired or was already used/);
    const user = await one<{ id: number }>("SELECT id FROM users WHERE email = 'owner@amara.ug'");
    await setUserStatus(user!.id, "disabled");
    expect(await many("SELECT 1 FROM sessions WHERE user_id = $1", [user!.id])).toHaveLength(0);
    // Their session is gone: the cookie no longer identifies anyone (production then sends them to sign-in).
    expect(await principalForSession(decodeURIComponent(cookie.split("=")[1]))).toBeUndefined();
  });

  it("the admin still sees everything and manages access", async () => {
    const admin = await app.inject({ url: "/admin/users" }); // open dev box = admin
    expect(admin.statusCode).toBe(200);
    expect(admin.body).toContain("owner@amara.ug");
    const created = await app.inject({ method: "POST", url: "/admin/users", payload: new URLSearchParams({ email: "new@shop.ug", influencer_id: String(amara) }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(created.body).toMatch(/\/admin\/invite\/[A-Za-z0-9_-]{30,}/);
    expect(await one("SELECT invite_token_hash IS NOT NULL AS stored FROM users WHERE email = 'new@shop.ug'")).toEqual({ stored: true });
    await setControls({ mode: "dry_run" }, "test", amara);
  });
});
