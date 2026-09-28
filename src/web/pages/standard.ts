import type { FastifyInstance } from "fastify";
import { many } from "../../db/pool.js";
import { evaluateAll, STANDARD, type Check, type StandardReport, type StandardRun } from "../../influencers/standard.js";
import { JOBS, jobId, queue } from "../../queue/queues.js";
import { attempt, consoleRouter, render, type Req } from "../console.js";
import { ago, bar, button, card, empty, esc, header, icon, link, pill } from "../ui/kit.js";

/** A run older than this that never finished is treated as lost (worker restart). */
const STALE_MS = 20 * 60_000;
const running = (r: StandardRun | undefined) => r?.status === "running" && Date.now() - Date.parse(r.started_at) < STALE_MS;

const FIX_LABEL: Record<Check["fix"], string> = { auto: "fixed automatically", ai: "AI fills it in", manual: "needs you" };

async function queueRun(id: number): Promise<boolean> {
  const row = await many<{ standard_run: StandardRun }>("SELECT standard_run FROM influencers WHERE id = $1", [id]);
  if (running(row[0]?.standard_run)) return false;
  // Marked running from the moment it's queued, so a second click can't queue a duplicate.
  await many("UPDATE influencers SET standard_run = $2 WHERE id = $1 RETURNING id", [id, JSON.stringify({ status: "running", started_at: new Date().toISOString(), fixed: [], remaining: [] })]);
  await queue("maintenance").add(JOBS.standardize, { influencerId: id }, { jobId: jobId("standard", id, Date.now()), attempts: 1 });
  return true;
}

/** Manual fixes open the right page for THIS influencer, whatever the sidebar has selected. */
function fixLink(id: number, href: string): string {
  if (href.startsWith("/admin/hatch/")) return link("Fix", href, { small: true, variant: "ghost" });
  return `<form method="post" action="/admin/switch" class="inline"><input type="hidden" name="id" value="${id}"><input type="hidden" name="to" value="${esc(href)}"><button class="btn sm ghost" type="submit" title="Needs you: opens the page to fix it">${icon("arrowRight", 14)}<span>Fix</span></button></form>`;
}

