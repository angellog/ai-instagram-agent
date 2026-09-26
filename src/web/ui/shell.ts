import { VERSION } from "../../version.js";
import { avatar, esc, icon, pill } from "./kit.js";
import { CSS } from "./styles.js";

export interface ShellInfluencer {
  id: number;
  name: string;
  slug: string;
  status: string;
  avatar_url: string | null;
  username?: string | null;
}

export interface ShellContext {
  title: string;
  active: string;
  body: string;
  flash?: string;
  flashTone?: "ok" | "bad";
  current?: ShellInfluencer;
  influencers: ShellInfluencer[];
  mode?: string;
  paused?: boolean;
  pendingReviews?: number;
  openAccess?: boolean;
  head?: string;
  scripts?: string;
}

type NavItem = [key: string, href: string, label: string, icon: string];
const NAV: Array<[section: string, items: NavItem[]]> = [
  [
    "Operate",
    [
      ["overview", "/admin", "Overview", "dashboard"],
      ["create", "/admin/create", "Create a post", "zap"],
      ["reviews", "/admin/reviews", "Reviews", "inbox"],
      ["calendar", "/admin/calendar", "Calendar", "calendar"],
      ["trends", "/admin/trends", "Trends & news", "activity"],
      ["posts", "/admin/posts", "Posts", "image"],
      ["content", "/admin/content", "Content brain", "brain"],
      ["conversations", "/admin/conversations", "Conversations", "message"],
      ["people", "/admin/people", "People & memory", "users"],
    ],
  ],
  [
    "Identity",
    [
      ["persona", "/admin/persona", "Persona & soul", "user"],
      ["profile", "/admin/profile", "Profile kit", "instagram"],
      ["controls", "/admin/controls", "Controls", "sliders"],
    ],
  ],
  [
    "Generation",
    [
      ["gen", "/admin/generation", "Engine", "cpu"],
      ["gen-policy", "/admin/generation/policy", "Routing policy", "route"],
      ["gen-requests", "/admin/generation/requests", "Jobs & failures", "list"],
      ["gen-assets", "/admin/generation/assets", "Assets", "images"],
      ["gen-bench", "/admin/generation/benchmarks", "Benchmarks", "gauge"],
    ],
  ],
  [
    "Platform",
    [
      ["influencers", "/admin/influencers", "Influencers", "egg"],
      ["config", "/admin/config", "Config & keys", "key"],
      ["costs", "/admin/costs", "Costs", "wallet"],
      ["events", "/admin/events", "Events & jobs", "activity"],
    ],
  ],
];

