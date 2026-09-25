import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getControls } from "../config/controls.js";
import { env } from "../config/env.js";
import { loadInfluencer, maybeInfluencer, runInContext, type InfluencerContext } from "../context.js";
import { many, one } from "../db/pool.js";
import { errorMessage } from "../lib/errors.js";
import { shell, type ShellInfluencer } from "./ui/shell.js";

export type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: Record<string, string> }>;
export type Handler = (req: Req, reply: FastifyReply) => unknown;

export const INF_COOKIE = "aia_inf";

export function selectedInfluencer(req: FastifyRequest): number | undefined {
  const m = new RegExp(`(?:^|;\\s*)${INF_COOKIE}=(\\d+)`).exec(req.headers.cookie ?? "");
  return m ? Number(m[1]) : undefined;
}

export function selectCookie(id: number): string {
  const secure = env().PUBLIC_BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `${INF_COOKIE}=${id}; Path=/; SameSite=Lax; Max-Age=${365 * 86400}${secure}`;
}

async function loadable(id: number): Promise<InfluencerContext | undefined> {
  try {
    const ctx = await loadInfluencer(id);
    return ctx.status === "archived" ? undefined : ctx;
  } catch {
    return undefined;
  }
}

/** The influencer the console is looking at: the cookie's, else the first active one with a persona. */
export async function resolveInfluencer(req: FastifyRequest): Promise<InfluencerContext | undefined> {
  const wanted = selectedInfluencer(req);
  if (wanted) {
    const c = await loadable(wanted);
    if (c) return c;
  }
  const rows = await many<{ id: number }>(
    "SELECT id FROM influencers WHERE status <> 'archived' AND persona_yaml <> '' ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, id",
  );
  for (const r of rows) {
    const c = await loadable(Number(r.id));
    if (c) return c;
  }
  return undefined;
}

/**
 * Route registration for console pages. Every handler runs inside the
 * selected influencer's context; `needsInfluencer` pages send the operator to
 * the Hatch wizard when there is none yet.
 */
export function consoleRouter(app: FastifyInstance) {
  const wrap =
    (h: Handler, needsInfluencer: boolean) =>
    async (req: Req, reply: FastifyReply) => {
      const ctx = await resolveInfluencer(req);
      if (!ctx) {
        if (needsInfluencer) return reply.redirect("/admin/hatch?flash=" + encodeURIComponent("Hatch your first influencer to get started"), 303);
        return h(req, reply);
      }
      return runInContext(ctx, async () => h(req, reply));
    };
  return {
    get: (path: string, h: Handler, o: { platform?: boolean } = {}) => app.get(path, wrap(h, !o.platform) as never),
    post: (path: string, h: Handler, o: { platform?: boolean } = {}) => app.post(path, wrap(h, !o.platform) as never),
  };
}

export interface PageSpec {
  title: string;
  active: string;
  body: string;
  head?: string;
  scripts?: string;
}

export async function shellInfluencers(): Promise<ShellInfluencer[]> {
  return many<ShellInfluencer>(
    `SELECT i.id::int, i.name, i.slug, i.status, i.avatar_url, a.username
     FROM influencers i LEFT JOIN ig_accounts a ON a.influencer_id = i.id AND a.is_primary
     WHERE i.status <> 'archived' ORDER BY CASE i.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, i.id`,
  );
}

export async function render(req: Req, reply: FastifyReply, p: PageSpec) {
  const ctx = maybeInfluencer();
  const influencers = await shellInfluencers();
  let mode: string | undefined;
  let paused: boolean | undefined;
  let pending = 0;
  if (ctx) {
    const c = await getControls();
    mode = c.mode;
    paused = c.paused;
    pending = (await one<{ n: number }>("SELECT count(*)::int AS n FROM safety_reviews WHERE status = 'pending' AND influencer_id = $1", [ctx.id]))?.n ?? 0;
  }
  const flash = typeof req.query?.flash === "string" ? req.query.flash : undefined;
  return reply.type("text/html").send(
    shell({
      ...p,
      flash,
      current: ctx ? influencers.find((i) => i.id === ctx.id) : undefined,
      influencers,
      mode,
      paused,
      pendingReviews: pending,
      openAccess: !env().ADMIN_TOKEN,
    }),
  );
}

const wantsJson = (req: FastifyRequest) => String(req.headers.accept ?? "").includes("application/json");

/** Finish a POST: JSON for async forms, redirect-with-flash otherwise. */
export function done(req: FastifyRequest, reply: FastifyReply, to: string, message: string, ok = true, extra: Record<string, unknown> = {}) {
  if (wantsJson(req)) return reply.send({ ok, message, ...extra });
  return reply.redirect(`${to}${to.includes("?") ? "&" : "?"}flash=${encodeURIComponent(message)}`, 303);
}

/** Run a POST action; any error becomes a readable flash instead of a 500. */
export async function attempt(req: FastifyRequest, reply: FastifyReply, to: string, fn: () => Promise<string | { message: string; to?: string; extra?: Record<string, unknown> }>) {
  try {
    const r = await fn();
    if (typeof r === "string") return done(req, reply, to, r);
    return done(req, reply, r.to ?? to, r.message, true, r.extra);
  } catch (e) {
    return done(req, reply, to, `Not saved: ${errorMessage(e)}`, false);
  }
}

export const reviewer = (req: FastifyRequest) => (req.headers["x-reviewer"] as string | undefined) ?? "admin";
export const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
