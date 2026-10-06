import type { FastifyInstance } from "fastify";
import { zonedToUtc } from "../../content/schedule.js";
import { currentInfluencer } from "../../context.js";
import { errorMessage } from "../../lib/errors.js";
import { archiveLibraryItem, getLibraryItem, LIBRARY_LIMITS, listLibrary, mediaTypeFor, planLibraryPost, saveLibraryItem, type LibraryItem, type Upload } from "../../library/library.js";
import { persona } from "../../persona/loader.js";
import { consoleRouter, done, render, reviewer, type Req } from "../console.js";
import { action, button, card, empty, esc, field, header, icon, input, pill } from "../ui/kit.js";

/**
 * Library: where a business uploads the photos and videos it wants its
 * influencer to post. Pick a time, or let the influencer choose the moment.
 * Captions are always written in the influencer's own voice from the notes.
 */

const CSS = `<style>
.lib-up{display:grid;gap:4px 20px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.lib-drop{display:grid;place-items:center;gap:6px;text-align:center;padding:28px 16px;border:2px dashed var(--line-2);border-radius:16px;color:var(--muted);cursor:pointer;transition:border-color var(--t-fast),background var(--t-fast)}
.lib-drop:hover,.lib-drop.over{border-color:var(--brand);background:var(--brand-soft);color:var(--ink)}
.lib-drop input{position:absolute;opacity:0;width:1px;height:1px}
.lib-files{font-size:13px;color:var(--ink-2)}
.lib-when{display:flex;flex-wrap:wrap;gap:8px}
.lib-when label{display:flex;gap:8px;align-items:center;padding:10px 14px;border:1px solid var(--line-2);border-radius:12px;cursor:pointer;font-weight:500}
.lib-when input{width:18px;height:18px;min-height:0;accent-color:var(--primary)}
.lib-when label:has(input:checked){border-color:var(--brand);background:var(--brand-soft)}
.lib-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.lib-item{border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--surface);display:flex;flex-direction:column}
.lib-item .media{aspect-ratio:4/5;background:var(--surface-2);position:relative}
.lib-item .media img,.lib-item .media video{width:100%;height:100%;object-fit:cover;display:block}
.lib-item .media .count{position:absolute;top:8px;right:8px;background:rgb(0 0 0/.6);color:#fff;border-radius:99px;padding:2px 8px;font-size:12px;font-weight:600}
.lib-item .body{padding:12px 14px;display:grid;gap:6px;flex:1}
.lib-item .body b{font-size:15px}
.lib-item .actions{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 14px}
</style>`;

const STATUS: Record<LibraryItem["status"], string> = { ready: "waiting", planned: "in Reviews / scheduled", posted: "posted", failed: "needs a look", archived: "archived" };

function itemCard(i: LibraryItem, tz: string): string {
  const first = i.files[0];
  const media = i.kind === "video" ? `<video src="${esc(first.url)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(first.url)}" alt="" loading="lazy">`;
  const what = i.reel_material ? "reel material" : mediaTypeFor(i) === "REEL" ? "reel" : mediaTypeFor(i) === "STORY" ? "story" : mediaTypeFor(i) === "CAROUSEL" ? `carousel of ${i.files.length}` : "single photo";
  const when =
    i.mode === "scheduled" && i.scheduled_for
      ? `${icon("calendar", 14)} ${esc(new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(i.scheduled_for)))}`
      : i.reel_material
        ? `${icon("sparkles", 14)} cut into AI reels`
        : `${icon("sparkles", 14)} ${esc(currentInfluencer().name)} decides`;
  return `<article class="lib-item"><div class="media">${media}${i.files.length > 1 ? `<span class="count">${i.files.length}</span>` : ""}</div>
<div class="body"><b>${esc(i.title)}</b><span class="meta">${esc(what)}${i.files[0].duration_s ? ` · ${i.files[0].duration_s}s` : ""}</span><span class="meta">${when}</span>${
    i.notes ? `<span class="small" style="color:var(--ink-2)">${esc(i.notes.slice(0, 140))}${i.notes.length > 140 ? "…" : ""}</span>` : ""
  }<div class="row">${pill(i.status === "posted" ? "published" : i.status === "failed" ? "failed" : i.status === "planned" ? "awaiting_review" : "draft").replace(/>[^<]*</, `>${STATUS[i.status]}<`)}${i.last_error ? `<span class="small" style="color:var(--bad)">${esc(i.last_error)}</span>` : ""}</div></div>
<div class="actions">${i.post_id ? `<a class="btn sm" href="/admin/posts/${i.post_id}">${icon("image", 14)}<span>Open post</span></a>` : ""}${
    i.status === "ready" && !i.reel_material ? action(`/admin/library/${i.id}/plan`, "Post it next", { small: true, icon: "zap" }) : ""
  }${i.status !== "posted" ? action(`/admin/library/${i.id}/archive`, "Remove", { small: true, variant: "ghost", confirm: `Remove "${i.title}" from the library? Its post (if any) is not deleted.` }) : ""}</div></article>`;
}