/** Runs before first paint so there is no light/dark flash. */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem("aia-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}})();`;

const APP_JS = String.raw`
(function(){
  var d=document,root=d.documentElement;
  function toast(msg,tone){var box=d.getElementById("toasts");if(!box||!msg)return;var t=d.createElement("div");t.className="toast "+(tone||"");t.setAttribute("role",tone==="bad"?"alert":"status");
    var s=d.createElement("span");s.textContent=msg;var b=d.createElement("button");b.setAttribute("aria-label","Dismiss");b.textContent="✕";b.onclick=function(){t.remove()};t.append(s,b);box.append(t);setTimeout(function(){t.remove()},tone==="bad"?9000:5000)}
  window.aiaToast=toast;
  // theme toggle: system → light → dark
  var tb=d.getElementById("theme");if(tb){tb.onclick=function(){var cur=root.dataset.theme||"system";var next=cur==="system"?"light":cur==="light"?"dark":"system";
    if(next==="system"){delete root.dataset.theme;try{localStorage.removeItem("aia-theme")}catch(e){}}else{root.dataset.theme=next;try{localStorage.setItem("aia-theme",next)}catch(e){}}
    tb.setAttribute("aria-label","Theme: "+next);toast("Theme: "+next)}}
  // mobile nav
  var mb=d.getElementById("menu");if(mb){mb.onclick=function(){d.body.classList.toggle("nav-open");mb.setAttribute("aria-expanded",d.body.classList.contains("nav-open"))}}
  var sc=d.querySelector(".scrim");if(sc){sc.onclick=function(){d.body.classList.remove("nav-open")}}
  d.addEventListener("keydown",function(e){if(e.key==="Escape")d.body.classList.remove("nav-open")});
  // flash → toast (and strip it from the URL so a refresh does not repeat it)
  var u=new URL(location.href);var f=u.searchParams.get("flash");if(f){toast(f,u.searchParams.get("tone")==="bad"||/^(not saved|error|failed|could not)/i.test(f)?"bad":"");u.searchParams.delete("flash");u.searchParams.delete("tone");history.replaceState(null,"",u.pathname+u.search+u.hash)}
  // confirm dialog for destructive forms
  var dlg=d.getElementById("confirm");
  d.addEventListener("submit",function(e){var f=e.target;if(!(f instanceof HTMLFormElement))return;
    if(f.dataset.confirm&&!f.dataset.confirmed){e.preventDefault();d.getElementById("confirm-msg").textContent=f.dataset.confirm;dlg.showModal();
      dlg.onclose=function(){if(dlg.returnValue==="yes"){f.dataset.confirmed="1";f.requestSubmit(e.submitter||undefined)}};return}
    var btn=e.submitter||f.querySelector("button[type=submit],button:not([type])");
    if(f.dataset.async!==undefined){e.preventDefault();if(btn){btn.disabled=true;btn.classList.add("busy")}
      fetch(f.action,{method:"POST",body:new URLSearchParams(new FormData(f)),headers:{accept:"application/json"}}).then(function(r){return r.json()}).then(function(j){toast(j.message||(j.ok?"Done":"Failed"),j.ok?"":"bad");
        var out=f.querySelector("[data-out]");if(out){out.textContent=j.message||"";out.className="help "+(j.ok?"ok":"bad")}if(j.reload)setTimeout(function(){location.reload()},700)})
      .catch(function(err){toast("Request failed: "+err.message,"bad")}).finally(function(){if(btn){btn.disabled=false;btn.classList.remove("busy")}});return}
    if(btn){setTimeout(function(){btn.disabled=true;btn.classList.add("busy")},0)}
  });
  // image upload → downscaled JPEG data URLs appended to a textarea (no multipart needed)
  d.querySelectorAll("input[type=file][data-upload]").forEach(function(inp){inp.addEventListener("change",function(){var ta=d.getElementById(inp.dataset.upload);var prev=d.getElementById(inp.dataset.upload+"-prev");
    Array.prototype.forEach.call(inp.files||[],function(file){var img=new Image();var url=URL.createObjectURL(file);img.onload=function(){var max=1600,s=Math.min(1,max/Math.max(img.width,img.height));var c=d.createElement("canvas");c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);
      c.getContext("2d").drawImage(img,0,0,c.width,c.height);var data=c.toDataURL("image/jpeg",0.88);ta.value=(ta.value.trim()?ta.value.trim()+"\n":"")+data;URL.revokeObjectURL(url);
      if(prev){var t=d.createElement("img");t.src=data;t.alt="";prev.append(t)}toast("Added "+file.name)};img.onerror=function(){toast("Could not read "+file.name,"bad")};img.src=url})})});
  // copy-to-clipboard buttons
  d.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-copy]");if(!b)return;var el=d.getElementById(b.dataset.copy);if(!el)return;
    navigator.clipboard.writeText(el.textContent).then(function(){toast("Copied")},function(){toast("Copy failed: select and copy manually","bad")})});
  // reveal/hide for secret inputs
  d.querySelectorAll("[data-reveal]").forEach(function(b){b.onclick=function(){var i=d.getElementById(b.dataset.reveal);if(!i)return;i.type=i.type==="password"?"text":"password";b.setAttribute("aria-pressed",i.type==="text")}});
})();`;

export function shell(o: ShellContext): string {
  const nav = NAV.map(
    ([section, items]) =>
      `<h3>${esc(section)}</h3>${items
        .map(([key, href, label, ic]) => {
          const on = o.active === key || (key !== "overview" && o.active.startsWith(`${key}:`));
          const badge = key === "reviews" && o.pendingReviews ? `<span class="badge" aria-label="${o.pendingReviews} pending">${o.pendingReviews}</span>` : "";
          return `<a href="${href}"${on ? ' aria-current="page"' : ""}>${icon(ic)}<span>${esc(label)}</span>${badge}</a>`;
        })
        .join("")}`,
  ).join("");

  const cur = o.current;
  const switcher = `<details class="switch"><summary aria-label="Switch influencer">${cur ? avatar(cur.avatar_url, cur.name, 34) : avatar(null, "?", 34)}<span class="who"><b>${esc(cur?.name ?? "No influencer")}</b><small>${
    cur ? esc(cur.username ? `@${cur.username}` : cur.status) : "hatch one to begin"
  }</small></span>${icon("chevron", 16)}</summary><div class="menu" role="menu">${o.influencers
    .map(
      (i) =>
        `<form method="post" action="/admin/switch"><input type="hidden" name="id" value="${i.id}"><button role="menuitem"${
          cur?.id === i.id ? ' aria-current="true"' : ""
        }>${avatar(i.avatar_url, i.name, 28)}<span class="who"><b>${esc(i.name)}</b><br><small class="muted">${esc(i.username ? `@${i.username}` : i.slug)} · ${esc(i.status)}</small></span>${
          cur?.id === i.id ? icon("check", 16) : ""
        }</button></form>`,
    )
    .join("")}<div class="sep"></div><a href="/admin/hatch" role="menuitem">${icon("egg", 18)}<span>Hatch a new influencer</span></a></div></details>`;

  const banners = [
    o.openAccess ? `<div class="banner">${icon("alert", 16)}<span>Development mode: the console has no password. Set ADMIN_TOKEN before exposing it.</span></div>` : "",
    o.paused && cur ? `<div class="banner bad">${icon("pause", 16)}<span><b>${esc(cur.name)} is paused.</b> Nothing is planned, sent or published for this influencer.</span></div>` : "",
  ].join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} · ${esc(cur?.name ?? "Influencer OS")}</title>
<script>${THEME_BOOT}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&family=Fira+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>${o.head ?? ""}</head>
<body><a class="skip" href="#main">Skip to content</a>
<div class="app">
<aside class="side" aria-label="Main navigation">
  <div class="brand"><span class="mark">${icon("sparkles", 16)}</span><span>Influencer OS</span></div>
  ${switcher}
  <nav class="nav">${nav}</nav>
  <div class="side-foot"><span>v${VERSION}</span><span class="right"></span><a class="iconbtn" href="/admin/logout" aria-label="Sign out" title="Sign out">${icon("logout", 16)}</a></div>
</aside>
<div class="scrim" aria-hidden="true"></div>
<div class="col">
  <header class="top">
    <button class="iconbtn menu-btn" id="menu" aria-label="Open navigation" aria-expanded="false">${icon("menu")}</button>
    <span class="crumb">${esc(cur?.name ?? "")}${cur ? " / " : ""}${esc(o.title)}</span>
    <span class="grow"></span>
    ${o.mode ? pill(o.mode) : ""}
    ${
      cur
        ? `<form method="post" action="/admin/controls/pause" class="inline"><input type="hidden" name="paused" value="${o.paused ? "false" : "true"}"><button class="btn sm ${o.paused ? "primary" : ""}" title="${
            o.paused ? "Resume this influencer" : "Pause this influencer"
          }">${icon(o.paused ? "play" : "pause", 14)}<span>${o.paused ? "Resume" : "Pause"}</span></button></form>`
        : ""
    }
    <button class="iconbtn" id="theme" aria-label="Toggle theme" title="Theme">${icon("sun", 18)}</button>
  </header>
  ${banners}
  <main id="main" tabindex="-1">${o.body}</main>
</div></div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<dialog id="confirm"><form method="dialog"><div class="dh">Are you sure?</div><div class="dialog-b"><p id="confirm-msg"></p></div>
<div class="dialog-f"><button class="btn" value="no">Cancel</button><button class="btn danger" value="yes" autofocus>Yes, continue</button></div></form></dialog>
<script>${APP_JS}</script>${o.scripts ?? ""}
</body></html>`;
}
