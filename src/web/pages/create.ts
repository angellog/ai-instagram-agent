import type { FastifyInstance } from "fastify";
import { cleanDirection, createProgress, DIRECTION_MAX, recentRuns, startCreate, STAGES } from "../../content/create.js";
import { operatorGate } from "../../content/director.js";
import { getControls } from "../../config/controls.js";
import { currentInfluencer } from "../../context.js";
import { persona } from "../../persona/loader.js";
import { primaryAccount } from "../../instagram/accounts.js";
import { consoleRouter, done, isUuid, render, reviewer, type Req } from "../console.js";
import { ago, card, esc, header, icon, link, pill, table } from "../ui/kit.js";

const keep = (direction?: string | null) => (direction ? `<input type="hidden" name="direction" value="${esc(direction)}">` : "");

/** The one-tap button used on Overview, Posts and after launching a new influencer. */
export function createButton(label = "Create a post now", small = false, direction?: string | null): string {
  return `<form class="inline" method="post" action="/admin/create">${keep(direction)}<button class="btn primary${small ? " sm" : ""}" type="submit">${icon("zap", 16)}<span>${esc(label)}</span></button></form>`;
}

/** One tap: plan and make a story right now (held for review). */
export function storyButton(label = "Create a story now", primary = false, direction?: string | null): string {
  return `<form class="inline" method="post" action="/admin/create"><input type="hidden" name="kind" value="story">${keep(direction)}<button class="btn${primary ? " primary" : ""}" type="submit">${icon("sparkles", 16)}<span>${esc(label)}</span></button></form>`;
}

/** Link to the Create page's direction box, shown next to the one-tap buttons. */
export function directLink(kind: "post" | "story" = "post"): string {
  return `<a class="btn ghost" href="/admin/create${kind === "story" ? "?kind=story" : ""}#direct" title="Tell the director what this ${kind} should be about">${icon("pencil", 16)}<span>Direct it</span></a>`;
}

/** Direction ideas from THIS influencer's own life and brand moments (never another influencer's). */
function examples(): string[] {
  const p = persona();
  const pool = [...(p.brand?.natural_moments ?? []), ...p.weekend_ideas, ...p.daily_life.activities.filter((a) => a.postable).map((a) => a.activity)];
  return [...new Set(pool.map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length > 3 && x.length <= 60))].slice(0, 5);
}

/** The direction box: a few words, then Create a post or Create a story. */
function directForm(kind: "post" | "story", value = ""): string {
  return `<section class="card" id="direct" aria-labelledby="direct-h"><div class="card-b">
<form method="post" action="/admin/create" class="direct-form">
  <div class="field"><label id="direct-h" for="direction">Direction <span class="meta">(optional)</span></label>
    <textarea id="direction" name="direction" maxlength="${DIRECTION_MAX}" rows="2" placeholder="A few words: a product, place, occasion or mood" aria-describedby="direction-help">${esc(value)}</textarea>
    <p class="help" id="direction-help">The director builds the idea around these words. Leave it empty to let ${esc(currentInfluencer().name)} pick. They still stay in character, keeps to the safety rules, and only states business facts from the knowledge base. <span class="counter" data-count-for="direction">0/${DIRECTION_MAX}</span></p>
  </div>
  <div class="chips" role="group" aria-label="Examples">${examples().map((e) => `<button type="button" class="chip" data-fill="${esc(e)}">${esc(e)}</button>`).join("")}</div>
  <div class="row" style="margin-top:14px">
    <button class="btn${kind === "post" ? " primary" : ""}" type="submit" name="kind" value="post">${icon("zap", 16)}<span>Create a post</span></button>
    <button class="btn${kind === "story" ? " primary" : ""}" type="submit" name="kind" value="story">${icon("sparkles", 16)}<span>Create a story</span></button>
  </div>
</form></div></section>
<script>(function(){var t=document.getElementById("direction"),c=document.querySelector("[data-count-for=direction]");if(!t)return;
function n(){c.textContent=t.value.length+"/${DIRECTION_MAX}"}t.addEventListener("input",n);n();
document.querySelectorAll(".direct-form [data-fill]").forEach(function(b){b.onclick=function(){t.value=t.value.trim()?t.value.trim().replace(/[,;]?$/,", ")+b.dataset.fill:b.dataset.fill;t.value=t.value.slice(0,${DIRECTION_MAX});n();t.focus()}});
if(location.hash==="#direct")t.focus()})();</script>`;
}

