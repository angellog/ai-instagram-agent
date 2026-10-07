import type { FastifyInstance } from "fastify";
import { getControls } from "../../config/controls.js";
import { currentInfluencer, influencerId } from "../../context.js";
import { many } from "../../db/pool.js";
import { FORMAT_GUIDE, pickLines } from "../../engagement/shortform.js";
import { HASHTAG_WEEKLY_LIMIT, hashtagsThisWeek, listDrafts, markDraft, runScout, scoutCredentials, scoutLinks } from "../../engagement/scout.js";
import { errorMessage } from "../../lib/errors.js";
import { localParts } from "../../lib/time.js";
import { persona } from "../../persona/loader.js";
import { attempt, consoleRouter, done, isTenant, render, reviewer, type Req } from "../console.js";
import { ago, button, card, empty, esc, header, icon, link, pill, tabs } from "../ui/kit.js";

const CSS = `<style>
.eg-ideas{list-style:none;margin:0;padding:0;display:grid}
.eg-ideas li{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid var(--line)}
.eg-ideas li:first-child{border-top:0;padding-top:2px}
.eg-ideas .line{flex:1 1 260px;min-width:0}.eg-ideas .line small{display:block;color:var(--muted);font-size:12.5px;margin-top:2px}
.eg-ideas form{display:inline}
.eg-q{list-style:none;margin:0;padding:0;display:grid}
.eg-q li{display:grid;gap:10px;padding:16px 0;border-top:1px solid var(--line)}
.eg-q li:first-child{border-top:0;padding-top:2px}
.eg-src{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px;color:var(--muted)}
.eg-cap{margin:0;color:var(--ink-2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.eg-comment{width:100%;min-height:58px;font-size:15px}
.eg-act{display:flex;flex-wrap:wrap;gap:8px}.eg-act form{display:inline}
.eg-facts{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0 0 14px;padding:0;list-style:none;font-size:14px}
.eg-facts b{font-variant-numeric:tabular-nums}
</style>`;

const JS = `<script>
document.querySelectorAll("[data-copy-open]").forEach(function(b){b.addEventListener("click",function(){
  var li=b.closest("li"),t=li.querySelector("textarea").value,u=b.getAttribute("data-copy-open");
  var go=function(){window.open(u,"_blank","noopener");window.aiaToast&&aiaToast("Comment copied: paste it under the post")};
  if(navigator.clipboard){navigator.clipboard.writeText(t).then(go,go)}else{go()}
})});
</script>`;

/**
 * Engagement: short-form ideas that get replies (made through Create), the
 * engagement scout's queue of drafted comments for a person to post by hand,
 * and @mention replies. Apps can't like or comment on other accounts' posts,
 * so the queue is one tap: copy the comment and open the post.
 */
