import type { FastifyInstance } from "fastify";
import { currentInfluencer } from "../../context.js";
import { knowledge } from "../../conversation/knowledge.js";
import { many } from "../../db/pool.js";
import { addExperience, applyChanges, changeSchema, draftChanges, nextQuestions } from "../../interview/interview.js";
import { errorMessage } from "../../lib/errors.js";
import { persona } from "../../persona/loader.js";
import { consoleRouter, done, render, reviewer, type Req } from "../console.js";
import { ago, button, card, empty, esc, header, icon } from "../ui/kit.js";

const CSS = `<style>
.iv-q{display:grid;gap:6px;padding:16px;border:1px solid var(--line);border-radius:16px;margin-bottom:12px;background:var(--surface)}
.iv-q label{font-weight:600;font-size:16px}.iv-q .why{margin:0;color:var(--muted);font-size:13px}
.iv-q textarea{min-height:80px}
.iv-changes{list-style:none;padding:0;margin:0 0 14px;display:grid;gap:8px}
.iv-changes li{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:var(--ok-bg);color:var(--ink)}
.iv-changes li svg{color:var(--ok);flex:none;margin-top:3px}
.iv-log{list-style:none;padding:0;margin:0}.iv-log li{padding:10px 0;border-bottom:1px solid var(--line)}.iv-log li:last-child{border:0}
</style>`;

/**
 * Interview: a few specific questions at a time about what's missing or thin,
 * answers turned into a reviewable change set, saved only on Save. Plus "Add an
 * experience" for things the influencer has lived.
 */
export function registerInterview(app: FastifyInstance): void {
  const r = consoleRouter(app);

  r.get("/admin/interview", async (req: Req, reply) => {
    const inf = currentInfluencer();
    const p = persona();
    const qs = await nextQuestions(p, knowledge(), 3);
    const log = await many<{ topic: string; question: string; answer: string; created_at: Date; answered_by: string | null }>(
      "SELECT topic, question, answer, created_at, answered_by FROM interview_answers WHERE influencer_id = $1 ORDER BY id DESC LIMIT 12",
      [inf.id],
    );
    const body = `${header(`Interview: ${inf.name}`, {
      sub: `A few questions at a time about what ${esc(inf.name)} still needs: real business facts first, then life, voice and places. Answer what you can, skip the rest. You'll see every change before it's saved.`,
    })}
${card(
  qs.length
    ? `<form method="post" action="/admin/interview/draft">${qs
        .map(
          (q, i) => `<div class="iv-q"><label for="a${i}">${esc(q.question)}</label><p class="why">${esc(q.why)}</p>
<textarea id="a${i}" name="answer_${i}" rows="3" placeholder="${esc(q.placeholder ?? "")}"></textarea>
<input type="hidden" name="topic_${i}" value="${esc(q.topic)}"><input type="hidden" name="question_${i}" value="${esc(q.question)}"></div>`,
        )
        .join("")}<div class="row">${button("Review changes", { variant: "primary", icon: "check" })}<span class="meta">Nothing is saved until you confirm.</span></div></form>`
    : empty("All caught up", `Nothing missing right now. Add an experience below whenever ${inf.name} does something worth remembering.`),
  { title: "Questions" },
)}
${card(
  `<form method="post" action="/admin/interview/experience"><div class="field"><label for="exp">What has ${esc(inf.name)} lived, done or got coming up?</label>
<textarea id="exp" name="text" rows="3" maxlength="1500" placeholder="e.g. Went to Blankets and Wine on Sunday, loved Azawi's set. Starting gym again Monday. Shop moves to Arena Mall in December."></textarea>
<p class="help">Becomes part of ${esc(inf.name)}'s remembered story right away, used in chats so the story stays consistent.</p></div>${button("Add to their story", { icon: "plus" })}</form>`,
  { title: "Add an experience" },
)}
${card(
  log.length
    ? `<ul class="iv-log">${log.map((l) => `<li><div class="meta">${ago(l.created_at)}${l.answered_by ? ` · ${esc(l.answered_by)}` : ""}</div><b>${esc(l.question)}</b><div>${esc(l.answer.slice(0, 280))}</div></li>`).join("")}</ul>`
    : empty("No answers yet", "What you tell the interview shows up here."),
  { title: "Recently added" },
)}`;
    return render(req, reply, { title: "Interview", active: "interview", body, head: CSS });
  });

  r.post("/admin/interview/draft", async (req: Req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const qa = [0, 1, 2, 3, 4].map((i) => ({ topic: b[`topic_${i}`] ?? "", question: b[`question_${i}`] ?? "", answer: (b[`answer_${i}`] ?? "").slice(0, 3000) })).filter((x) => x.topic);
    try {
      const set = await draftChanges(persona(), knowledge(), qa);
      const inf = currentInfluencer();
      const body = `${header(`Review: ${inf.name}`, { sub: "This is what will change. Save to apply it, or go back to edit your answers." })}
${card(
  set.summary.length ? `<ul class="iv-changes">${set.summary.map((s) => `<li>${icon("check", 16)}<span>${esc(s)}</span></li>`).join("")}</ul>` : empty("Nothing new", "Those answers didn't add anything the persona doesn't already have."),
  { title: "Changes" },
)}
<form method="post" action="/admin/interview/apply"><input type="hidden" name="set" value="${esc(JSON.stringify(set))}"><input type="hidden" name="qa" value="${esc(JSON.stringify(qa))}">
<div class="row">${set.summary.length ? button("Save changes", { variant: "primary", icon: "check" }) : ""}<a class="btn ghost" href="/admin/interview">Back</a></div></form>`;
      return render(req, reply, { title: "Interview", active: "interview", body, head: CSS });
    } catch (e) {
      return done(req, reply, "/admin/interview", `Couldn't read those answers: ${errorMessage(e)}`, false);
    }
  });

  r.post("/admin/interview/apply", async (req: Req, reply) => {
    try {
      // Re-validate: the form round-trips through the browser.
      const set = changeSchema.parse(JSON.parse(String(req.body?.set ?? "{}")));
      const qa = (JSON.parse(String(req.body?.qa ?? "[]")) as Array<{ topic: string; question: string; answer: string }>).slice(0, 5).map((x) => ({ topic: String(x.topic).slice(0, 60), question: String(x.question).slice(0, 400), answer: String(x.answer).slice(0, 3000) }));
      const summary = await applyChanges(currentInfluencer().id, set, qa, reviewer(req));
      return done(req, reply, "/admin/interview", `Saved ${summary.length} change${summary.length === 1 ? "" : "s"}`);
    } catch (e) {
      return done(req, reply, "/admin/interview", `Not saved: ${errorMessage(e)}`, false);
    }
  });

  r.post("/admin/interview/experience", async (req: Req, reply) => {
    try {
      const saved = await addExperience(persona(), String(req.body?.text ?? ""), reviewer(req));
      return done(req, reply, "/admin/interview", saved.length ? `Remembered: ${saved.join(" · ")}` : "Nothing to remember in that note", saved.length > 0);
    } catch (e) {
      return done(req, reply, "/admin/interview", `Not saved: ${errorMessage(e)}`, false);
    }
  });
}
