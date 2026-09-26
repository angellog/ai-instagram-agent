import type { FastifyInstance, FastifyReply } from "fastify";
import { createEvent, deleteEvent, EVENT_KINDS, listEvents, updateEvent, type CalendarEvent, type EventInput } from "../../calendar/events.js";
import { currentInfluencer, influencerId } from "../../context.js";
import { zonedToUtc } from "../../content/schedule.js";
import { many } from "../../db/pool.js";
import { errorMessage } from "../../lib/errors.js";
import { attempt, consoleRouter, render, type Req } from "../console.js";
import { button, card, empty, esc, field, header, icon, input, select, textarea } from "../ui/kit.js";

const FC = "https://cdn.jsdelivr.net/npm/fullcalendar@7.1.0";

const KIND_COLOR: Record<string, string> = {
  world: "#2563eb",
  personal: "#ff5a1f",
  business: "#0f766e",
  holiday: "#9333ea",
  launch: "#db2777",
  sport: "#16a34a",
  culture: "#ca8a04",
};

function toFc(e: CalendarEvent) {
  return {
    id: String(e.id),
    title: `${e.importance === 3 ? "★ " : ""}${e.title}`,
    start: new Date(e.starts_at).toISOString(),
    end: e.ends_at ? new Date(e.ends_at).toISOString() : undefined,
    allDay: e.all_day,
    color: KIND_COLOR[e.kind] ?? "#64748b",
    extendedProps: {
      raw: {
        title: e.title,
        description: e.description,
        kind: e.kind,
        location: e.location,
        importance: e.importance,
        use_for: e.use_for,
        outcome: e.outcome,
        shared: e.influencer_id === null,
        starts_at: e.starts_at,
        ends_at: e.ends_at,
        all_day: e.all_day,
        recapped: Boolean(e.recapped_at),
      },
    },
  };
}

function bodyJson(req: Req): Record<string, unknown> {
  const b = req.body as unknown;
  if (Buffer.isBuffer(b)) return JSON.parse(b.toString("utf8") || "{}");
  if (typeof b === "string") return JSON.parse(b || "{}");
  return (b ?? {}) as Record<string, unknown>;
}

/** Normalise dialog/form input into EventInput (form posts send strings). */
function toInput(b: Record<string, unknown>): Partial<EventInput> {
  const s = (k: string) => (b[k] === undefined || b[k] === null ? undefined : String(b[k]));
  const bool = (k: string) => b[k] === true || b[k] === "true" || b[k] === "1" || b[k] === "on";
  const out: Partial<EventInput> = {};
  if (s("title") !== undefined) out.title = s("title");
  if (s("description") !== undefined) out.description = s("description") || null;
  if (s("kind")) out.kind = s("kind") as EventInput["kind"];
  if (s("starts_at")) out.starts_at = s("starts_at")!;
  if (b.ends_at !== undefined) out.ends_at = s("ends_at") || null;
  if (b.all_day !== undefined) out.all_day = bool("all_day");
  if (s("location") !== undefined) out.location = s("location") || null;
  if (s("importance")) out.importance = Number(s("importance"));
  if (s("use_for")) out.use_for = s("use_for") as EventInput["use_for"];
  if (b.outcome !== undefined) out.outcome = s("outcome") || null;
  if (b.shared !== undefined) out.shared = bool("shared");
  return out;
}

const fail = (reply: FastifyReply, e: unknown) => reply.code(400).send({ ok: false, message: errorMessage(e) });