export function registerEngagement(app: FastifyInstance): void {
  const r = consoleRouter(app);

  r.get("/admin/engagement", async (req: Req, reply) => {
    const inf = currentInfluencer();
    const p = persona();
    const c = await getControls();
    const status = req.query?.status === "done" ? "done" : req.query?.status === "skipped" ? "skipped" : "new";
    const { day } = localParts(new Date(), p.identity.timezone);
    const e = p.engagement;
    const cred = await scoutCredentials();
    const [drafts, counts, mentions, budget] = await Promise.all([
      listDrafts(status),
      many<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM engagement_drafts WHERE influencer_id = $1 GROUP BY 1", [influencerId()]),
      many<{ id: number; sender_username: string | null; text: string; status: string; occurred_at: Date; reply: string | null; reply_status: string | null }>(
        `SELECT i.id, i.sender_username, i.text, i.status, i.occurred_at, m.text AS reply, m.status AS reply_status
         FROM interactions i LEFT JOIN messages m ON m.interaction_id = i.id AND m.direction = 'out'
         WHERE i.influencer_id = $1 AND i.kind = 'mention' ORDER BY i.occurred_at DESC LIMIT 8`,
        [influencerId()],
      ),
      "missing" in cred ? Promise.resolve(undefined) : hashtagsThisWeek(cred.userId),
    ]);
    const n = (s: string) => counts.find((x) => x.status === s)?.n ?? 0;

    // Short-form ideas: a few questions and takes for today, each one tap from Create.
    const make = (kind: "reel" | "story", direction: string, label: string) =>
      `<form method="post" action="/admin/create"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="direction" value="${esc(direction)}">${button(label, { small: true, variant: kind === "reel" ? undefined : "ghost", icon: kind === "reel" ? "play" : "image" })}</form>`;
    const qs = pickLines(e.questions, [], `${p.identity.name}:${day}:page:q`, 3);
    const takes = pickLines(e.silly_talk, [], `${p.identity.name}:${day}:page:s`, 2);
    const ideas = [
      ...qs.map((q) => ({ line: q, what: "funny question", reel: `talk reel, funny question: "${q}"`, story: `question story: "${q}"` })),
      ...takes.map((s) => ({ line: s, what: "silly talk", reel: `talk reel, silly talk: "${s}"`, story: `banter story with the line: "${s}"` })),
      ...(e.football && e.formats.includes("football_banter")
        ? [{ line: `${e.football.team} vs ${e.football.rivals[0] ?? "the rivals"}: matchday mood`, what: "football banter", reel: `talk reel, football banter about ${e.football.team} and ${e.football.rivals[0] ?? "a rival"} (playful, about the clubs only)`, story: `banter story: ${e.football.team} matchday, playful rivalry with ${e.football.rivals[0] ?? "a rival"}` }]
        : []),
    ];
    const ideasCard = e.formats.length
      ? `<p class="help" style="margin:0 0 10px">Formats ${esc(inf.name)} does: ${e.formats.map((f) => esc(FORMAT_GUIDE[f].split(":")[0])).join(", ")}. Talk reels are one short front-camera clip with the line on screen; question and banter stories go out as a photo plus the line. Playful only: never romantic or sexual, never about anyone's looks.</p>
<ul class="eg-ideas">${ideas.map((i) => `<li><span class="line">${esc(i.line)}<small>${esc(i.what)}</small></span><span class="eg-act">${make("reel", i.reel, "Talk reel")}${make("story", i.story, "Story")}</span></li>`).join("")}</ul>`
      : empty("No short-form material yet", `Run the Standard's fix (or the Interview) to give ${inf.name} questions, silly takes and a club.`, isTenant(req) ? "" : link("Open Standard", "/admin/standard", { icon: "shield" }));

    const queue = drafts.length
      ? `<ul class="eg-q">${drafts
          .map(
            (d) => `<li>
<div class="eg-src"><span class="pill ${d.source === "hashtag" ? "info" : ""}">${d.source === "hashtag" ? `#${esc(d.hashtag ?? "")}` : "pasted"}</span><span>${ago(d.created_at)}</span><a href="${esc(d.permalink)}" target="_blank" rel="noopener noreferrer">${icon("external", 13)} open post</a></div>
<p class="eg-cap">${esc(d.caption.slice(0, 400))}</p>
${
  d.status === "new"
    ? `<form method="post" action="/admin/engagement/drafts/${d.id}" id="f${d.id}"><label class="visually-hidden" for="c${d.id}">Comment</label><textarea class="eg-comment" id="c${d.id}" name="comment" maxlength="300">${esc(d.comment)}</textarea><input type="hidden" name="status" value="done"></form>
<div class="eg-act"><button class="btn primary sm" type="button" data-copy-open="${esc(d.permalink)}">${icon("send", 14)}<span>Copy &amp; open post</span></button><button class="btn sm" type="submit" form="f${d.id}">${icon("check", 14)}<span>Posted it</span></button><form method="post" action="/admin/engagement/drafts/${d.id}"><input type="hidden" name="status" value="skipped">${button("Skip", { small: true, variant: "ghost", icon: "x" })}</form></div>`
    : `<p style="margin:0"><b>${esc(d.comment)}</b></p><div class="meta">${d.status === "done" ? "posted" : "skipped"} ${d.acted_at ? ago(d.acted_at) : ""}</div>`
}</li>`,
          )
          .join("")}</ul>`
      : empty(status === "new" ? "Nothing to comment on right now" : `Nothing ${status} yet`, status === "new" ? "The scout fills this from hashtags twice a day once its token is set, or paste links below." : "");

    const scoutFacts = `<ul class="eg-facts">
<li>Hashtags: ${e.scout_hashtags.length ? e.scout_hashtags.map((h) => `#${esc(h)}`).join(" ") : "none yet"}</li>
<li>Search: ${"missing" in cred ? `<span class="pill warn">not connected</span>` : `<b>${budget?.size ?? 0}/${HASHTAG_WEEKLY_LIMIT}</b> hashtags used this week`}</li>
<li>Up to <b>${c.scout_daily_drafts}</b> drafts a day${c.scout_enabled ? "" : " (scout is off in Controls)"}</li></ul>`;

    const body = `${header(`Engagement: ${inf.name}`, {
      sub: `Short content that gets people talking, and ${esc(inf.name)} showing up in other people's comments. Instagram doesn't let apps like or comment on other people's posts, so the scout drafts the comment and you post it from ${esc(inf.name)}'s account: copy, open, paste, like if you do.`,
    })}
${card(ideasCard, { title: "Short-form ideas for today" })}
${card(
  `${scoutFacts}${tabs([
    { href: "/admin/engagement", label: "To post", active: status === "new", count: n("new") },
    { href: "/admin/engagement?status=done", label: "Posted", active: status === "done", count: n("done") },
    { href: "/admin/engagement?status=skipped", label: "Skipped", active: status === "skipped", count: n("skipped") },
  ])}<div style="margin-top:14px">${queue}</div>`,
  { title: "Comment queue", actions: `<form method="post" action="/admin/engagement/scout">${button("Run scout now", { small: true, icon: "search" })}</form>` },
)}
${card(
  `<form method="post" action="/admin/engagement/links"><div class="field"><label for="links">Post links, one per line, each with what the post shows or its caption</label>
<textarea id="links" name="links" rows="4" placeholder="https://www.instagram.com/p/Cxyz123/ | new Jordans on the shop wall at Acacia Mall"></textarea>
<p class="help">Works without any token. Each post gets one comment drafted in ${esc(inf.name)}'s voice, checked for safety, in the queue above.</p></div>${button("Draft comments", { icon: "wand" })}</form>`,
  { title: "Found something worth commenting on?" },
)}
${card(
  mentions.length
    ? `<ul class="eg-q">${mentions
        .map((m) => `<li><div class="eg-src"><b>@${esc(m.sender_username ?? "someone")}</b><span>${ago(m.occurred_at)}</span>${pill(m.reply_status ?? m.status)}</div><p class="eg-cap">${esc(m.text)}</p>${m.reply ? `<p style="margin:0">${icon("send", 13)} ${esc(m.reply)}</p>` : ""}</li>`)
        .join("")}</ul>`
    : empty("No @mentions yet", `When someone tags @${esc(p.identity.handle?.replace(/^@/, "") ?? inf.name)} in a comment on another post, ${esc(inf.name)} answers there (same safety checks, review rules and hourly limit as comments)${c.mention_replies_enabled ? "" : ". Turned off in Controls"}.`),
  { title: "@mentions" },
)}${JS}`;
    return render(req, reply, { title: "Engagement", active: "engagement", body, head: CSS });
  });

  r.post("/admin/engagement/drafts/:id", async (req: Req, reply) =>
    attempt(req, reply, "/admin/engagement", async () => {
      const status = req.body?.status === "skipped" ? "skipped" : "done";
      await markDraft(Number(req.params.id), status, reviewer(req), status === "done" ? String(req.body?.comment ?? "") : undefined);
      return status === "done" ? "Marked as posted" : "Skipped";
    }),
  );

  r.post("/admin/engagement/links", async (req: Req, reply) => {
    try {
      const out = await scoutLinks(String(req.body?.links ?? "").slice(0, 20_000));
      const notes = [...out.problems, ...out.skipped].slice(0, 3).join(" · ");
      return done(req, reply, "/admin/engagement", `${out.drafted} comment${out.drafted === 1 ? "" : "s"} drafted${notes ? `. ${notes}` : ""}`, out.drafted > 0 || !notes);
    } catch (e) {
      return done(req, reply, "/admin/engagement", `Couldn't draft: ${errorMessage(e)}`, false);
    }
  });

  r.post("/admin/engagement/scout", async (req: Req, reply) => {
    try {
      const out = await runScout();
      return done(req, reply, "/admin/engagement", out.status === "done" ? `Scout read #${out.hashtags.join(", #")}: ${out.drafted} drafted` : `Scout didn't run: ${out.reason}`, out.status === "done");
    } catch (e) {
      return done(req, reply, "/admin/engagement", `Scout failed: ${errorMessage(e)}`, false);
    }
  });
}