function influencerCard(rep: StandardReport, run: StandardRun | undefined): string {
  const groups = [...new Set(rep.checks.map((c) => c.group))];
  const busy = running(run);
  const fixable = rep.checks.some((c) => !c.ok && c.fix !== "manual");
  const pct = Math.round((100 * rep.passed) / Math.max(1, rep.total));
  return card(
    `<div class="row" style="align-items:center;gap:12px;margin-bottom:8px"><b style="font-size:17px">${esc(rep.name)}</b>${pill(rep.status)}<span class="right meta">${rep.looks ? `${rep.looks} looks · ` : ""}${rep.passed}/${rep.total} meet the standard</span></div>
     ${bar(rep.passed, rep.total)}
     ${
       busy
         ? `<div class="callout warn" style="margin-top:12px">${icon("refresh")}<p>Bringing ${esc(rep.name)} up to standard… This page refreshes on its own.</p></div>`
         : run?.status === "done"
           ? `<div class="callout ${run.remaining.length ? "warn" : "ok"}" style="margin-top:12px">${icon(run.remaining.length ? "info" : "check")}<p>Last run ${ago(new Date(run.finished_at ?? run.started_at))}: ${run.fixed.length ? `fixed ${esc(run.fixed.join(", "))}` : "nothing to fix automatically"}.${run.remaining.length ? ` ${run.remaining.length} item(s) need you.` : ""}</p></div>`
           : run?.status === "failed"
             ? `<div class="callout bad" style="margin-top:12px">${icon("alert")}<p>Last run failed: ${esc(run.error ?? "unknown error")}</p></div>`
             : ""
     }
     ${groups
       .map(
         (g) =>
           `<h4 class="std-h">${esc(g)}</h4><ul class="std">${rep.checks
             .filter((c) => c.group === g)
             .map(
               (c) =>
                 `<li class="${c.ok ? "ok" : "no"}"><span class="std-i" aria-label="${c.ok ? "meets the standard" : "falls short"}">${icon(c.ok ? "check" : "x", 14)}</span><div><b>${esc(c.label)}</b><div class="meta">${esc(c.detail)}</div></div>${
                   c.ok ? "" : c.fix === "manual" && c.href ? fixLink(rep.id, c.href) : `<span class="std-fix">${esc(FIX_LABEL[c.fix])}</span>`
                 }</li>`,
             )
             .join("")}</ul>`,
       )
       .join("")}
     <div class="row" style="margin-top:12px">${
       rep.passed === rep.total
         ? `<span class="muted">${icon("check", 14)} Meets the standard.</span>`
         : fixable && !busy
           ? `<form method="post" action="/admin/standard/${rep.id}">${button("Bring up to standard", { variant: "primary", icon: "wand" })}</form><span class="meta">About 1–3 minutes. AI only rewrites the sections that fall short.</span>`
           : busy
             ? ""
             : `<span class="meta">What's left needs you: use the Fix links.</span>`
     }</div>`,
    { id: `inf-${rep.id}` },
  );
}

export function registerStandard(app: FastifyInstance): void {
  const r = consoleRouter(app);

  r.get(
    "/admin/standard",
    async (req: Req, reply) => {
      const [reports, runs] = await Promise.all([evaluateAll(), many<{ id: number; standard_run: StandardRun }>("SELECT id, standard_run FROM influencers")]);
      const runOf = new Map(runs.map((x) => [Number(x.id), x.standard_run?.status ? x.standard_run : undefined]));
      const anyBusy = reports.some((rep) => running(runOf.get(rep.id)));
      const below = reports.filter((rep) => rep.passed < rep.total && rep.checks.some((c) => !c.ok && c.fix !== "manual"));
      const body = `${header("Influencer Standard", {
        sub: "One master checklist every influencer is held to, however it was hatched. New influencers are brought up to it automatically.",
        actions: below.length ? `<form method="post" action="/admin/standard/all">${button(`Bring ${below.length === 1 ? "one" : `all ${below.length}`} up to standard`, { variant: "primary", icon: "wand" })}</form>` : "",
      })}
${card(
  `<div class="stats" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">${[
    [`${STANDARD.looks}+`, "looks from the closet"],
    [`${STANDARD.tops} / ${STANDARD.bottoms}`, "tops / bottoms"],
    [`${STANDARD.layers} / ${STANDARD.activewear}`, "layers / activewear"],
    [`${STANDARD.signature_outfits}+`, "signature outfits"],
    [`${STANDARD.occasions}+`, "occasion outfits"],
    [`${STANDARD.activities}+`, `activities, ${STANDARD.activity_slots}+ times of day`],
    [`${STANDARD.weekend_activities}+`, "weekend activities"],
    [`${STANDARD.weekend_ideas}+`, "weekend post ideas"],
    [`${STANDARD.locations}+`, "places"],
    [`${STANDARD.trend_queries}+`, "labelled news searches"],
  ]
    .map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`)
    .join("")}</div>
   <p class="help" style="margin-top:10px">Plus: openly AI, a soul face, a profile kit (bio + picture), Instagram connected, a news brief under ${STANDARD.trends_max_age_h}h old, replies that know she's AI, and true business facts for any brand she's affiliated with. Business facts are never invented: you add them.</p>`,
  { title: "The standard" },
)}
${reports.length ? `<div class="grid std-grid">${reports.map((rep) => influencerCard(rep, runOf.get(rep.id))).join("")}</div>` : card(empty("No influencers yet"))}`;
      return render(req, reply, { title: "Standard", active: "standard", body, head: `${STYLE}${anyBusy ? '<meta http-equiv="refresh" content="6">' : ""}` });
    },
    { platform: true },
  );

  r.post(
    "/admin/standard/all",
    async (req: Req, reply) =>
      attempt(req, reply, "/admin/standard", async () => {
        const reports = await evaluateAll();
        let n = 0;
        for (const rep of reports) if (rep.checks.some((c) => !c.ok && c.fix !== "manual") && (await queueRun(rep.id))) n++;
        return n ? `Bringing ${n} influencer${n === 1 ? "" : "s"} up to standard…` : "Nothing to fix automatically";
      }),
    { platform: true },
  );

  r.post(
    "/admin/standard/:id",
    async (req: Req, reply) =>
      attempt(req, reply, `/admin/standard#inf-${req.params.id}`, async () => ((await queueRun(Number(req.params.id))) ? "Bringing it up to standard…" : "Already running")),
    { platform: true, influencerParam: "id" },
  );
}

const STYLE = `<style>
.std-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr))}
.std-h{margin:14px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.std{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.std li{display:grid;grid-template-columns:22px 1fr auto;gap:10px;align-items:start;padding:7px 0;border-bottom:1px solid var(--line)}
.std li:last-child{border-bottom:0}
.std-i{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;margin-top:1px}
.std li.ok .std-i{background:var(--ok-bg);color:var(--ok)}.std li.no .std-i{background:var(--bad-bg);color:var(--bad)}
.std-fix{font-size:12px;color:var(--muted);white-space:nowrap}
</style>`;
