import { createReadStream, existsSync } from "node:fs";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import { LIBRARY_LIMITS } from "../library/library.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { getControls } from "../config/controls.js";
import { env } from "../config/env.js";
import { spendSummary } from "../cost/ledger.js";
import { db, one } from "../db/pool.js";
import { storeWebhookEvent, verifyMetaSignature, verifyRelaySignature } from "../ingest/webhook.js";
import { primaryAccount, upsertAccount } from "../instagram/accounts.js";
import { InstagramClient } from "../instagram/client.js";
import { withTimeout } from "../lib/async.js";
import { hmacSha256Hex, safeEqual } from "../lib/crypto.js";
import { recordEvent } from "../lib/events.js";
import { logger } from "../lib/logger.js";
import { JOBS, jobId, queue, queueCounts, redis } from "../queue/queues.js";
import { download, localMediaPath } from "../storage/host.js";
import { positionFromFile } from "../tiktok/media.js";
import { legalPage } from "./legal.js";
import { registerAdmin, selectedInfluencer } from "./admin.js";
import { setting } from "../config/settings.js";
import { listInfluencers, withInfluencer } from "../context.js";
import { acceptInvite, createSession, INVITE_DAYS, login, MIN_PASSWORD, principalForSession, SESSION_DAYS, userForInvite, type Principal } from "../auth/users.js";
import { tenantMayAccess } from "../auth/access.js";
import { setPrincipal } from "../auth/request.js";
import { VERSION } from "../version.js";

const SESSION_COOKIE = "aia_session";

