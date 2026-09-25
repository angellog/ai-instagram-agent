import { createReadStream, existsSync } from "node:fs";
import formbody from "@fastify/formbody";
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
import { localMediaPath } from "../storage/host.js";
import { registerAdmin, selectedInfluencer } from "./admin.js";
import { setting } from "../config/settings.js";
import { listInfluencers, withInfluencer } from "../context.js";
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

/** ADMIN_TOKEN via Bearer header (API) or a signed session cookie (dashboard). Open only in development without a token. */
export function isAuthorized(req: FastifyRequest): boolean {
  const token = env().ADMIN_TOKEN;
  if (!token) return env().NODE_ENV !== "production";
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ") && safeEqual(auth.slice(7), token)) return true;
  const cookie = readCookie(req, SESSION_COOKIE);
  return Boolean(cookie && safeEqual(cookie, sessionValue(token)));
}

export async function buildServer(): Promise<FastifyInstance> {
  const e = env();
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  await app.register(formbody);

  // Keep the raw bytes: Meta's signature is over the exact body.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    const isAdmin = url === "/admin" || url.startsWith("/admin/") || url.startsWith("/api/");
    if (!isAdmin || url === "/admin/login") return;
    if (isAuthorized(req)) return;
    if (url.startsWith("/api/")) return reply.code(401).send({ error: "unauthorized" });
    return reply.redirect(`/admin/login?next=${encodeURIComponent(req.url)}`, 303);
  });

  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 500) logger.error({ url: req.url, status: reply.statusCode }, "request failed");
  });

  app.setErrorHandler(async (err, req, reply) => {
    logger.error({ err, url: req.url }, "unhandled route error");
    await recordEvent("error", "web", "Unhandled route error", { url: req.url.split("?")[0], error: (err as Error).message });
    return reply.code(500).send({ error: "internal error" });
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
    const next = safeNext(req.query.next);
    return reply.type("text/html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f5f2}form{background:#fff;padding:24px;border-radius:14px;border:1px solid #e6e3dd;display:grid;gap:10px;width:min(360px,90vw)}input,button{font:inherit;padding:8px;border-radius:8px;border:1px solid #ddd}button{background:#ff5a1f;color:#fff;border:0}</style>
<form method="post" action="/admin/login"><b>AI agent admin</b><input type="password" name="token" placeholder="ADMIN_TOKEN" autofocus><input type="hidden" name="next" value="${next.replace(/"/g, "")}"><button>Sign in</button></form>`);
  });
  app.post("/admin/login", async (req: FastifyRequest<{ Body: Record<string, string> }>, reply) => {
    const token = env().ADMIN_TOKEN;
    const given = req.body?.token ?? "";
    if (!token || !safeEqual(given, token)) return reply.code(401).type("text/html").send(`Wrong token. <a href="/admin/login">Try again</a>`);
    const secure = env().PUBLIC_BASE_URL.startsWith("https://") ? "; Secure" : "";
    reply.header("set-cookie", `${SESSION_COOKIE}=${sessionValue(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
    return reply.redirect(safeNext(req.body?.next), 303);
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