const CSS = `<style>
.cr-card{padding:24px}
.cr-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px}
.cr-pct{font-size:34px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.cr-time{color:var(--muted);font-variant-numeric:tabular-nums}
.cr-bar{position:relative;height:14px;border-radius:99px;background:var(--surface-3);overflow:hidden}
.cr-fill{position:absolute;inset:0 auto 0 0;width:0;border-radius:99px;background:linear-gradient(90deg,var(--brand),#ff9a5c);transition:width .7s cubic-bezier(.2,.8,.2,1)}
.cr-fill::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(-45deg,rgb(255 255 255/.22) 0 10px,transparent 10px 20px);background-size:28px 28px;animation:cr-stripes 900ms linear infinite}
.cr-fill::before{content:"";position:absolute;right:-6px;top:50%;width:14px;height:14px;margin-top:-7px;border-radius:50%;background:#fff;box-shadow:0 0 0 4px rgb(255 90 31/.35),0 0 18px 6px rgb(255 120 60/.55);animation:cr-glow 1.4s ease-in-out infinite}
.cr-done .cr-fill::after,.cr-done .cr-fill::before,.cr-failed .cr-fill::after,.cr-failed .cr-fill::before{animation:none;opacity:0}
.cr-failed .cr-fill{background:var(--bad)}
@keyframes cr-stripes{to{background-position:28px 0}}
@keyframes cr-glow{0%,100%{transform:scale(.85);opacity:.8}50%{transform:scale(1.1);opacity:1}}
.cr-steps{list-style:none;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:0;margin:22px 0 6px}
.cr-steps li{display:grid;justify-items:center;text-align:center;gap:8px;font-size:13px;color:var(--muted);position:relative}
.cr-steps li:not(:last-child)::after{content:"";position:absolute;top:17px;left:calc(50% + 22px);right:calc(-50% + 22px);height:2px;background:var(--line);transition:background .4s}
.cr-steps li.done:not(:last-child)::after{background:var(--ok)}
.cr-dot{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--surface-2);border:2px solid var(--line-2);color:var(--muted);transition:background .3s,border-color .3s,transform .3s}
.cr-steps .active{color:var(--ink);font-weight:600}.cr-steps .active .cr-dot{border-color:var(--brand);color:var(--brand);position:relative}
.cr-steps .active .cr-dot::after{content:"";position:absolute;inset:-6px;border-radius:50%;border:2px solid transparent;border-top-color:var(--brand);animation:cr-spin .9s linear infinite}
.cr-steps .done .cr-dot{background:var(--ok);border-color:var(--ok);color:#fff;animation:cr-pop .35s cubic-bezier(.2,.8,.2,1.4)}
.cr-steps .failed .cr-dot{background:var(--bad);border-color:var(--bad);color:#fff}
@keyframes cr-spin{to{transform:rotate(360deg)}}
@keyframes cr-pop{0%{transform:scale(.6)}100%{transform:scale(1)}}
.cr-detail{min-height:22px;margin:10px 0 0;color:var(--ink-2)}
.cr-shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:18px}
.cr-story .cr-shots{grid-template-columns:repeat(auto-fill,minmax(160px,220px))}.cr-story .cr-shot{aspect-ratio:9/16}
.cr-shot{aspect-ratio:4/5;border-radius:12px;overflow:hidden;background:var(--surface-2);position:relative;border:1px solid var(--line)}
.cr-shot.wait::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgb(255 255 255/.18) 50%,transparent 70%);background-size:220% 100%;animation:cr-shimmer 1.3s ease-in-out infinite}
.cr-shot img{width:100%;height:100%;object-fit:cover;display:block;animation:cr-in .5s ease-out}
@keyframes cr-shimmer{from{background-position:120% 0}to{background-position:-120% 0}}
@keyframes cr-in{from{opacity:0;transform:scale(1.03)}to{opacity:1;transform:none}}
.cr-dir{display:flex;gap:8px;align-items:flex-start;margin:0 0 14px;padding:8px 12px;border-radius:10px;background:var(--surface-2);font-size:14px;color:var(--ink-2)}.cr-dir svg{color:var(--muted);margin-top:2px}
.cr-final{display:none;margin-top:18px}.cr-done .cr-final,.cr-failed .cr-final{display:block}
@media (max-width:640px){.cr-steps li{font-size:11.5px}.cr-pct{font-size:28px}}
@media (prefers-reduced-motion:reduce){.cr-fill,.cr-dot{transition:none}.cr-fill::after,.cr-fill::before,.cr-steps .active .cr-dot::after,.cr-shot.wait::after{animation:none}}
</style>`;

