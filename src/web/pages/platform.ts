import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { getControls, PLATFORM, setControls } from "../../config/controls.js";
import { env } from "../../config/env.js";
import { clearSetting, setSetting, settingsView, SETTINGS, type SettingGroup, type SettingView } from "../../config/settings.js";
import { maybeInfluencer, withInfluencer } from "../../context.js";
import { syncProfile } from "../../instagram/profileSync.js";
import { costByOperation, costReport, spendSummary } from "../../cost/ledger.js";
import { many, one } from "../../db/pool.js";
import { adapters } from "../../generation/adapters/index.js";
import { validateProvider } from "../../generation/registry.js";
import { allInfluencers, setStatus } from "../../influencers/manage.js";
import { llm } from "../../llm/llm.js";
import { notify } from "../../notify/telegram.js";
import { syncInfluencerSchedulers } from "../../queue/worker.js";
import { hostImage } from "../../storage/host.js";
import { attempt, consoleRouter, done, render, reviewer, selectCookie, type Req } from "../console.js";
import { action, ago, avatar, bar, button, card, empty, esc, field, header, icon, input, kpi, link, pill, status, table, tabs, usd } from "../ui/kit.js";

const GROUPS: Array<[SettingGroup, string, string]> = [
  ["llm", "Language model", "The brain: planning, replies, safety and vision checks."],
  ["generation", "Image & video providers", "Add any you have; the engine routes between them and falls back automatically."],
  ["storage", "Media storage", "Where generated images live so Instagram can fetch them."],
  ["instagram", "Instagram / Meta app", "Needed for Connect Instagram and direct webhooks."],
  ["openreply", "OpenReply relay", "When OpenReply owns the Meta webhook and relays events here."],
  ["alerts", "Alerts", "Where the agent pings you about reviews and failures."],
];

const TESTABLE = new Set(["llm", "supabase", "imgbb", "telegram", ...["kie", "higgsfield", "fal", "replicate", "runway", "luma", "topview"]]);

function settingRow(s: SettingView): string {
  const id = `set-${s.key}`;
  const control = s.choices
    ? `<select name="${s.key}" id="${id}"><option value="">${s.source === "unset" ? "— choose —" : "keep current"}</option>${s.choices.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select>`
    : `<div class="secret-row"><input id="${id}" name="${s.key}" type="${s.secret ? "password" : "text"}" autocomplete="off" placeholder="${esc(s.source === "unset" ? (s.placeholder ?? "not set") : s.secret ? "enter a new value to replace" : "")}" value="${s.secret ? "" : esc(s.source === "app" ? s.display : "")}">${
        s.secret ? `<button type="button" class="iconbtn" data-reveal="${id}" aria-label="Show ${esc(s.label)}" aria-pressed="false">${icon("key", 16)}</button>` : ""
      }</div>`;
  return `<div class="field"><label for="${id}">${esc(s.label)} <span class="src ${s.source}">${s.source === "app" ? "set here" : s.source === "env" ? "from env" : "not set"}</span>${
    s.display && s.secret ? ` <code class="meta">${esc(s.display)}</code>` : s.display && s.source === "env" ? ` <code class="meta">${esc(s.display)}</code>` : ""
  }</label>${control}<p class="help">${esc(s.help)}${s.source === "app" ? ` <label class="small"><input type="checkbox" name="clear" value="${s.key}"> clear (fall back to env)</label>` : ""}</p></div>`;
}