function sessionValue(token: string): string {
  return hmacSha256Hex(token, "admin-session-v1");
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export const USER_COOKIE = "aia_user";

/**
 * Who is calling: the admin (ADMIN_TOKEN as a Bearer header or the signed admin
 * cookie, or an admin user's session), a tenant (a user's session, tied to one
 * influencer), or nobody. Open as admin only in development without a token.
 */
export async function resolvePrincipal(req: FastifyRequest): Promise<Principal | undefined> {
  const token = env().ADMIN_TOKEN;
  // A signed-in user is who they are, even on an open development box.
  const user = readCookie(req, USER_COOKIE);
  if (user) {
    const p = await principalForSession(user);
    if (p) return p;
  }
  if (!token && env().NODE_ENV !== "production") return { kind: "admin", userId: null, label: "development" };
  const auth = req.headers.authorization;
  if (token && auth?.startsWith("Bearer ") && safeEqual(auth.slice(7), token)) return { kind: "admin", userId: null, label: "admin token" };
  const legacy = readCookie(req, SESSION_COOKIE);
  if (token && legacy && safeEqual(legacy, sessionValue(token))) return { kind: "admin", userId: null, label: "admin token" };
  return undefined;
}

const NOT_YOURS = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not available</title><body style="font:16px/1.5 system-ui;display:grid;place-items:center;min-height:100dvh;margin:0"><p>That page isn't part of your account. <a href="/admin">Back to your dashboard</a></p></body>`;

export async function buildServer(): Promise<FastifyInstance> {
  const e = env();
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  await app.register(formbody);
  // Content library uploads (photos and one video per item); everything else stays small form posts.
  await app.register(multipart, { limits: { fileSize: LIBRARY_LIMITS.videoBytes, files: LIBRARY_LIMITS.files, fields: 20, fieldSize: 8 * 1024 } });

  // Keep the raw bytes: Meta's signature is over the exact body.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    const isAdmin = url === "/admin" || url.startsWith("/admin/") || url.startsWith("/api/");
    if (!isAdmin || url === "/admin/login" || url.startsWith("/admin/invite/")) return;
    const principal = await resolvePrincipal(req);
    if (!principal) {
      if (url.startsWith("/api/")) return reply.code(401).send({ error: "unauthorized" });
      return reply.redirect(`/admin/login?next=${encodeURIComponent(req.url)}`, 303);
    }
    setPrincipal(req, principal);
    // Tenants operate their own influencer only: onboarding, platform and cross-influencer pages are refused outright.
    if (principal.kind === "tenant" && !tenantMayAccess(req.method, url)) {
      if (url.startsWith("/api/") || String(req.headers.accept ?? "").includes("application/json")) return reply.code(403).send({ error: "forbidden" });
      return reply.code(403).type("text/html").send(NOT_YOURS);
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 500) logger.error({ url: req.url, status: reply.statusCode }, "request failed");
  });

  // Malformed ids in console URLs are "not found", never a database error.
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    const uuidRoute = /^\/admin\/(?:posts|create|generation\/requests|library)\/([^/]+)/.exec(path) ?? /^\/admin\/api\/create\/([^/]+)/.exec(path);
    if (uuidRoute && !/^[0-9a-f-]{36}$/i.test(uuidRoute[1])) return reply.code(404).send("not found");
    const numRoute = /^\/admin\/(?:reviews|people|interactions|influencers|hatch|api\/calendar|calendar|generation\/models|users)\/([^/]+)/.exec(path);
    if (numRoute && !/^\d{1,12}$/.test(numRoute[1]) && !["add"].includes(numRoute[1])) return reply.code(404).send("not found");
  });

  app.setErrorHandler(async (err, req, reply) => {
    logger.error({ err, url: req.url }, "unhandled route error");
    await recordEvent("error", "web", "Unhandled route error", { url: req.url.split("?")[0], error: (err as Error).message });
    // A console form that hits an unexpected error (e.g. Redis briefly down) goes back with a readable message.
    const path = req.url.split("?")[0];
    const wantsJson = String(req.headers.accept ?? "").includes("application/json");
    if (req.method === "POST" && path.startsWith("/admin") && !wantsJson) {
      const back = String(req.headers.referer ?? "").replace(/^https?:\/\/[^/]+/, "").split("?")[0].split("#")[0];
      const to = back.startsWith("/admin") ? back : "/admin";
      return reply.redirect(`${to}?flash=${encodeURIComponent(`Something went wrong: ${(err as Error).message}`.slice(0, 300))}&tone=bad`, 303);
    }
    return reply.code(500).send({ ok: false, error: "internal error" });
  });

  // ---------------------------------------------------------------- health
  app.get("/health", async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await db().query("SELECT 1");
      checks.database = "ok";
    } catch (err) {
      checks.database = (err as Error).message;
    }
    try {
      checks.redis = (await redis().ping()) === "PONG" ? "ok" : "unexpected";
    } catch (err) {
      checks.redis = (err as Error).message;
    }
    const ok = Object.values(checks).every((v) => v === "ok");
    return reply.code(ok ? 200 : 503).send({ ok, checks, role: e.ROLE, version: VERSION });
  });

  app.get("/", async (_req, reply) => reply.redirect("/admin"));

  // ------------------------------------------------------------ webhooks
  app.get("/webhooks/instagram", async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const q = req.query;
    const verify = await setting("WEBHOOK_VERIFY_TOKEN");
    if (q["hub.mode"] === "subscribe" && verify && q["hub.verify_token"] && safeEqual(q["hub.verify_token"], verify)) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send({ error: "verification failed" });
  });

  app.post("/webhooks/instagram", async (req, reply) => {
    const raw = rawBody(req);
    if (!(await verifyMetaSignature(raw, req.headers["x-hub-signature-256"] as string | undefined))) {
      await recordEvent("warn", "webhook", "Meta webhook signature mismatch", { bytes: raw.length, hadHeader: Boolean(req.headers["x-hub-signature-256"]) });
      return reply.code(401).send({ error: "invalid signature" });
    }
    return ingest("meta", raw, reply);
  });

  // OpenReply owns the Meta app's single webhook URL and relays verified events here.
  app.post("/webhooks/openreply", async (req, reply) => {
    const raw = rawBody(req);
    if (!(await verifyRelaySignature(raw, req.headers["x-openreply-signature"] as string | undefined))) {
      await recordEvent("warn", "webhook", "OpenReply relay signature mismatch", { bytes: raw.length });
      return reply.code(401).send({ error: "invalid signature" });
    }
    return ingest("openreply_relay", raw, reply);
  });

  // ------------------------------------------------------------ oauth
  // "Connect Instagram" for the influencer selected in the console (or ?inf=<id>).
  app.get("/admin/connect", async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const [appId, appSecret] = [await setting("INSTAGRAM_APP_ID"), await setting("INSTAGRAM_APP_SECRET")];
    if (!appId || !appSecret) return reply.redirect(`/admin/config?flash=${encodeURIComponent("Set the Instagram app ID and secret first")}#instagram`, 303);
    const inf = Number(req.query.inf ?? selectedInfluencer(req));
    if (!(await one("SELECT 1 FROM influencers WHERE id = $1 AND status <> 'archived'", [inf]))) return reply.code(400).send("Unknown influencer");
    const payload = `${Date.now()}.${inf}`;
    const state = `${payload}.${hmacSha256Hex(stateKey(), payload)}`;
    return reply.redirect(InstagramClient.authorizeUrl({ appId, redirectUri: redirectUri(), state }));
  });

  app.get("/oauth/instagram/callback", async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const { code, state, error_description } = req.query;
    if (!code) return reply.code(400).send(`Instagram did not return a code: ${error_description ?? "unknown error"}`);
    const [ts, infRaw, sig] = (state ?? "").split(".");
    if (!ts || !infRaw || !sig || !safeEqual(sig, hmacSha256Hex(stateKey(), `${ts}.${infRaw}`)) || Date.now() - Number(ts) > 15 * 60_000) {
      return reply.code(400).send("Invalid or expired OAuth state; start again from the console.");
    }
    const influencerId = Number(infRaw);
    const [appId, appSecret] = [await setting("INSTAGRAM_APP_ID"), await setting("INSTAGRAM_APP_SECRET")];
    const tok = await InstagramClient.exchangeCode(code, { appId: appId!, appSecret: appSecret!, redirectUri: redirectUri(), host: e.META_GRAPH_HOST });
    const ig = new InstagramClient({ accessToken: tok.accessToken, igUserId: tok.userId, host: e.META_GRAPH_HOST, version: e.META_GRAPH_API_VERSION });
    const profile = await ig.getProfile();
    const igUserId = profile.user_id ?? profile.id ?? tok.userId;
    await upsertAccount({
      influencerId,
      igUserId: String(igUserId),
      username: profile.username,
      accessToken: tok.accessToken,
      expiresAt: new Date(Date.now() + tok.expiresIn * 1000),
      makePrimary: true,
      profile: profile as unknown as Record<string, unknown>,
    });
    await recordEvent("info", "instagram", "Instagram account connected", { username: profile.username, igUserId, influencerId });
    const hatching = await one("SELECT 1 FROM influencers WHERE id = $1 AND status = 'hatching'", [influencerId]);
    const to = hatching ? `/admin/hatch/${influencerId}?step=instagram` : "/admin";
    return reply.redirect(`${to}${to.includes("?") ? "&" : "?"}flash=${encodeURIComponent(`Connected @${profile.username}`)}`, 303);
  });

  // ------------------------------------------------------------ login
  app.get("/admin/login", async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const next = safeNext(req.query.next).replace(/"/g, "");
    const err = req.query.e === "1" ? `<p class="err" role="alert">That email and password don't match.</p>` : req.query.e === "t" ? `<p class="err" role="alert">Wrong admin token.</p>` : "";
    return reply.type("text/html").send(authPage(
      "Sign in",
      `<form method="post" action="/admin/login"><h1>Influencer OS</h1>${err}
<label for="e">Email</label><input id="e" type="email" name="email" autocomplete="username" autofocus required>
<label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" required>
<input type="hidden" name="next" value="${next}"><button>Sign in</button>
<details><summary>Admin token</summary><div class="tok"><label for="t">Token</label><input id="t" type="password" name="token" autocomplete="off"><button name="mode" value="token" formnovalidate>Sign in with token</button></div></details></form>`,
    ));
  });
  app.post("/admin/login", async (req: FastifyRequest<{ Body: Record<string, string> }>, reply) => {
    const secure = env().PUBLIC_BASE_URL.startsWith("https://") ? "; Secure" : "";
    const next = safeNext(req.body?.next);
    if (req.body?.mode === "token" || (req.body?.token && !req.body?.email)) {
      const token = env().ADMIN_TOKEN;
      const given = String(req.body?.token ?? "").trim(); // pasted tokens often carry a stray space or newline
      if (!token || !safeEqual(given, token)) return reply.redirect("/admin/login?e=t", 303);
      reply.header("set-cookie", `${SESSION_COOKIE}=${sessionValue(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
      return reply.redirect(next, 303);
    }
    const user = await login(String(req.body?.email ?? ""), String(req.body?.password ?? ""));
    if (!user) return reply.redirect("/admin/login?e=1", 303);
    const t = await createSession(user.id, String(req.headers["user-agent"] ?? ""));
    reply.header("set-cookie", `${USER_COOKIE}=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    return reply.redirect(user.role === "tenant" ? "/admin" : next, 303);
  });
  // Invite links: set a password, then you're signed in.
  app.get("/admin/invite/:token", async (req: FastifyRequest<{ Params: { token: string }; Querystring: Record<string, string> }>, reply) => {
    const u = await userForInvite(req.params.token);
    if (!u) return reply.code(410).type("text/html").send(authPage("Invite expired", `<div class="card"><h1>This link has expired</h1><p>Invite links work once, for ${INVITE_DAYS} days. Ask for a new one.</p></div>`));
    const err = req.query.e ? `<p class="err" role="alert">${String(req.query.e).replace(/[<>&"]/g, "")}</p>` : "";
    return reply.type("text/html").send(authPage(
      "Set your password",
      `<form method="post" action="/admin/invite/${encodeURIComponent(req.params.token)}"><h1>Welcome${u.name ? `, ${u.name.replace(/[<>&"]/g, "")}` : ""}</h1><p class="sub">${u.email.replace(/[<>&"]/g, "")}</p>${err}
<label for="p">Choose a password</label><input id="p" type="password" name="password" minlength="${MIN_PASSWORD}" autocomplete="new-password" autofocus required>
<p class="sub">At least ${MIN_PASSWORD} characters.</p><button>Set password and sign in</button></form>`,
    ));
  });
  app.post("/admin/invite/:token", async (req: FastifyRequest<{ Params: { token: string }; Body: Record<string, string> }>, reply) => {
    try {
      const u = await acceptInvite(req.params.token, String(req.body?.password ?? ""));
      const secure = env().PUBLIC_BASE_URL.startsWith("https://") ? "; Secure" : "";
      reply.header("set-cookie", `${USER_COOKIE}=${await createSession(u.id, String(req.headers["user-agent"] ?? ""))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
      return reply.redirect("/admin", 303);
    } catch (e) {
      return reply.redirect(`/admin/invite/${encodeURIComponent(req.params.token)}?e=${encodeURIComponent((e as Error).message)}`, 303);
    }
  });

  // ------------------------------------------------------------ JSON API
  app.get("/api/status", async () => {
    const influencers = [];
    for (const inf of await listInfluencers(["active", "paused", "hatching"])) {
      influencers.push(
        await withInfluencer(Number(inf.id), async () => {
          const [c, acct, pending, spend] = await Promise.all([
            getControls(),
            primaryAccount(),
            one<{ n: number }>("SELECT count(*)::int AS n FROM safety_reviews WHERE status = 'pending' AND influencer_id = $1", [inf.id]),
            spendSummary(),
          ]);
          return {
            id: Number(inf.id),
            slug: inf.slug,
            status: inf.status,
            mode: c.mode,
            paused: c.paused,
            account: acct ? { igUserId: acct.ig_user_id, username: acct.username, tokenExpiresAt: acct.token_expires_at } : null,
            pendingReviews: pending?.n ?? 0,
            spend,
          };
        }).catch((err: Error) => ({ id: Number(inf.id), slug: inf.slug, status: inf.status, error: err.message })),
      );
    }
    return { version: VERSION, influencers, platformSpend: await spendSummary("all"), queues: await queueCounts().catch(() => null) };
  });

  // Dev-only media host (the "local" storage provider).
  app.get("/media/*", async (req: FastifyRequest<{ Params: { "*": string } }>, reply) => {
    try {
      const p = localMediaPath(req.params["*"]);
      if (!existsSync(p)) return reply.code(404).send("not found");
      return reply.type(p.endsWith(".png") ? "image/png" : "image/jpeg").send(createReadStream(p));
    } catch {
      return reply.code(400).send("bad path");
    }
  });

  // TikTok downloads photo posts from here (a domain verified in the TikTok app; no redirects allowed).
  // Only the frames of TikTok posts are served, by post id and slide.
  app.get("/tiktok-media/:postId/:file", async (req: FastifyRequest<{ Params: { postId: string; file: string } }>, reply) => {
    const pos = positionFromFile(req.params.file);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.postId) || pos === undefined) return reply.code(404).send("not found");
    const a = await one<{ public_url: string }>(
      "SELECT pa.public_url FROM post_assets pa JOIN posts p ON p.id = pa.post_id WHERE p.id = $1 AND p.platform = 'tiktok' AND pa.position = $2 AND pa.public_url IS NOT NULL",
      [req.params.postId, pos],
    );
    if (!a) return reply.code(404).send("not found");
    try {
      const bytes = await download(a.public_url);
      return reply.header("cache-control", "public, max-age=3600").type("image/jpeg").send(bytes);
    } catch {
      return reply.code(502).send("image unavailable");
    }
  });

  // Public Terms and Privacy pages (TikTok's app review needs them).
  app.get("/legal/:page", async (req: FastifyRequest<{ Params: { page: string } }>, reply) => {
    const page = req.params.page === "terms" ? "terms" : req.params.page === "privacy" ? "privacy" : undefined;
    if (!page) return reply.code(404).send("not found");
    return reply.type("text/html").send(legalPage(page, { company: (await setting("LEGAL_COMPANY_NAME")) ?? "The operator", email: (await setting("LEGAL_CONTACT_EMAIL")) ?? "" }));
  });

  registerAdmin(app);
  return app;
}

function rawBody(req: FastifyRequest): Buffer {
  const b = req.body as unknown;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === "string") return Buffer.from(b);
  return Buffer.from(JSON.stringify(b ?? {}));
}