function uploadForm(tz: string, name: string): string {
  return `<form method="post" action="/admin/library" enctype="multipart/form-data" id="lib-form">
<label class="lib-drop" id="lib-drop">${icon("upload", 28)}<b>Drop photos or one video here</b><span class="small">or tap to choose · photos up to ${LIBRARY_LIMITS.imageBytes / 1024 / 1024} MB, a video up to ${LIBRARY_LIMITS.videoBytes / 1024 / 1024} MB · up to ${LIBRARY_LIMITS.files} photos make a carousel</span>
<input type="file" name="files" id="lib-files" accept="image/*,video/*" multiple required></label>
<p class="lib-files" id="lib-list" aria-live="polite"></p>
<div class="lib-up">
  ${field("Title", input("title", "", { attrs: 'required maxlength="120"', placeholder: "e.g. New iPhone 16 cases just landed" }), { required: true, help: "What it is, in a few words." })}
  ${field("Format", `<select name="target"><option value="auto">Automatic (photos → post, video → reel)</option><option value="feed">Feed post</option><option value="story">Story (one photo)</option><option value="reel">Reel (video)</option></select>`)}
</div>
${field("Notes for the caption", `<textarea name="notes" maxlength="1500" rows="3" placeholder="What to say and what not to: the product, the offer if any, must-include words. ${esc(name)} writes the caption in their own voice and never invents prices or dates."></textarea>`)}
<div class="field"><label>When</label><div class="lib-when" role="radiogroup">
  <label><input type="radio" name="mode" value="ai" checked> Let ${esc(name)} decide</label>
  <label><input type="radio" name="mode" value="scheduled"> At a set time</label>
  <label><input type="radio" name="mode" value="material"> Reel material only</label>
</div><p class="help">Let ${esc(name)} decide: posted in a good moment within the next few days. Set time: the caption is written now and waits in Reviews, then goes out at that time. Reel material: screen recordings or b-roll that AI reels cut in; never posted on its own.</p></div>
<div class="field" id="lib-at" hidden><label for="at">Post at <span class="meta">(${esc(tz)})</span></label><input id="at" type="datetime-local" name="at" style="width:auto"></div>
<div class="row" style="margin-top:6px">${button("Add to library", { variant: "primary", icon: "upload" })}<span class="meta" id="lib-busy" hidden>Uploading and preparing… videos take a minute.</span></div>
</form>
<script>(function(){var f=document.getElementById("lib-files"),list=document.getElementById("lib-list"),drop=document.getElementById("lib-drop"),at=document.getElementById("lib-at"),form=document.getElementById("lib-form");
function show(){var n=[].map.call(f.files,function(x){return x.name+" ("+Math.round(x.size/1024/1024*10)/10+" MB)"});list.textContent=n.length?n.join(" · "):""}
f.addEventListener("change",show);["dragenter","dragover"].forEach(function(e){drop.addEventListener(e,function(ev){ev.preventDefault();drop.classList.add("over")})});
["dragleave","drop"].forEach(function(e){drop.addEventListener(e,function(){drop.classList.remove("over")})});
drop.addEventListener("drop",function(ev){ev.preventDefault();f.files=ev.dataTransfer.files;show()});
form.querySelectorAll("input[name=mode]").forEach(function(r){r.addEventListener("change",function(){at.hidden=form.mode.value!=="scheduled";document.getElementById("at").required=!at.hidden})});
form.addEventListener("submit",function(){document.getElementById("lib-busy").hidden=false})})();</script>`;
}