export function registerPlatform(app: FastifyInstance): void {
  const r = consoleRouter(app);

  // ------------------------------------------------------------ influencers
  r.get(
    "/admin/influencers",
    async (req: Req, reply) => {
      const rows = await allInfluencers();
      const body = `${header("Influencers", { sub: "Every influencer runs in isolation: its own persona, soul, Instagram account, memory, budgets and schedule.", actions: link("Hatch an influencer", "/admin/hatch", { variant: "primary", icon: "egg" }) })}
${
  rows.length
    ? `<div class="grid">${rows
        .map((i) =>
          card(
            `<div class="row" style="margin-bottom:10px">${avatar(i.avatar_url, i.name, 48)}<div><b style="font-size:17px">${esc(i.name)}</b><div class="meta">${i.username ? `@${esc(i.username)}` : "no Instagram yet"} · <code>${esc(i.slug)}</code></div></div><span class="right">${status(i.status)}</span></div>
            <div class="stats">${[
              ["Followers", i.followers],
              ["Following", i.follows],
              ["Posts", i.media],
            ]
              .map(([l, v]) => `<div><b>${v === null || v === undefined ? "—" : Number(v).toLocaleString("en")}</b><span>${l}</span></div>`)
              .join("")}</div>
            <dl class="kv"><dt>Soul</dt><dd>${i.soul_id ? `<code>${esc(i.soul_id)}</code>` : '<span class="muted">none</span>'}</dd><dt>Since</dt><dd>${ago(i.hatched_at ?? i.created_at)}</dd>${
              i.username ? `<dt>Synced</dt><dd>${ago(i.synced_at)}</dd>` : ""
            }</dl>
            <div class="row" style="margin-top:12px">${
              i.status === "hatching"
                ? link("Continue hatching", `/admin/hatch/${i.id}`, { variant: "primary", small: true })
                : `<form method="post" action="/admin/switch"><input type="hidden" name="id" value="${i.id}">${button("Open", { small: true, icon: "arrowRight" })}</form>`
            }${i.username && i.status !== "hatching" ? action(`/admin/influencers/${i.id}/sync`, "Refresh", { small: true, icon: "refresh", variant: "ghost" }) : ""}${i.status === "active" ? action(`/admin/influencers/${i.id}/status`, "Pause", { small: true, fields: { status: "paused" }, icon: "pause" }) : ""}${
              i.status === "paused" ? action(`/admin/influencers/${i.id}/status`, "Resume", { small: true, fields: { status: "active" }, icon: "play", variant: "primary" }) : ""
            }${i.status !== "archived" ? action(`/admin/influencers/${i.id}/status`, "Archive", { small: true, variant: "danger", fields: { status: "archived" }, confirm: `Archive ${i.name}? Scheduling stops and webhooks for its account are ignored. Data is kept.` }) : action(`/admin/influencers/${i.id}/status`, "Restore", { small: true, fields: { status: "paused" } })}</div>`,
          ),
        )
        .join("")}</div>`
    : card(empty("No influencers yet", "Hatch your first one: brief → persona → soul → Instagram → launch.", link("Hatch an influencer", "/admin/hatch", { variant: "primary", icon: "egg" })))
}`;
      return render(req, reply, { title: "Influencers", active: "influencers", body });
    },
    { platform: true },
  );
  r.post(
    "/admin/influencers/:id/status",
    async (req: Req, reply) =>
      attempt(req, reply, "/admin/influencers", async () => {
        const s = String(req.body?.status);
        if (!["active", "paused", "archived"].includes(s)) throw new Error("unknown status");
        await setStatus(Number(req.params.id), s as "active" | "paused" | "archived");
        await syncInfluencerSchedulers().catch(() => undefined);
        return `Status set to ${s}`;
      }),
    { platform: true, influencerParam: "id" },
  );

  r.post(
    "/admin/influencers/:id/sync",
    async (req: Req, reply) =>
      attempt(req, reply, "/admin/influencers", async () => {
        const n = await withInfluencer(Number(req.params.id), () => syncProfile());
        return n ? `@${n.username}: ${n.followers ?? "?"} followers, ${n.media ?? "?"} posts` : "No Instagram account attached";
      }),
    { platform: true, influencerParam: "id" },
  );

  // Influencer switcher (sidebar): remember the choice, return to the same page.
  app.post("/admin/switch", async (req: Req, reply) => {
    const id = Number(req.body?.id);
    const ok = await one("SELECT 1 FROM influencers WHERE id = $1 AND status <> 'archived'", [id]);
    if (!ok) return reply.redirect("/admin/influencers?flash=Unknown%20influencer", 303);
    const hatching = await one("SELECT 1 FROM influencers WHERE id = $1 AND status = 'hatching'", [id]);
    reply.header("set-cookie", selectCookie(id));
    const ref = String(req.headers.referer ?? "").replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const back = hatching ? `/admin/hatch/${id}` : ref.startsWith("/admin") && !/\/(posts|people|generation\/requests)\/[^/]+$/.test(ref) && !ref.startsWith("/admin/hatch") ? ref : "/admin";
    return reply.redirect(back, 303);
  });

  // ------------------------------------------------------------ config
  r.get(
    "/admin/config",
    async (req: Req, reply) => {
      const view = await settingsView();
      const has = (k: string) => view.find((v) => v.key === k)?.source !== "unset";
      const imageProviders = [...adapters().values()].filter((a) => a.id !== "mock" && a.credentialKeys.length && a.credentialKeys.every((k) => has(k)));
      const e = env();
      const checklist: Array<[boolean, string, string]> = [
        [Boolean(e.ENCRYPTION_KEY), "Encryption key", "Set ENCRYPTION_KEY on the service (env only) so secrets saved here are encrypted."],
        [Boolean(e.ADMIN_TOKEN), "Console password", "Set ADMIN_TOKEN on the service (env only)."],
        [has("LLM_API_KEY"), "Language model key", "Add your Anthropic (or compatible) key below."],
        [imageProviders.length > 0, "An image provider", imageProviders.length ? `${imageProviders.map((a) => a.displayName).join(", ")}` : "Add at least one: kie.ai is the cheapest start."],
        [has("SUPABASE_URL") && has("SUPABASE_SERVICE_ROLE_KEY") || has("IMGBB_API_KEY"), "Public media storage", "Supabase (preferred) or imgbb."],
        [has("INSTAGRAM_APP_ID") && has("INSTAGRAM_APP_SECRET"), "Instagram app", "Needed for Connect Instagram and verifying webhooks."],
        [has("OPENREPLY_RELAY_SECRET") || has("WEBHOOK_VERIFY_TOKEN"), "Webhook route", "OpenReply relay secret, or a verify token for direct Meta webhooks."],
      ];
      const done_ = checklist.filter((c) => c[0]).length;
      const body = `${header("Config & keys", {
        sub: "Set up every service in one place. Values saved here are encrypted, override environment variables, and apply to web and worker within ~15 seconds — no redeploy.",
      })}
${card(
  `<div class="row" style="margin-bottom:8px"><b>${done_}/${checklist.length} ready</b></div>${bar(done_, checklist.length)}
  <ul class="list">${checklist.map(([ok, t, h]) => `<li>${ok ? `<span style="color:var(--ok)">${icon("check", 18, "done")}</span>` : `<span style="color:var(--warn)">${icon("alert", 18, "missing")}</span>`}<div><b>${esc(t)}</b><div class="meta">${esc(h)}</div></div></li>`).join("")}</ul>`,
  { title: "Setup checklist" },
)}
${tabs(GROUPS.map(([g, t]) => ({ href: `#${g}`, label: t })))}
${GROUPS.map(([g, title, sub]) => {
  const items = view.filter((v) => v.group === g);
  const providers = [...new Set(items.map((i) => i.provider).filter((p): p is string => Boolean(p) && TESTABLE.has(p!)))];
  const tests = providers
    .map((p) => `<form method="post" action="/admin/config/test/${p}" data-async class="inline">${button(`Test ${p}`, { small: true, icon: "zap", variant: "ghost" })}</form>`)
    .join("");
  return card(`<p class="meta" style="margin-top:0">${esc(sub)}</p><form method="post" action="/admin/config#${g}" autocomplete="off"><input type="hidden" name="_group" value="${g}"><div class="cols">${items.map(settingRow).join("")}</div>${button("Save", { variant: "primary", icon: "check" })}</form>`, {
    title,
    id: g,
    actions: tests,
  });
}).join("")}`;
      return render(req, reply, { title: "Config & keys", active: "config", body });
    },
    { platform: true },
  );
  r.post(
    "/admin/config",
    async (req: Req, reply) =>
      attempt(req, reply, `/admin/config#${req.body?._group ?? ""}`, async () => {
        const b = (req.body ?? {}) as unknown as Record<string, string | string[]>;
        const clear = ([] as string[]).concat(b.clear ?? []);
        let saved = 0;
        for (const def of SETTINGS) {
          if (clear.includes(def.key)) {
            await clearSetting(def.key);
            saved++;
            continue;
          }
          const v = b[def.key];
          if (typeof v !== "string" || !v.trim()) continue;
          await setSetting(def.key, v, reviewer(req));
          saved++;
        }
        return saved ? `Saved ${saved} setting${saved === 1 ? "" : "s"}` : "Nothing changed";
      }),
    { platform: true },
  );
  r.post(
    "/admin/config/test/:provider",
    async (req: Req, reply) => {
      const p = req.params.provider;
      try {
        let msg: string;
        if (p === "llm") {
          const out = await llm().generate({ operation: "config.test", tier: "fast", maxTokens: 10, system: "Reply with exactly: OK", prompt: "ping" });
          msg = `LLM answered: ${out.trim().slice(0, 40)}`;
        } else if (p === "supabase" || p === "imgbb") {
          const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 90, b: 31 } } }).jpeg().toBuffer();
          const r = await hostImage(png, `system/config-check-${p}.jpg`, { order: [p] });
          msg = `${p} works: ${r.url}`;
        } else if (p === "telegram") {
          await notify("✅ Test alert from the Influencer OS console");
          msg = "Test message sent (check Telegram)";
        } else {
          const v = await validateProvider(p);
          return done(req, reply, "/admin/config", `${p}: ${v.detail}`, v.ok);
        }
        return done(req, reply, "/admin/config", msg);
      } catch (e) {
        return done(req, reply, "/admin/config", `${p} failed: ${(e as Error).message}`, false);
      }
    },
    { platform: true },
  );

  // ------------------------------------------------------------ costs
  r.get(
    "/admin/costs",
    async (req: Req, reply) => {
      const inf = maybeInfluencer();
      const [report, byOp, platform, all, perInf, daily, c] = await Promise.all([
        inf ? costReport() : Promise.resolve({} as Record<string, number>),
        inf ? costByOperation(30) : Promise.resolve([]),
        getControls(true, PLATFORM),
        spendSummary("all"),
        many<{ name: string; today: number; month: number }>(
          `SELECT i.name, coalesce(sum(c.cost_usd) FILTER (WHERE c.occurred_at::date = now()::date),0)::float AS today,
             coalesce(sum(c.cost_usd) FILTER (WHERE c.occurred_at > date_trunc('month', now())),0)::float AS month
           FROM influencers i LEFT JOIN cost_ledger c ON c.influencer_id = i.id GROUP BY i.id, i.name ORDER BY month DESC`,
        ),
        inf
          ? many<{ day: string; llm: number; image: number }>(
              `SELECT occurred_at::date::text AS day, coalesce(sum(cost_usd) FILTER (WHERE category='llm'),0)::float AS llm,
                 coalesce(sum(cost_usd) FILTER (WHERE category='image'),0)::float AS image
               FROM cost_ledger WHERE influencer_id = $1 AND occurred_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1 DESC`,
              [inf.id],
            )
          : Promise.resolve([]),
        inf ? getControls() : Promise.resolve(undefined),
      ]);
      const body = `${header("Costs", { sub: "Every paid call is budget-checked before it runs and recorded after." })}
<div class="kpis">
${kpi("Platform today", usd(all.today), { icon: "wallet", hint: `cap ${usd(platform.platform_daily_budget_usd)}` })}
${kpi("Platform this month", usd(all.month), { icon: "wallet", hint: `cap ${usd(platform.platform_monthly_budget_usd)}` })}
${inf ? Object.entries(report).slice(0, 3).map(([k, v]) => kpi(`${inf.name}: ${k.replace(/_/g, " ")}`, usd(v))).join("") : ""}
</div>
<div class="grid-2">
${card(
  `<form method="post" action="/admin/costs/platform" class="cols">
    ${field("Daily cap, all influencers (USD)", input("platform_daily_budget_usd", platform.platform_daily_budget_usd, { type: "number", attrs: 'step="0.5" min="0"' }))}
    ${field("Monthly cap, all influencers (USD)", input("platform_monthly_budget_usd", platform.platform_monthly_budget_usd, { type: "number", attrs: 'step="1" min="0"' }))}
    <div>${button("Save caps", { variant: "primary", icon: "check" })}</div></form>
    ${bar(all.today, platform.platform_daily_budget_usd)}<p class="meta">Per-influencer budgets live in each influencer's <a href="/admin/controls">Controls</a>.</p>`,
  { title: "Platform budget", id: "platform" },
)}
${card(table(["Influencer", "Today", "Month"], perInf.map((p) => [esc(p.name), usd(p.today), usd(p.month)])), { title: "By influencer" })}
</div>
${
  inf && c
    ? `<div class="grid">${card(table(["Category", "Operation", "Calls", "USD"], byOp.map((o) => [esc(o.category), `<code>${esc(o.operation)}</code>`, String(o.n), usd(o.usd)])), { title: `${inf.name}: by operation (30d)` })}
${card(table(["Day", "LLM", "Images"], daily.map((d) => [esc(d.day), usd(d.llm), usd(d.image)])), { title: `${inf.name}: daily` })}</div>`
    : ""
}`;
      return render(req, reply, { title: "Costs", active: "costs", body });
    },
    { platform: true },
  );
  r.post(
    "/admin/costs/platform",
    async (req: Req, reply) =>
      attempt(req, reply, "/admin/costs#platform", async () => {
        const num = (k: string) => {
          const t = String(req.body?.[k] ?? "").trim();
          const v = Number(t);
          if (!t || !Number.isFinite(v) || v < 0) throw new Error(`${k.replace(/_/g, " ")} must be a number of dollars`);
          return v;
        };
        await setControls({ platform_daily_budget_usd: num("platform_daily_budget_usd"), platform_monthly_budget_usd: num("platform_monthly_budget_usd") }, reviewer(req), PLATFORM);
        return "Platform caps saved";
      }),
    { platform: true },
  );

  // ------------------------------------------------------------ events & jobs
  r.get(
    "/admin/events",
    async (req: Req, reply) => {
      const scope = req.query.scope === "all" || !maybeInfluencer() ? "all" : "mine";
      const id = maybeInfluencer()?.id ?? null;
      const [events, runs, failures] = await Promise.all([
        many<{ level: string; source: string; message: string; data: unknown; created_at: Date; influencer_id: number | null }>(
          "SELECT * FROM system_events WHERE ($1 = 'all' OR influencer_id = $2 OR influencer_id IS NULL) ORDER BY id DESC LIMIT 150",
          [scope, id],
        ),
        many<{ queue: string; job_name: string; status: string; attempt: number; duration_ms: number | null; error: string | null; created_at: Date }>(
          "SELECT * FROM job_runs WHERE ($1 = 'all' OR influencer_id = $2 OR influencer_id IS NULL) ORDER BY id DESC LIMIT 60",
          [scope, id],
        ),
        many<{ job_name: string; n: number; avg_ms: number | null }>(
          `SELECT job_name, count(*) FILTER (WHERE status <> 'completed')::int AS n, avg(duration_ms)::int AS avg_ms FROM job_runs WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`,
        ),
      ]);
      const body = `${header("Events & jobs")}
${tabs([
  { href: "/admin/events", label: "This influencer + platform", active: scope === "mine" },
  { href: "/admin/events?scope=all", label: "Everything", active: scope === "all" },
])}
<div class="grid">
${card(table(["Job", "Failures / retries", "Avg ms"], failures.map((f) => [`<code>${esc(f.job_name)}</code>`, String(f.n), String(f.avg_ms ?? "—")])), { title: "Jobs (24h, platform)" })}
${card(table(["When", "Job", "Status", "Try", "ms", "Error"], runs.map((x) => [ago(x.created_at), `<code>${esc(x.job_name)}</code>`, pill(x.status), String(x.attempt), String(x.duration_ms ?? ""), `<span class="small">${esc(x.error ?? "")}</span>`])), { title: "Recent job runs" })}
</div>
${card(
  table(
    ["When", "Level", "Source", "Message", ""],
    events.map((e) => [ago(e.created_at), pill(e.level), esc(e.source), esc(e.message), `<details><summary class="small">data</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details>`]),
  ),
  { title: "System events" },
)}`;
      return render(req, reply, { title: "Events", active: "events", body });
    },
    { platform: true },
  );
}
