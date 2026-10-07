import type { FastifyInstance } from "fastify";
import { currentInfluencer, influencerId } from "../../context.js";
import { arcProgress } from "../../content/life.js";
import { many } from "../../db/pool.js";
import { persona } from "../../persona/loader.js";
import { consoleRouter, isTenant, render, type Req } from "../console.js";
import { ago, card, empty, esc, header, icon, link } from "../ui/kit.js";

const CSS = `<style>
.tl-arcs{display:grid}
.tl-arc{display:grid;gap:10px;padding:18px 0;border-top:1px solid var(--line)}.tl-arc:first-child{border-top:0;padding-top:2px}.tl-arc:last-child{padding-bottom:0}
.tl-arc h3{margin:0;font-size:16px}.tl-arc p{margin:0;color:var(--ink-2)}
.tl-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px;color:var(--muted)}
.tl-track{height:6px;border-radius:99px;background:var(--surface-3);overflow:hidden}
.tl-track i{display:block;height:100%;border-radius:99px;background:var(--brand)}
.tl-beats{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.tl-beats li{display:grid;grid-template-columns:22px 1fr auto;gap:10px;align-items:start;padding:7px 0;color:var(--muted)}
.tl-beats .dot{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;border:1.5px solid var(--line-2);background:var(--surface)}
.tl-beats .done{color:var(--ink)}.tl-beats .done .dot{background:var(--ok);border-color:var(--ok);color:#fff}
.tl-beats .next{color:var(--ink);font-weight:600}.tl-beats .next .dot{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in oklab,var(--brand) 22%,transparent)}
.tl-beats .when{font-size:12.5px;color:var(--muted);white-space:nowrap;font-weight:400}
.tl-people{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:0;padding:0}
.tl-people li{padding:8px 12px;border-radius:12px;background:var(--surface-2)}
.tl-people b{display:block}.tl-people span{font-size:13px;color:var(--muted)}
.tl-moments{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.tl-moments li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}
.tl-moments li:last-child{border:0}.tl-moments .used{color:var(--muted)}.tl-moments .meta{flex:none;white-space:nowrap}
.tl-feed{list-style:none;margin:0;padding:0}
.tl-feed li{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;padding:10px 0;border-bottom:1px solid var(--line)}
.tl-feed li:last-child{border:0}.tl-feed .meta{grid-column:2}
@media (max-width:640px){.tl-beats li{grid-template-columns:22px 1fr}.tl-beats .when{grid-column:2}}
</style>`;

interface BeatRow {
  arc_id: string;
  beat_index: number;
  post_id: string | null;
  status: string | null;
  format: string;
  created_at: Date;
}

/**
 * Timeline: the influencer's life as the feed tells it. Storylines with where
 * each stands, the people in their life, which small moments have been used,
 * and the latest posts and stories with what they stood on.
 */