export function registerCreate(app: FastifyInstance): void {
  const r = consoleRouter(app);

  r.post("/admin/create", async (req: Req, reply) => {
    const kind = req.body?.kind === "story" ? "story" : "post";
    const c = await getControls();
    const block = operatorGate(c) ?? (kind === "story" && !c.stories_enabled ? "stories are turned off in Controls" : undefined);
    if (block) return done(req, reply, kind === "story" ? "/admin/stories" : "/admin", `Can't create a ${kind}: ${block}`, false);
    const run = await startCreate(reviewer(req), kind, cleanDirection(req.body?.direction));
    if (String(req.headers.accept ?? "").includes("application/json")) return reply.send({ ok: true, id: run.id, existing: run.existing, kind });
    return reply.redirect(`/admin/create/${run.id}${run.existing ? `?flash=${encodeURIComponent(`A ${kind} is already being created: here it is`)}` : ""}`, 303);
  });

  r.get("/admin/api/create/:id", async (req: Req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ ok: false });
    const p = await createProgress(req.params.id);
    return p ? reply.send(p) : reply.code(404).send({ ok: false });
  });

  r.get("/admin/create", async (req: Req, reply) => {
    const runs = await recentRuns(10);
    const q = req.query as Record<string, string | undefined>;
    const kind = q.kind === "story" ? "story" : "post";
    const body = `${header("Create a post now", { sub: "One tap runs the whole pipeline for this influencer (idea → photos → quality and safety checks) and stops so you can look before it goes out. Add a direction to steer what it's about." })}
${directForm(kind, cleanDirection(q.direction) ?? "")}
${card(
  table(
    ["When", "Kind", "Direction", "Status", "Result", ""],
    runs.map((x) => [ago(x.created_at), esc(x.kind ?? "post"), x.direction ? esc(x.direction) : `<span class="muted">—</span>`, pill(x.status === "done" ? "done" : x.status), esc(x.outcome ?? x.stage), `<a href="/admin/create/${x.id}">Open</a>`]),
    "No runs yet.",
  ),
  { title: "Recent runs" },
)}`;
    return render(req, reply, { title: "Create", active: "create", body });
  });

  r.get("/admin/create/:id", async (req: Req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send("not found");
    const p = await createProgress(req.params.id);
    if (!p) return reply.code(404).send("not found");
    const inf = currentInfluencer();
    const acct = await primaryAccount();
    const story = p.kind === "story";
    const noun = story ? "story" : "post";
    const again = story ? storyButton("Make another") : createButton("Make another", false).replace("btn primary", "btn");
    const retry = story ? storyButton("Try again", true, p.direction) : createButton("Try again", false, p.direction);
    const edit = link("Change direction", `/admin/create?${new URLSearchParams({ ...(story ? { kind: "story" } : {}), direction: p.direction ?? "" }).toString()}#direct`, { variant: "ghost", icon: "pencil" });
    const body = `${header(`Creating a ${noun} for ${inf.name}`, { eyebrow: story ? "Create a story now" : "Create a post now", actions: link("All runs", "/admin/create", { variant: "ghost", small: true }) })}
<section class="card cr-card${story ? " cr-story" : ""}" id="cr" data-id="${esc(p.id)}" data-noun="${noun}" aria-busy="true">
  <div class="cr-top"><div><div class="cr-pct" id="cr-pct">0%</div><div class="meta" id="cr-topic">${esc(p.topic ?? "Thinking of an idea…")}</div></div><div class="cr-time" id="cr-time">0:00</div></div>
  ${p.direction ? `<p class="cr-dir">${icon("pencil", 16)}<span><b>Your direction:</b> ${esc(p.direction)}</span></p>` : ""}
  <div class="cr-bar" role="progressbar" aria-label="Post creation progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="cr-bar"><div class="cr-fill" id="cr-fill"></div></div>
  <ol class="cr-steps" id="cr-steps">${STAGES.map((s) => `<li data-key="${s.key}"><span class="cr-dot">${icon("check", 16)}</span><span>${esc(s.label)}</span></li>`).join("")}</ol>
  <p class="cr-detail" id="cr-detail" aria-live="polite">${esc(p.detail)}</p>
  <div class="cr-shots" id="cr-shots"></div>
  <div class="cr-final" id="cr-final">
    <div id="cr-ok" hidden>
      <div class="callout ok">${icon("check")}<p>Your ${noun} is ready. Nothing has been published yet.${story ? " Stories go up without a caption; their words are on the image." : ""}</p></div>
      <pre id="cr-caption" style="margin-bottom:12px"${story ? " hidden" : ""}></pre>
      <div class="row">
        <form method="post" id="cr-postnow" data-dynamic data-confirm="Publish this ${noun} to ${esc(acct ? `@${acct.username ?? acct.ig_user_id}` : "Instagram")} right now?"><button class="btn primary" type="submit">${icon("send", 16)}<span>Post now</span></button></form>
        <a class="btn" id="cr-schedule">${icon("calendar", 16)}<span>Schedule…</span></a>
        <a class="btn ghost" id="cr-open">${icon("image", 16)}<span>Open & edit ${noun}</span></a>
        ${again}
      </div>
    </div>
    <div id="cr-bad" hidden>
      <div class="callout bad">${icon("alert")}<p id="cr-bad-msg" style="white-space:pre-line"></p></div>
      <div class="row">${retry}${edit}<a class="btn ghost" id="cr-open-bad" hidden>${icon("image", 16)}<span>Open ${noun}</span></a></div>
    </div>
  </div>
</section>`;
    const scripts = `<script>
(function(){
  var root=document.getElementById("cr"),id=root.dataset.id,fill=document.getElementById("cr-fill"),bar=document.getElementById("cr-bar"),pct=document.getElementById("cr-pct"),
      time=document.getElementById("cr-time"),detail=document.getElementById("cr-detail"),shots=document.getElementById("cr-shots"),topic=document.getElementById("cr-topic");
  var shown=0,last=null,stopped=false,t0=Date.now(),base=0;
  function fmt(ms){var s=Math.floor(ms/1000);return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")}
  setInterval(function(){if(!stopped&&last)time.textContent=fmt(base+(Date.now()-t0))},500);
  function animatePct(to){var from=shown,start=performance.now();(function step(n){var k=Math.min(1,(n-start)/600);shown=from+(to-from)*(1-Math.pow(1-k,3));pct.textContent=Math.round(shown)+"%";if(k<1)requestAnimationFrame(step)})(start)}
  function render(p){
    last=p;base=p.elapsedMs;t0=Date.now();
    fill.style.width=p.pct+"%";bar.setAttribute("aria-valuenow",Math.round(p.pct));animatePct(p.pct);
    if(p.topic)topic.textContent=p.topic;
    detail.textContent=p.detail;
    document.querySelectorAll("#cr-steps li").forEach(function(li){var s=p.steps.find(function(x){return x.key===li.dataset.key});li.className=s?s.state:"";
      li.querySelector(".cr-dot").innerHTML=s&&s.state==="failed"?'${icon("x", 16).replace(/'/g, "\\'")}':'${icon("check", 16).replace(/'/g, "\\'")}'});
    var total=Math.max(p.slides.total,p.slides.urls.length);
    while(shots.children.length<total){var d=document.createElement("div");d.className="cr-shot wait";shots.append(d)}
    p.slides.urls.forEach(function(u,i){var el=shots.children[i];if(el&&!el.querySelector("img")){el.classList.remove("wait");var im=new Image();im.src=u;im.alt="Photo "+(i+1);el.append(im)}});
    if(p.status==="done"||p.status==="failed"){
      stopped=true;time.textContent=fmt(p.elapsedMs);root.setAttribute("aria-busy","false");root.classList.add(p.status==="done"?"cr-done":"cr-failed");
      if(p.status==="done"){document.getElementById("cr-ok").hidden=false;document.getElementById("cr-caption").textContent=p.caption||"";
        document.getElementById("cr-postnow").action="/admin/posts/"+p.postId+"/post-now";document.getElementById("cr-schedule").href="/admin/posts/"+p.postId+"#publish";document.getElementById("cr-open").href="/admin/posts/"+p.postId;
        window.aiaToast&&aiaToast((root.dataset.noun==="story"?"Story":"Post")+" ready for review")}
      else{document.getElementById("cr-bad").hidden=false;document.getElementById("cr-bad-msg").textContent=p.message||p.detail;if(p.postId){var o=document.getElementById("cr-open-bad");o.hidden=false;o.href="/admin/posts/"+p.postId}}
      return true}
    return false}
  function poll(){fetch("/admin/api/create/"+id,{headers:{accept:"application/json"}}).then(function(r){return r.json()}).then(function(p){if(!render(p))setTimeout(poll,1500)}).catch(function(){setTimeout(poll,4000)})}
  poll();
})();
</script>`;
    return render(req, reply, { title: `Creating a ${noun}`, active: "create:run", body, head: CSS, scripts });
  });
}