export function registerCalendar(app: FastifyInstance): void {
  const r = consoleRouter(app);

  // ------------------------------------------------------------ JSON API (FullCalendar)
  r.get("/admin/api/calendar", async (req: Req, reply) => {
    const start = new Date(req.query.start ?? Date.now() - 31 * 86400_000);
    const end = new Date(req.query.end ?? Date.now() + 62 * 86400_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return reply.code(400).send({ ok: false, message: "bad range" });
    return (await listEvents(start, end)).map(toFc);
  });
  r.post("/admin/api/calendar", async (req: Req, reply) => {
    try {
      const e = await createEvent(toInput(bodyJson(req)) as EventInput);
      return { ok: true, message: `Added “${e.title}”`, event: toFc(e) };
    } catch (e) {
      return fail(reply, e);
    }
  });
  r.post("/admin/api/calendar/:id", async (req: Req, reply) => {
    try {
      const e = await updateEvent(Number(req.params.id), toInput(bodyJson(req)));
      return { ok: true, message: `Saved “${e.title}”`, event: toFc(e) };
    } catch (e) {
      return fail(reply, e);
    }
  });
  r.post("/admin/api/calendar/:id/delete", async (req: Req, reply) => {
    try {
      await deleteEvent(Number(req.params.id));
      return { ok: true, message: "Deleted" };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // No-JS fallbacks (quick add, outcome) that redirect back.
  r.post("/admin/calendar/add", async (req: Req, reply) =>
    attempt(req, reply, "/admin/calendar", async () => {
      const body = { ...(req.body as Record<string, unknown>) };
      const d = String(body.starts_at ?? "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) body.starts_at = zonedToUtc(`${d}T00:00`, currentInfluencer().persona.identity.timezone).toISOString();
      const e = await createEvent(toInput(body) as EventInput);
      return `Added “${e.title}”`;
    }),
  );
  r.post("/admin/calendar/:id/outcome", async (req: Req, reply) =>
    attempt(req, reply, "/admin/calendar", async () => {
      const e = await updateEvent(Number(req.params.id), { outcome: String(req.body?.outcome ?? "").trim() || null });
      return `Saved what happened at “${e.title}” — it becomes a memory within the hour`;
    }),
  );

  // ------------------------------------------------------------ page
  r.get("/admin/calendar", async (req: Req, reply) => {
    const inf = currentInfluencer();
    const tz = inf.persona.identity.timezone;
    const now = new Date();
    const [upcoming, needOutcome, memories] = await Promise.all([
      listEvents(now, new Date(now.getTime() + 21 * 86400_000)),
      many<CalendarEvent>(
        `SELECT * FROM calendar_events WHERE (influencer_id IS NULL OR influencer_id = $1) AND coalesce(ends_at, starts_at + CASE WHEN all_day THEN interval '1 day' ELSE interval '0' END) < now()
           AND starts_at > now() - interval '30 days' AND (outcome IS NULL OR outcome = '') ORDER BY starts_at DESC LIMIT 8`,
        [influencerId()],
      ),
      many<{ content: string }>("SELECT content FROM memories WHERE influencer_id = $1 AND kind = 'calendar_recap' AND status = 'active' ORDER BY updated_at DESC LIMIT 5", [influencerId()]),
    ]);
    const kindOpts = EVENT_KINDS.map((k) => [k, k] as [string, string]);
    const useOpts: Array<[string, string]> = [
      ["both", "Posts & conversations"],
      ["content", "Posts only"],
      ["conversation", "Conversations only"],
      ["context", "Background context"],
    ];
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    const body = `${header("Calendar", {
      sub: `Current affairs and life events for ${esc(inf.name)}. Upcoming events give the agent something to post and talk about; once something has happened, write what happened and it becomes a memory.`,
      actions: `<button type="button" class="btn primary" id="cal-new">${icon("plus", 16)}<span>Add event</span></button>`,
    })}
<div class="grid-2">
${card(`<div id="cal" style="min-height:640px" aria-label="Calendar"></div><noscript><p class="muted">The interactive calendar needs JavaScript; use the quick-add form.</p></noscript>`, { cls: "cal-card" })}
<div>
${card(
  needOutcome.length
    ? `<ul class="list">${needOutcome
        .map(
          (e) =>
            `<li><div style="flex:1"><b>${esc(e.title)}</b><div class="meta">${new Date(e.starts_at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz })}${e.influencer_id === null ? " · shared" : ""}</div>
            <form method="post" action="/admin/calendar/${e.id}/outcome" style="margin-top:8px">${textarea("outcome", "", { rows: 2, attrs: `aria-label="What happened at ${esc(e.title)}" placeholder="What happened? (becomes a memory)"` })}<div style="margin-top:6px">${button("Save", { small: true })}</div></form></div></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">${icon("check", 16)} Nothing waiting. Past events with an outcome are remembered.</p>`,
  { title: "What happened?" },
)}
${card(
  upcoming.length
    ? `<ul class="list">${upcoming
        .slice(0, 8)
        .map(
          (e) =>
            `<li><span style="width:10px;height:10px;border-radius:50%;margin-top:6px;flex:none;background:${KIND_COLOR[e.kind]}"></span><div><b>${esc(e.title)}</b><div class="meta">${new Date(e.starts_at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz })} · ${esc(e.kind)} · ${esc(e.use_for)}${e.importance === 3 ? " · major" : ""}</div></div></li>`,
        )
        .join("")}</ul>`
    : empty("Nothing coming up", "Add holidays, launches, matches, concerts, trips…"),
  { title: "Coming up (3 weeks)" },
)}
${memories.length ? card(`<ul class="list">${memories.map((m) => `<li>${icon("brain", 16)}<span class="small">${esc(m.content)}</span></li>`).join("")}</ul>`, { title: "Remembered" }) : ""}
${card(
  `<form method="post" action="/admin/calendar/add">${field("Title", input("title", "", { attrs: "required maxlength=160" }), { required: true })}
   <div class="cols">${field("Date", input("starts_at", today, { type: "date", attrs: "required" }))}${field("Kind", select("kind", kindOpts, "world"))}</div>
   <input type="hidden" name="all_day" value="true">${button("Quick add", { small: true, icon: "plus" })}</form>`,
  { title: "Quick add" },
)}
</div></div>

<dialog id="ev-dlg" aria-labelledby="ev-h"><form id="ev-form" method="dialog">
  <div class="dh" id="ev-h">Event</div>
  <div class="dialog-b">
    ${field("Title", input("title", "", { attrs: 'required maxlength="160"' }), { required: true, id: "ev-title" })}
    <div class="cols">
      ${field("Starts", input("start", "", { type: "datetime-local" }), { id: "ev-start" })}
      ${field("Ends (optional)", input("end", "", { type: "datetime-local" }), { id: "ev-end" })}
    </div>
    <label class="row small" style="margin:-4px 0 12px"><input type="checkbox" name="all_day" id="ev-allday"> All day</label>
    <div class="cols">
      ${field("Kind", select("kind", kindOpts, "world"), { id: "ev-kind" })}
      ${field("Importance", select("importance", [["1", "Minor"], ["2", "Normal"], ["3", "Major"]], "2"), { id: "ev-imp" })}
      ${field("Use for", select("use_for", useOpts, "both"), { id: "ev-use" })}
    </div>
    ${field("Location", input("location", "", { placeholder: "e.g. Kololo Airstrip" }), { id: "ev-loc" })}
    ${field("Details", textarea("description", "", { rows: 2 }), { id: "ev-desc", help: "Facts the agent may use. It never invents details beyond this." })}
    ${field("What happened (after the fact)", textarea("outcome", "", { rows: 2 }), { id: "ev-out", help: "Once the event has ended, this is written into the influencer's memory." })}
    <label class="row small"><input type="checkbox" name="shared" id="ev-shared"> Shared world event (every influencer knows about it)</label>
    <p class="help" id="ev-msg" role="status"></p>
  </div>
  <div class="dialog-f"><button type="button" class="btn danger" id="ev-del" hidden>${icon("trash", 16)}<span>Delete</span></button><span class="right"></span><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" id="ev-save" value="save">${icon("check", 16)}<span>Save</span></button></div>
</form></dialog>`;

    const head = `<link rel="stylesheet" href="${FC}/skeleton.css"><link rel="stylesheet" href="${FC}/themes/classic/theme.css"><link rel="stylesheet" href="${FC}/themes/classic/palette.css">
<style>
#cal{--fc-border-color:var(--line);--fc-page-bg-color:var(--surface);--fc-neutral-bg-color:var(--surface-2);--fc-today-bg-color:var(--brand-soft);font-size:14px}
#cal .fc-button,#cal button{font:inherit;font-size:13px}
#cal a{color:inherit;text-decoration:none}
.cal-card .card-b{padding:12px}
</style>`;
    const scripts = `<script src="${FC}/all/global.js"></script><script src="${FC}/themes/classic/global.js"></script>
<script>
(function(){
  var el=document.getElementById("cal"),dlg=document.getElementById("ev-dlg"),form=document.getElementById("ev-form"),msg=document.getElementById("ev-msg"),del=document.getElementById("ev-del");
  var editing=null,cal=null;
  function pad(n){return String(n).padStart(2,"0")}
  function local(d){if(!d)return"";d=new Date(d);return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+"T"+pad(d.getHours())+":"+pad(d.getMinutes())}
  function val(id){return document.getElementById(id)}
  function open(data,id){editing=id||null;msg.textContent="";del.hidden=!id;
    val("ev-title").value=data.title||"";val("ev-start").value=local(data.starts_at);val("ev-end").value=local(data.ends_at);val("ev-allday").checked=data.all_day!==false;
    val("ev-kind").value=data.kind||"world";val("ev-imp").value=String(data.importance||2);val("ev-use").value=data.use_for||"both";val("ev-loc").value=data.location||"";
    val("ev-desc").value=data.description||"";val("ev-out").value=data.outcome||"";val("ev-shared").checked=!!data.shared;
    document.getElementById("ev-h").textContent=id?"Edit event":"New event";dlg.showModal();val("ev-title").focus()}
  function payload(){var s=val("ev-start").value,e=val("ev-end").value,ad=val("ev-allday").checked;
    return {title:val("ev-title").value,starts_at:s?new Date(s).toISOString():new Date().toISOString(),ends_at:e?new Date(e).toISOString():null,all_day:ad,kind:val("ev-kind").value,importance:Number(val("ev-imp").value),
      use_for:val("ev-use").value,location:val("ev-loc").value,description:val("ev-desc").value,outcome:val("ev-out").value,shared:val("ev-shared").checked}}
  function send(url,body){return fetch(url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify(body||{})}).then(function(r){return r.json()})}
  form.addEventListener("submit",function(ev){var sub=ev.submitter;if(!sub||sub.value!=="save")return;ev.preventDefault();
    send(editing?"/admin/api/calendar/"+editing:"/admin/api/calendar",payload()).then(function(j){if(!j.ok){msg.textContent=j.message;msg.className="help bad";return}
      window.aiaToast&&aiaToast(j.message);dlg.close();cal?cal.refetchEvents():location.reload()})});
  del.onclick=function(){if(!editing||!confirm("Delete this event?"))return;send("/admin/api/calendar/"+editing+"/delete").then(function(j){window.aiaToast&&aiaToast(j.message,j.ok?"":"bad");dlg.close();cal?cal.refetchEvents():location.reload()})};
  document.getElementById("cal-new").onclick=function(){var d=new Date();d.setHours(10,0,0,0);open({starts_at:d,all_day:true})};
  if(!window.FullCalendar){el.innerHTML='<p class="muted">Calendar library unavailable (offline?). Use quick add.</p>';return}
  var mobile=window.matchMedia("(max-width: 640px)").matches;
  cal=new FullCalendar.Calendar(el,{
    initialView:mobile?"listMonth":"dayGridMonth",
    headerToolbar:{start:"prev,next today",center:"title",end:mobile?"listMonth,dayGridMonth":"dayGridMonth,timeGridWeek,listMonth"},
    height:"auto",firstDay:1,nowIndicator:true,editable:true,selectable:true,dayMaxEvents:3,
    events:"/admin/api/calendar",
    select:function(info){open({starts_at:info.start,ends_at:info.allDay?null:info.end,all_day:info.allDay});cal.unselect()},
    eventClick:function(info){info.jsEvent&&info.jsEvent.preventDefault();open(info.event.extendedProps.raw,info.event.id)},
    eventDrop:function(info){var e=info.event;send("/admin/api/calendar/"+e.id,{starts_at:e.start.toISOString(),ends_at:e.end?e.end.toISOString():null,all_day:e.allDay}).then(function(j){if(!j.ok){info.revert();aiaToast(j.message,"bad")}else aiaToast("Moved")})},
    eventResize:function(info){var e=info.event;send("/admin/api/calendar/"+e.id,{ends_at:e.end?e.end.toISOString():null}).then(function(j){if(!j.ok){info.revert();aiaToast(j.message,"bad")}})}
  });
  cal.render();
})();
</script>`;
    return render(req, reply, { title: "Calendar", active: "calendar", body, head, scripts });
  });
}