async function ingest(source: "meta" | "openreply_relay", raw: Buffer, reply: FastifyReply) {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return reply.code(400).send({ error: "invalid JSON" });
  }
  // Persist first, then enqueue: if Redis is down the event is still durable
  // and the 500 makes Meta retry (the dedup key makes that retry a no-op).
  const stored = await storeWebhookEvent(source, raw.toString("utf8"), payload);
  if (!stored) return reply.send({ ok: true, duplicate: true });
  try {
    await withTimeout(queue("events").add(JOBS.instagramEvent, { webhookEventId: stored.id }, { jobId: jobId("webhook", stored.id) }), 8_000, "enqueue webhook");
  } catch (err) {
    await one("DELETE FROM webhook_events WHERE id = $1", [stored.id]);
    await recordEvent("error", "webhook", "Queue unavailable; asked Meta to retry", { error: (err as Error).message });
    return reply.code(503).send({ error: "queue unavailable" });
  }
  return reply.send({ ok: true });
}

function redirectUri(): string {
  return `${env().PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/instagram/callback`;
}

function stateKey(): string {
  return env().ADMIN_TOKEN ?? env().ENCRYPTION_KEY ?? "dev-state-key";
}

function safeNext(n: string | undefined): string {
  return n && n.startsWith("/admin") && !n.startsWith("//") ? n : "/admin";
}

function authPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Influencer OS</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:light-dark(#f6f6f8,#0d0e12);color:light-dark(#12141a,#eceef2)}
form,.card{background:light-dark(#fff,#15171c);padding:28px;border-radius:16px;border:1px solid light-dark(#e3e4ea,#262a33);display:grid;gap:10px;width:min(380px,calc(100vw - 32px));box-shadow:0 12px 32px rgb(0 0 0/.08)}
h1{font-size:20px;margin:0}.sub{margin:0;color:light-dark(#636878,#9a9fad);font-size:14px}.err{margin:0;color:light-dark(#b3141a,#ff8a8a);font-size:14px}label{font-weight:600;font-size:14px}
input,button{font:inherit;min-height:44px;padding:8px 12px;border-radius:10px;border:1px solid light-dark(#d3d5dd,#343945);background:transparent;color:inherit}
button{background:#c8410e;border:0;color:#fff;font-weight:600;cursor:pointer}input:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
details{margin-top:6px;font-size:14px}summary{cursor:pointer;color:light-dark(#636878,#9a9fad)}.tok{display:grid;gap:8px;margin-top:8px}</style>${body}</html>`;
}
