import type { FastifyInstance } from "fastify";
import { createEvent } from "../../calendar/events.js";
import { currentInfluencer, influencerId } from "../../context.js";
import { one } from "../../db/pool.js";
import { latestBrief, recentHeadlines, refreshTrends, trendSources, type TrendSource } from "../../trends/trends.js";
import { attempt, consoleRouter, render, type Req } from "../console.js";
import { action, ago, card, empty, esc, header, icon, link, pill, table } from "../ui/kit.js";

export function registerTrends(app: FastifyInstance): void {
  const r = consoleRouter(app);

  r.get("/admin/trends", async (req: Req, reply) => {
    const inf = currentInfluencer();
    const [brief, heads] = await Promise.all([latestBrief(), recentHeadlines(40)]);
    const groups = new Map<string, TrendSource[]>();
    for (const s of trendSources(inf.persona)) groups.set(s.label, [...(groups.get(s.label) ?? []), s]);
    const sources = [...groups.entries()].map(
      ([label, list]) =>
        `<li style="display:block"><b>${esc(label)}</b><div class="meta">${list
          .map((s) => `${s.kind === "search" ? icon("search", 12) : icon("activity", 12)} <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.kind === "search" ? `“${s.detail}”` : new URL(s.url).hostname)}</a>`)
          .join(" · ")}</div></li>`,
    );
    const body = `${header("Trends & news", {
      sub: `What ${esc(inf.name)} keeps up with. Every 6 hours the agent reads these sources, skips politics and tragedy, and keeps a short brief that posts and replies can nod to.`,
      actions: action("/admin/trends/refresh", "Refresh now", { icon: "refresh", variant: "primary" }),
    })}
<div class="grid-2">
${card(
  brief && brief.items.length
    ? `<p class="meta" style="margin-top:0">Updated ${ago(brief.created_at)} · ${brief.skipped} headline${brief.skipped === 1 ? "" : "s"} skipped as off-topic or sensitive</p>
       <ul class="list">${brief.items
         .map(
           (i, n) =>
             `<li><div style="flex:1"><span class="pill info">${esc(i.source.split(" · ")[0])}</span> <b>${esc(i.title)}</b><div class="meta">${esc(i.note)} · ${esc(i.source.split(" · ").slice(1).join(" · "))}</div></div><div class="row">${pill(i.use === "post" ? "post idea" : i.use)}${action(
               `/admin/trends/${n}/calendar`,
               "Add to calendar",
               { small: true, variant: "ghost", icon: "calendar" },
             )}<a class="btn sm ghost" href="${esc(i.link)}" target="_blank" rel="noopener" aria-label="Open article">${icon("external", 14)}</a></div></li>`,
         )
         .join("")}</ul>`
    : empty(brief ? "Nothing worth knowing right now" : "No brief yet", sources.length ? "Press Refresh now to read the sources." : "Add news searches or feeds under trends in the persona."),
  { title: "This week's brief" },
)}
${card(
  sources.length ? `<ul class="list">${sources.join("")}</ul>` : empty("No sources", "Edit the persona: trends.queries and trends.feeds."),
  { title: "Sources", actions: link("Edit in persona", "/admin/persona#edit", { small: true, variant: "ghost" }) },
)}
</div>
${card(
  table(
    ["When", "Source", "Headline"],
    heads.map((h) => [ago(h.published_at ?? h.fetched_at), `<span class="meta">${esc(h.source)}</span>`, `<a href="${esc(h.link)}" target="_blank" rel="noopener">${esc(h.title)}</a>`]),
    "No headlines collected yet.",
  ),
  { title: "Raw headlines (last collected)" },
)}`;
    return render(req, reply, { title: "Trends & news", active: "trends", body });
  });

  r.post("/admin/trends/refresh", async (req: Req, reply) =>
    attempt(req, reply, "/admin/trends", async () => {
      const res = await refreshTrends();
      return `${res.kept} kept from ${res.headlines} headline${res.headlines === 1 ? "" : "s"}${res.errors.length ? ` (${res.errors.length} source${res.errors.length === 1 ? "" : "s"} failed)` : ""}`;
    }),
  );

  // Turn a brief item into a calendar event so it becomes planned content and, later, a memory.
  r.post("/admin/trends/:n/calendar", async (req: Req, reply) =>
    attempt(req, reply, "/admin/trends", async () => {
      const b = await latestBrief();
      const item = b?.items[Number(req.params.n)];
      if (!item) throw new Error("that headline is no longer in the brief");
      const dup = await one("SELECT 1 FROM calendar_events WHERE influencer_id = $1 AND description LIKE $2", [influencerId(), `%${item.link}%`]);
      if (dup) return "Already on the calendar";
      await createEvent({ title: item.title.slice(0, 160), description: `${item.note}\n${item.link}`, kind: "culture", starts_at: new Date(), all_day: true, use_for: item.use === "post" ? "content" : "both" });
      return "Added to today's calendar";
    }),
  );
}