export function registerTimeline(app: FastifyInstance): void {
  const r = consoleRouter(app);

  r.get("/admin/timeline", async (req: Req, reply) => {
    const inf = currentInfluencer();
    const p = persona();
    const now = new Date();
    const [arcs, beats, feed, used] = await Promise.all([
      arcProgress(p, now),
      many<BeatRow>(
        `SELECT ci.life->>'arc_id' AS arc_id, (ci.life->>'beat_index')::int AS beat_index, p.id AS post_id, p.status, ci.format, ci.created_at
         FROM content_ideas ci LEFT JOIN posts p ON p.content_idea_id = ci.id
         WHERE ci.influencer_id = $1 AND ci.life->>'arc_id' IS NOT NULL AND ci.status IN ('accepted','produced')
           AND (p.id IS NULL OR p.status NOT IN ('rejected','failed','qc_failed'))
         ORDER BY ci.created_at`,
        [influencerId()],
      ),
      many<{ post_id: string | null; topic: string; format: string; life: { arc_id?: string; beat?: string; moment?: string; callback_post_id?: string }; created_at: Date; status: string | null }>(
        `SELECT p.id AS post_id, ci.topic, ci.format, ci.life, ci.created_at, p.status
         FROM content_ideas ci LEFT JOIN posts p ON p.content_idea_id = ci.id
         WHERE ci.influencer_id = $1 AND ci.life IS NOT NULL AND ci.status IN ('accepted','produced')
           AND (p.id IS NULL OR p.status NOT IN ('rejected','failed','qc_failed'))
         ORDER BY ci.created_at DESC LIMIT 15`,
        [influencerId()],
      ),
      many<{ moment: string; at: Date }>(
        `SELECT ci.life->>'moment' AS moment, max(ci.created_at) AS at FROM content_ideas ci
         WHERE ci.influencer_id = $1 AND ci.life->>'moment' IS NOT NULL AND ci.status IN ('accepted','produced') GROUP BY 1`,
        [influencerId()],
      ),
    ]);
    const tenant = isTenant(req);
    const addHref = "/admin/interview";
    const editAction = link(tenant ? "Add through the Interview" : "Add or edit", tenant ? addHref : "/admin/persona#edit", { icon: "pencil", small: true, variant: "ghost" });
    const titleOf = new Map(p.life.arcs.map((a) => [a.id, a.title]));
    const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const usedAt = new Map(used.map((u) => [key(u.moment), u.at]));

    const arcCards = arcs.map((a) => {
      const pct = Math.round((a.done / a.arc.beats.length) * 100);
      const rows = a.arc.beats.map((b, i) => {
        const hit = beats.find((x) => x.arc_id === a.arc.id && x.beat_index === i);
        if (i < a.done) {
          const when = hit ? `${hit.format === "story" ? "story" : "post"} ${ago(hit.created_at)}` : "posted";
          return `<li class="done"><span class="dot">${icon("check", 13)}</span><span>${esc(b)}</span><span class="when">${hit?.post_id ? `<a href="/admin/posts/${hit.post_id}">${when}</a>` : when}</span></li>`;
        }
        if (i === a.done) return `<li class="next" aria-current="step"><span class="dot"></span><span>${esc(b)}</span><span class="when">${a.due ? "next, due now" : `next, in ${a.waitDays} day${a.waitDays === 1 ? "" : "s"}`}</span></li>`;
        return `<li><span class="dot"></span><span>${esc(b)}</span><span class="when"></span></li>`;
      });
      return `<article class="tl-arc"><div><h3>${esc(a.arc.title)}</h3><p>${esc(a.arc.story)}</p></div>
<div class="tl-meta"><span>${a.done} of ${a.arc.beats.length} beats</span><span>·</span><span>one beat every ${a.arc.every_days} days at most</span>${a.next ? "" : `<span class="pill ok">finished</span>`}</div>
<div class="tl-track" role="progressbar" aria-label="${esc(a.arc.title)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
<ol class="tl-beats">${rows.join("")}</ol></article>`;
    });

    const tag = (l: (typeof feed)[number]["life"]) =>
      [l.arc_id ? `${titleOf.get(l.arc_id) ?? l.arc_id}: ${l.beat ?? ""}` : "", l.moment ? `moment: ${l.moment}` : "", l.callback_post_id ? "follow-up to an earlier post" : ""].filter(Boolean).map(esc).join(" · ");

    const body = `${header(`Timeline: ${inf.name}`, {
      sub: `${esc(inf.name)}'s life as the feed tells it: storylines that move one small step at a time, the people around ${esc(inf.name)}, and the specific moments posts are built on. The content director picks from here so posts never look like stock AI photos.`,
    })}
${card(arcCards.length ? `<div class="tl-arcs">${arcCards.join("")}</div>` : empty("No storylines yet", `Storylines are what ${inf.name} is working towards over weeks (training, learning, a project). Add one and the feed follows it a step at a time.`, link("Add a storyline", tenant ? addHref : "/admin/persona#edit", { icon: "plus" })), { title: "Storylines", actions: editAction })}
${card(
  p.life.circle.length ? `<ul class="tl-people">${p.life.circle.map((c) => `<li><b>${esc(c.name)}</b><span>${esc(c.who)}</span></li>`).join("")}</ul><p class="help" style="margin-top:12px">Named in captions and chats the way real people mention friends; never their faces in a photo.</p>` : empty("Nobody yet", `Friends, a sibling, a coworker: people ${inf.name} mentions.`),
  { title: "People in their life" },
)}
${card(
  p.life.moments.length
    ? `<ul class="tl-moments">${p.life.moments
        .map((m) => {
          const at = usedAt.get(key(m));
          return `<li${at ? ` class="used"` : ""}><span>${esc(m)}</span><span class="meta">${at ? `used ${ago(at)}` : "fresh"}</span></li>`;
        })
        .join("")}</ul>`
    : empty("No moments yet", "Small, specific things that happen in their days. They keep posts from looking generic."),
  { title: `Small moments (${p.life.moments.length})` },
)}
${card(
  feed.length
    ? `<ul class="tl-feed">${feed
        .map((f) => `<li><span class="pill">${esc(f.format === "story" ? "story" : "post")}</span><span>${f.post_id ? `<a href="/admin/posts/${f.post_id}">${esc(f.topic)}</a>` : esc(f.topic)}</span><span class="meta">${ago(f.created_at)} · ${tag(f.life)}</span></li>`)
        .join("")}</ul>`
    : empty("Nothing on the timeline yet", "New posts and stories show here with the storyline step or moment they stand on."),
  { title: "Latest on the timeline" },
)}`;
    return render(req, reply, { title: "Timeline", active: "timeline", body, head: CSS });
  });
}