export function registerLibrary(app: FastifyInstance): void {
  const r = consoleRouter(app);

  r.get("/admin/library", async (req: Req, reply) => {
    const inf = currentInfluencer();
    const tz = persona().identity.timezone;
    const items = await listLibrary();
    const waiting = items.filter((i) => i.status === "ready" && !i.reel_material).length;
    const body = `${header("Library", {
      sub: `Photos and videos ${esc(inf.name)}'s business wants posted. Pick a time, or let ${esc(inf.name)} choose the moment; captions are always in ${esc(inf.name)}'s voice and pass the same checks and Reviews as everything else.`,
    })}
${card(uploadForm(tz, inf.name), { title: "Add to the library" })}
${card(items.length ? `<div class="lib-grid">${items.map((i) => itemCard(i, tz)).join("")}</div>` : empty("Nothing here yet", "Upload product photos, shop videos or screen recordings above."), {
  title: `In the library${waiting ? ` · ${waiting} waiting for ${inf.name}` : ""}`,
})}`;
    return render(req, reply, { title: "Library", active: "library", body, head: CSS });
  });

  r.post("/admin/library", async (req: Req, reply) => {
    const fields: Record<string, string> = {};
    const files: Upload[] = [];
    try {
      for await (const part of (req as unknown as { parts: () => AsyncIterable<{ type: "file" | "field"; fieldname: string; value?: unknown; filename?: string; mimetype?: string; toBuffer?: () => Promise<Buffer>; file?: { truncated: boolean } }> }).parts()) {
        if (part.type === "file") {
          if (!part.filename) continue;
          const bytes = await part.toBuffer!();
          if (part.file?.truncated) throw new Error(`${part.filename} is too large`);
          files.push({ bytes, mime: part.mimetype ?? "", filename: part.filename });
        } else fields[part.fieldname] = String(part.value ?? "");
      }
      const tz = persona().identity.timezone;
      const material = fields.mode === "material";
      const item = await saveLibraryItem({
        title: fields.title ?? "",
        notes: fields.notes,
        files,
        mode: fields.mode === "scheduled" ? "scheduled" : "ai",
        scheduledFor: fields.mode === "scheduled" && fields.at ? zonedToUtc(fields.at, tz) : undefined,
        target: (["auto", "feed", "story", "reel"].includes(fields.target ?? "") ? fields.target : "auto") as "auto",
        reelMaterial: material,
        by: reviewer(req),
      });
      const msg = item.reel_material
        ? `Added "${item.title}" as reel material`
        : item.mode === "scheduled"
          ? item.post_id
            ? `Added "${item.title}": caption written, waiting in Reviews for its time`
            : `Added "${item.title}"`
          : `Added "${item.title}": ${currentInfluencer().name} will post it when it fits`;
      return done(req, reply, "/admin/library", msg);
    } catch (e) {
      return done(req, reply, "/admin/library", `Not added: ${errorMessage(e).replace(/^\w*Error: /, "")}`, false);
    }
  });

  r.post("/admin/library/:id/plan", async (req: Req, reply) => {
    const item = await getLibraryItem(req.params.id);
    if (!item) return reply.code(404).send("not found");
    try {
      const { postId } = await planLibraryPost(item.id);
      return reply.redirect(`/admin/posts/${postId}?flash=${encodeURIComponent("Caption written in their voice: review and publish")}`, 303);
    } catch (e) {
      return done(req, reply, "/admin/library", `Couldn't plan it: ${errorMessage(e)}`, false);
    }
  });

  r.post("/admin/library/:id/archive", async (req: Req, reply) => {
    const ok = await archiveLibraryItem(req.params.id);
    return done(req, reply, "/admin/library", ok ? "Removed from the library" : "Can't remove a posted item", ok);
  });
}
