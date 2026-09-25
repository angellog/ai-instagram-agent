import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { controlsSchema, getControls, setControls, type Controls } from "../config/controls.js";
import { env } from "../config/env.js";
import { costByOperation, costReport, spendSummary } from "../cost/ledger.js";
import { many, one, tx } from "../db/pool.js";
import { primaryAccount } from "../instagram/accounts.js";
import { storeWebhookEvent } from "../ingest/webhook.js";
import { forgetUser } from "../memory/store.js";
import { personaInfo, recordPersonaVersion, reloadPersona } from "../persona/loader.js";
import { JOBS, jobId, queue, queueCounts } from "../queue/queues.js";
import { schedulePublish } from "../content/produce.js";
import { ago, bar, esc, layout, pill, table, usd } from "./html.js";
import { approveReview, listReviews, rejectReview } from "./reviews.js";

/** Post states in which the operator may still edit slides. */
const EDITABLE = ["awaiting_review", "dry_run", "qc_failed"];

export async function removeSlide(postId: string, position: number): Promise<string> {
  return tx(async (c) => {
    const post = (await c.query<{ status: string }>("SELECT status FROM posts WHERE id = $1 FOR UPDATE", [postId])).rows[0];
    if (!post) return "Post not found";
    if (!EDITABLE.includes(post.status)) return `Slides can't be changed while the post is ${post.status}`;
    const n = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM post_assets WHERE post_id = $1", [postId])).rows[0].n;
    if (n <= 1) return "A post needs at least one image";
    const del = await c.query("DELETE FROM post_assets WHERE post_id = $1 AND position = $2", [postId, position]);
    if (!del.rowCount) return "No such slide";
    // Shift later slides down (via negative positions to respect the unique index).
    await c.query("UPDATE post_assets SET position = -position - 1 WHERE post_id = $1 AND position > $2", [postId, position]);
    await c.query("UPDATE post_assets SET position = -position - 2 WHERE post_id = $1 AND position < 0", [postId]);
    if (n - 1 === 1) await c.query("UPDATE posts SET media_type = 'IMAGE', updated_at = now() WHERE id = $1", [postId]);
    return `Removed slide ${position + 1}; ${n - 1} left`;
  });
}

export async function rerunInteraction(id: number): Promise<string> {
  const sent = await one("SELECT 1 FROM messages WHERE interaction_id = $1 AND direction = 'out' AND status IN ('sent','sending','pending_review')", [id]);
  if (sent) return "A reply already exists for this interaction";
  const r = await one<{ id: number }>(
    "UPDATE interactions SET status = 'pending', last_error = NULL, updated_at = now() WHERE id = $1 AND status IN ('ignored','failed') RETURNING id",
    [id],
  );
  if (!r) return "Only ignored or failed interactions can be re-run";
  await one("DELETE FROM messages WHERE interaction_id = $1 AND direction = 'out' AND status IN ('failed','rejected','blocked','dry_run')", [id]);
  await queue("conversation").add(JOBS.conversationProcess, { interactionId: id }, { jobId: jobId("interaction", id, "rerun", Date.now()) });
  return "Re-run queued; refresh in a few seconds";
}

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: Record<string, string> }>;

async function page(req: Req, reply: FastifyReply, title: string, body: string) {
  const c = await getControls();
  const flash = typeof req.query?.flash === "string" ? req.query.flash : undefined;
  return reply.type("text/html").send(layout({ title, body, flash, mode: c.mode, paused: c.paused, openAccess: !env().ADMIN_TOKEN }));
}

const back = (reply: FastifyReply, to: string, flash: string) => reply.redirect(`${to}${to.includes("?") ? "&" : "?"}flash=${encodeURIComponent(flash)}`, 303);
const reviewer = (req: Req) => (req.headers["x-reviewer"] as string | undefined) ?? "admin";

export function registerAdmin(app: FastifyInstance): void {
  // ------------------------------------------------------------ overview
  app.get("/admin", async (req: Req, reply) => {
    const [c, spend, counts, acct, pending, posts, events, conv, followers] = await Promise.all([
      getControls(),
      spendSummary(),
      queueCounts().catch(() => ({}) as Record<string, Record<string, number>>),
      primaryAccount(),
      one<{ n: number }>("SELECT count(*)::int AS n FROM safety_reviews WHERE status = 'pending'"),
      many<{ id: string; status: string; media_type: string; caption: string; created_at: Date; permalink: string | null }>(
        "SELECT id, status, media_type, caption, created_at, permalink FROM posts ORDER BY created_at DESC LIMIT 6",
      ),
      many<{ level: string; source: string; message: string; created_at: Date }>(
        "SELECT level, source, message, created_at FROM system_events WHERE level IN ('warn','error') ORDER BY id DESC LIMIT 8",
      ),
      one<{ total: number; replied: number; ignored: number }>(`SELECT count(*)::int AS total,
          count(*) FILTER (WHERE status = 'done')::int AS replied, count(*) FILTER (WHERE status = 'ignored')::int AS ignored
          FROM interactions WHERE created_at > now() - interval '24 hours'`),
      one<{ followers: number | null }>("SELECT followers FROM account_metrics ORDER BY day DESC LIMIT 1"),
    ]);
    const q = Object.entries(counts)
      .map(([name, n]) => [esc(name), String(n.waiting ?? 0), String(n.active ?? 0), String(n.delayed ?? 0), n.failed ? `<b>${n.failed}</b>` : "0"]);
    const body = `
<h1>Overview</h1>
<div class="grid">
  <div class="card"><h2>Account</h2>${
    acct
      ? `<div class="kpi">@${esc(acct.username ?? acct.ig_user_id)}</div><div class="muted small">token expires ${ago(acct.token_expires_at)} · followers ${followers?.followers ?? "—"}</div>`
      : `<p>No Instagram account connected.</p><a class="btn" href="/admin/connect">Connect Instagram</a>`
  }</div>
  <div class="card"><h2>Mode</h2><div class="kpi">${esc(c.mode.replace("_", " "))}</div>
    <form class="inline" method="post" action="/admin/controls"><input type="hidden" name="paused" value="${c.paused ? "false" : "true"}">
    <button class="${c.paused ? "primary" : "danger"}">${c.paused ? "Resume" : "Pause everything"}</button></form>
    <a class="btn" href="/admin/controls">Controls</a></div>
  <div class="card"><h2>Waiting for you</h2><div class="kpi">${pending?.n ?? 0}</div><a href="/admin/reviews">Open review queue →</a></div>
  <div class="card"><h2>Spend today</h2><div class="kpi">${usd(spend.today)}</div>${bar(spend.today, c.daily_budget_usd)}
    <div class="muted small">of ${usd(c.daily_budget_usd)} daily · month ${usd(spend.month)} of ${usd(c.monthly_budget_usd)}</div></div>
  <div class="card"><h2>Conversations (24h)</h2><div class="kpi">${conv?.total ?? 0}</div><div class="muted small">${conv?.replied ?? 0} handled · ${conv?.ignored ?? 0} deliberately ignored</div></div>
</div>
<div class="card"><h2>Actions</h2><div class="row">
  <form class="inline" method="post" action="/admin/actions/plan"><button>Run content planner now</button></form>
  <form class="inline" method="post" action="/admin/actions/sweep"><button>Recover stalled work</button></form>
  <form class="inline" method="post" action="/admin/actions/analytics"><button>Recompute learnings</button></form>
</div>
<form method="post" action="/admin/simulate" class="row" style="margin-top:12px">
  <select name="kind"><option value="comment">Simulate comment</option><option value="dm">Simulate DM</option></select>
  <input name="username" placeholder="username" value="test_follower">
  <input name="text" placeholder="message" style="flex:1;min-width:220px" value="Which pair should I get for everyday wear?">
  <button>Run through the agent</button></form>
  <p class="muted small">Simulations run the full pipeline (classification, memory, reasoning, safety) and are recorded like real ones, but are never sent to Instagram.</p>
</div>
<div class="card"><h2>Recent posts</h2>${table(
      ["Status", "Type", "Caption", "Created"],
      posts.map((p) => [pill(p.status), esc(p.media_type), `<a href="/admin/posts/${p.id}">${esc(p.caption.slice(0, 90))}</a>${p.permalink ? ` · <a href="${esc(p.permalink)}" target="_blank">IG</a>` : ""}`, ago(p.created_at)]),
    )}</div>
<div class="grid">
<div class="card"><h2>Queues</h2>${table(["Queue", "Waiting", "Active", "Delayed", "Failed"], q, "Redis unreachable")}</div>
<div class="card"><h2>Recent warnings & errors</h2>${table(
      ["", "Source", "Message", "When"],
      events.map((e) => [pill(e.level), esc(e.source), esc(e.message), ago(e.created_at)]),
      "No warnings. 🎉",
    )}<a href="/admin/events">All events →</a></div></div>`;
    return page(req, reply, "Overview", body);
  });

  // ------------------------------------------------------------ reviews
  app.get("/admin/reviews", async (req: Req, reply) => {
    const status = (req.query.status as "pending" | "all") ?? "pending";
    const rows = await listReviews(status);
    const cards = rows.map((r) => {
      const p = r.proposed as { text?: string; inbound?: string; username?: string; channel?: string; caption?: string; slides?: string[] };
      const isPost = r.subject_type === "post";
      const actionable = r.status === "pending" && r.level !== "red";
      return `<div class="card"><div class="row">${pill(r.level)} ${pill(r.status)} <b>${isPost ? "Post" : `Reply (${esc(p.channel ?? "")})`}</b>
        <span class="muted small">${esc(r.categories.join(", "))} · ${ago(r.created_at)}</span></div>
        <p class="small muted">${esc(r.reason ?? "")}</p>
        ${!isPost && p.inbound ? `<p><b>@${esc(p.username ?? "")}:</b> ${esc(p.inbound)}</p>` : ""}
        ${isPost ? `<div class="slides">${(p.slides ?? []).map((u) => `<img src="${esc(u)}" loading="lazy">`).join("")}</div><p><a href="/admin/posts/${esc(r.subject_id)}">Open post →</a></p>` : ""}
        ${
          actionable
            ? `<form method="post" action="/admin/reviews/${r.id}/approve"><textarea name="text">${esc(isPost ? (p.caption ?? "") : (p.text ?? ""))}</textarea>
               <div class="row"><button class="primary">Approve${isPost ? " & schedule" : " & send"}</button></form>
               <form class="inline" method="post" action="/admin/reviews/${r.id}/reject"><input name="note" placeholder="reason (optional)"><button class="danger">Reject</button></form></div>`
            : `<pre>${esc(isPost ? (p.caption ?? "") : (p.text ?? ""))}</pre>`
        }</div>`;
    });
    return page(
      req,
      reply,
      "Reviews",
      `<h1>Review queue</h1><p><a href="/admin/reviews">Pending</a> · <a href="/admin/reviews?status=all">All</a></p>${cards.join("") || `<p class="muted">Nothing waiting. The agent is handling things on its own.</p>`}`,
    );
  });
  app.post("/admin/reviews/:id/approve", async (req: Req, reply) => {
    const r = await approveReview(Number(req.params.id), reviewer(req), req.body?.text);
    return back(reply, "/admin/reviews", r.message);
  });
  app.post("/admin/reviews/:id/reject", async (req: Req, reply) => {
    const r = await rejectReview(Number(req.params.id), reviewer(req), req.body?.note || undefined);
    return back(reply, "/admin/reviews", r.message);
  });

  // ------------------------------------------------------------ posts
  app.get("/admin/posts", async (req: Req, reply) => {
    const rows = await many<{ id: string; status: string; media_type: string; caption: string; created_at: Date; published_at: Date | null; score: number | null; safety_level: string | null }>(
      `SELECT p.id, p.status, p.media_type, p.caption, p.created_at, p.published_at, p.safety_level,
         (SELECT score FROM engagement_metrics em WHERE em.post_id = p.id ORDER BY collected_at DESC LIMIT 1) AS score
       FROM posts p ORDER BY p.created_at DESC LIMIT 100`,
    );
    return page(
      req,
      reply,
      "Posts",
      `<h1>Posts</h1><div class="card">${table(
        ["Status", "Safety", "Type", "Caption", "Score", "Created", "Published"],
        rows.map((p) => [pill(p.status), pill(p.safety_level), esc(p.media_type), `<a href="/admin/posts/${p.id}">${esc(p.caption.slice(0, 100))}</a>`, p.score?.toFixed(2) ?? "—", ago(p.created_at), ago(p.published_at)]),
      )}</div>`,
    );
  });

  app.get("/admin/posts/:id", async (req: Req, reply) => {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send("not found");
    const p = await one<Record<string, any>>(
      `SELECT p.*, ci.topic, ci.hook, ci.structure, ci.format, ci.repetition_score, ci.repetition_detail FROM posts p LEFT JOIN content_ideas ci ON ci.id = p.content_idea_id WHERE p.id = $1`,
      [id],
    );
    if (!p) return reply.code(404).send("not found");
    const [assets, decisions, metrics, jobs, costs] = await Promise.all([
      many<{ position: number; public_url: string | null; prompt: string | null; overlay: any }>("SELECT position, public_url, prompt, overlay FROM post_assets WHERE post_id = $1 ORDER BY position", [id]),
      many<{ agent: string; action: string; reason: string | null; safety_level: string | null; created_at: Date }>(
        "SELECT agent, action, reason, safety_level, created_at FROM agent_decisions WHERE subject_type = 'post' AND subject_id = $1 ORDER BY id",
        [id],
      ),
      many<Record<string, any>>("SELECT * FROM engagement_metrics WHERE post_id = $1 ORDER BY collected_at", [id]),
      many<{ position: number; status: string; model: string; credits: number | null; error: string | null; attempt: number; result_urls: string[] }>(
        "SELECT position, status, model, credits, error, attempt, result_urls FROM generation_jobs WHERE post_id = $1 ORDER BY id",
        [id],
      ),
      one<{ usd: number }>("SELECT coalesce(sum(cost_usd),0)::float AS usd FROM cost_ledger WHERE ref_type = 'post' AND ref_id = $1", [id]),
    ]);
    const actions = [
      p.status === "awaiting_review" || p.status === "dry_run"
        ? `<form class="inline" method="post" action="/admin/posts/${id}/approve"><button class="primary">Approve & schedule</button></form>`
        : "",
      ["approved", "failed"].includes(p.status) && assets.length
        ? `<form class="inline" method="post" action="/admin/posts/${id}/publish"><button>Publish now</button></form>`
        : "",
      ["qc_failed", "failed"].includes(p.status) && !p.ig_media_id
        ? `<form class="inline" method="post" action="/admin/posts/${id}/retry"><button>Retry production</button></form>`
        : "",
      !["published", "rejected"].includes(p.status) ? `<form class="inline" method="post" action="/admin/posts/${id}/reject"><button class="danger">Reject</button></form>` : "",
    ].join(" ");
    const body = `<h1>${esc(p.topic ?? "Post")}</h1>
<div class="card"><div class="row">${pill(p.status)} ${pill(p.safety_level)} <span class="muted">${esc(p.format ?? "")} / ${esc(p.structure ?? "")} · repetition ${p.repetition_score ?? "—"} · cost ${usd(costs?.usd)}</span></div>
<div class="row" style="margin-top:8px">${actions}${p.permalink ? `<a class="btn" href="${esc(p.permalink)}" target="_blank">Open on Instagram</a>` : ""}</div>
${p.last_error ? `<p class="small" style="color:var(--bad)">${esc(p.last_error)}</p>` : ""}</div>
<div class="card"><h2>Slides</h2><div class="slides">${
      assets
        .map((a) =>
          a.public_url
            ? `<div><img src="${esc(a.public_url)}" title="${esc(a.overlay?.alt_text ?? "")}">${
                EDITABLE.includes(p.status) && assets.length > 1
                  ? `<form method="post" action="/admin/posts/${id}/slides/${a.position}/remove" onsubmit="return confirm('Remove slide ${a.position + 1}?')"><button class="danger small">Remove slide ${a.position + 1}</button></form>`
                  : ""
              }</div>`
            : "",
        )
        .join("") || `<span class="muted">Not generated yet</span>`
    }</div></div>
<div class="card"><h2>Caption</h2><pre>${esc(p.caption)}</pre><p class="small muted">Hook: ${esc(p.hook ?? "")}</p></div>
<div class="grid"><div class="card"><h2>Engagement</h2>${table(
      ["Checkpoint", "Reach", "Likes", "Comments", "Saves", "Shares", "Follows", "Score"],
      metrics.map((m) => [esc(m.checkpoint), m.reach ?? "—", m.likes ?? "—", m.comments ?? "—", m.saves ?? "—", m.shares ?? "—", m.follows ?? "—", m.score ?? "—"].map(String)),
      "Collected 24h, 72h and 7d after publishing.",
    )}</div>
<div class="card"><h2>Image generation</h2>${table(
      ["Slide", "Attempt", "Status", "Model", "Credits", "Image", "Error"],
      jobs.map((j) => [
        String(j.position + 1),
        String(j.attempt),
        pill(j.status),
        esc(j.model),
        String(j.credits ?? "—"),
        j.result_urls?.[0]?.startsWith("http") ? `<a href="${esc(j.result_urls[0])}" target="_blank">view</a>` : "—",
        esc(j.error ?? ""),
      ]),
    )}</div></div>
<div class="card"><h2>Decision trail</h2>${table(
      ["Agent", "Action", "Safety", "Reason", "When"],
      decisions.map((d) => [esc(d.agent), esc(d.action), pill(d.safety_level), esc(d.reason ?? ""), ago(d.created_at)]),
    )}</div>
<div class="card"><h2>Visual state & prompts</h2><pre>${esc(JSON.stringify(p.visual_state, null, 2))}</pre>${assets
      .map((a) => `<details><summary>Slide ${a.position + 1} prompt</summary><pre>${esc(a.prompt ?? "")}</pre></details>`)
      .join("")}${p.repetition_detail ? `<details><summary>Repetition detail</summary><pre>${esc(JSON.stringify(p.repetition_detail, null, 2))}</pre></details>` : ""}</div>`;
    return page(req, reply, "Post", body);
  });

  // Drop one slide from a draft before it is approved; positions are compacted.
  app.post("/admin/posts/:id/slides/:pos/remove", async (req: Req, reply) => {
    const id = req.params.id;
    const pos = Number(req.params.pos);
    const r = await removeSlide(id, pos);
    return back(reply, `/admin/posts/${id}`, r);
  });

  app.post("/admin/posts/:id/approve", async (req: Req, reply) => {
    const id = req.params.id;
    const review = await one<{ id: number }>("SELECT id FROM safety_reviews WHERE subject_type = 'post' AND subject_id = $1 AND status = 'pending'", [id]);
    if (review) {
      const r = await approveReview(review.id, reviewer(req));
      return back(reply, `/admin/posts/${id}`, r.message);
    }
    const post = await one<{ status: string; safety_level: string | null }>("SELECT status, safety_level FROM posts WHERE id = $1", [id]);
    if (!post || !["awaiting_review", "dry_run"].includes(post.status)) return back(reply, `/admin/posts/${id}`, "Post is not awaiting approval");
    if (post.safety_level === "red") return back(reply, `/admin/posts/${id}`, "RED posts cannot be approved");
    await one("UPDATE posts SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [id, reviewer(req)]);
    const at = await schedulePublish(id, await getControls(), personaInfo().persona);
    return back(reply, `/admin/posts/${id}`, `Approved; publishing at ${at.toISOString()}`);
  });
  app.post("/admin/posts/:id/publish", async (req: Req, reply) => {
    const id = req.params.id;
    await one("UPDATE posts SET status = 'approved', last_error = NULL WHERE id = $1 AND status IN ('approved','failed') AND ig_media_id IS NULL", [id]);
    await queue("publish").add(JOBS.postPublish, { postId: id }, { jobId: jobId("publish", id, "manual", Date.now()) });
    return back(reply, `/admin/posts/${id}`, "Publishing queued");
  });
  // Re-run production for a failed post. Slides that already passed are kept;
  // only missing slides are generated again.
  app.post("/admin/posts/:id/retry", async (req: Req, reply) => {
    const id = req.params.id;
    const r = await one<{ id: string }>(
      "UPDATE posts SET status = 'draft', last_error = NULL, updated_at = now() WHERE id = $1 AND status IN ('qc_failed','failed') AND ig_media_id IS NULL RETURNING id",
      [id],
    );
    if (!r) return back(reply, `/admin/posts/${id}`, "Only failed posts can be retried");
    await one("UPDATE content_ideas SET status = 'accepted', updated_at = now() WHERE id = (SELECT content_idea_id FROM posts WHERE id = $1)", [id]);
    await queue("content").add(JOBS.contentProduce, { postId: id }, { jobId: jobId("produce", id, "retry", Date.now()) });
    return back(reply, `/admin/posts/${id}`, "Production restarted");
  });
  app.post("/admin/posts/:id/reject", async (req: Req, reply) => {
    const id = req.params.id;
    const review = await one<{ id: number }>("SELECT id FROM safety_reviews WHERE subject_type = 'post' AND subject_id = $1 AND status = 'pending'", [id]);
    if (review) await rejectReview(review.id, reviewer(req), "rejected from post page");
    else await one("UPDATE posts SET status = 'rejected', reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND status NOT IN ('published','publishing')", [id, reviewer(req)]);
    return back(reply, `/admin/posts/${id}`, "Rejected");
  });

  // ------------------------------------------------------------ content
  app.get("/admin/content", async (req: Req, reply) => {
    const [activities, ideas, learnings, requests] = await Promise.all([
      many<{ day: string; slot: string; activity: string; location: string | null; decision: string; reason: string | null }>(
        "SELECT day::text, slot, activity, location, decision, reason FROM activities WHERE day >= (now() - interval '2 days')::date ORDER BY day DESC, id",
      ),
      many<{ id: number; status: string; format: string; structure: string; topic: string; hook: string; repetition_score: number | null; reject_reason: string | null; created_at: Date }>(
        "SELECT id, status, format, structure, topic, hook, repetition_score, reject_reason, created_at FROM content_ideas ORDER BY id DESC LIMIT 40",
      ),
      many<{ dimension: string; value: string; samples: number; mean_score: number }>("SELECT * FROM learnings ORDER BY dimension, mean_score DESC"),
      many<{ content: string; updated_at: Date }>("SELECT content, updated_at FROM memories WHERE layer = 'world' AND kind = 'content_request' AND status = 'active' ORDER BY updated_at DESC LIMIT 20"),
    ]);
    const body = `<h1>Content brain</h1>
<div class="card"><h2>Virtual day (activity plan)</h2>${table(
      ["Day", "Slot", "Activity", "Location", "Decision", "Why"],
      activities.map((a) => [esc(a.day), esc(a.slot), esc(a.activity), esc(a.location ?? ""), pill(a.decision), esc(a.reason ?? "")]),
      "The plan is created the first time the planner runs each day.",
    )}</div>
<div class="card"><h2>Ideas</h2>${table(
      ["Status", "Format", "Topic", "Hook", "Repetition", "Note", "When"],
      ideas.map((i) => [pill(i.status), `${esc(i.format)}/${esc(i.structure)}`, esc(i.topic), esc(i.hook), i.repetition_score?.toFixed(2) ?? "—", esc(i.reject_reason ?? ""), ago(i.created_at)]),
    )}</div>
<div class="grid"><div class="card"><h2>Learnings</h2>${table(
      ["Dimension", "Value", "Posts", "Mean score"],
      learnings.map((l) => [esc(l.dimension), esc(l.value), String(l.samples), l.mean_score.toFixed(2)]),
      "Learnings appear after the first posts have 24h of insights.",
    )}</div><div class="card"><h2>Follower requests</h2>${table(["Request", "When"], requests.map((r) => [esc(r.content), ago(r.updated_at)]))}</div></div>`;
    return page(req, reply, "Content", body);
  });

  // ------------------------------------------------------------ conversations
  app.get("/admin/conversations", async (req: Req, reply) => {
    const rows = await many<{
      id: number;
      kind: string;
      status: string;
      sender_username: string | null;
      text: string;
      occurred_at: Date;
      reply: string | null;
      reply_status: string | null;
      action: string | null;
      reason: string | null;
      intent: string | null;
      user_id: number | null;
    }>(
      `SELECT i.id, i.kind, i.status, i.sender_username, i.text, i.occurred_at,
         m.text AS reply, m.status AS reply_status, d.action, d.reason, d.intent, u.id AS user_id
       FROM interactions i
       LEFT JOIN LATERAL (SELECT text, status FROM messages WHERE interaction_id = i.id AND direction = 'out' ORDER BY id DESC LIMIT 1) m ON true
       LEFT JOIN LATERAL (SELECT action, reason, intent FROM agent_decisions WHERE subject_type = 'interaction' AND subject_id = i.id::text AND agent = 'conversation_agent' ORDER BY id DESC LIMIT 1) d ON true
       LEFT JOIN ig_users u ON u.ig_scoped_id = i.sender_ig_id
       ORDER BY i.id DESC LIMIT 80`,
    );
    return page(
      req,
      reply,
      "Conversations",
      `<h1>Conversations</h1><div class="card">${table(
        ["When", "From", "Kind", "Message", "Intent / action", "Reply", "Status"],
        rows.map((r) => [
          ago(r.occurred_at),
          r.user_id ? `<a href="/admin/people/${r.user_id}">@${esc(r.sender_username ?? "?")}</a>` : `@${esc(r.sender_username ?? "?")}`,
          esc(r.kind),
          esc(r.text),
          `${esc(r.intent ?? "")} ${esc(r.action ?? "")}<div class="muted small">${esc(r.reason ?? "")}</div>`,
          r.reply ? `${esc(r.reply)} ${pill(r.reply_status)}` : "—",
          `${pill(r.status)}${
            ["ignored", "failed"].includes(r.status) && !r.reply
              ? `<form class="inline" method="post" action="/admin/interactions/${r.id}/rerun"><button class="small">Re-run</button></form>`
              : ""
          }`,
        ]),
      )}</div>`,
    );
  });

  // Process an interaction again (e.g. after a policy fix). Only when nothing
  // was sent for it, so a re-run can never produce a second reply.
  app.post("/admin/interactions/:id/rerun", async (req: Req, reply) => {
    const r = await rerunInteraction(Number(req.params.id));
    return back(reply, "/admin/conversations", r);
  });

  // ------------------------------------------------------------ people / memory
  app.get("/admin/people", async (req: Req, reply) => {
    const rows = await many<{ id: number; username: string | null; interaction_count: number; last_interaction_at: Date; trust: string; relationship_summary: string | null; memories: number }>(
      `SELECT u.*, (SELECT count(*)::int FROM memories m WHERE m.ig_user_id = u.id AND m.status = 'active') AS memories
       FROM ig_users u ORDER BY last_interaction_at DESC LIMIT 200`,
    );
    return page(
      req,
      reply,
      "People",
      `<h1>People</h1><div class="card">${table(
        ["User", "Interactions", "Memories", "Trust", "Summary", "Last seen"],
        rows.map((u) => [`<a href="/admin/people/${u.id}">@${esc(u.username ?? u.id)}</a>`, String(u.interaction_count), String(u.memories), pill(u.trust), esc(u.relationship_summary ?? ""), ago(u.last_interaction_at)]),
      )}</div>`,
    );
  });
  app.get("/admin/people/:id", async (req: Req, reply) => {
    const id = Number(req.params.id);
    const u = await one<Record<string, any>>("SELECT * FROM ig_users WHERE id = $1", [id]);
    if (!u) return reply.code(404).send("not found");
    const [mems, msgs] = await Promise.all([
      many<{ id: number; kind: string; content: string; confidence: number; status: string; expires_at: Date | null; source_type: string; source_id: string | null; created_at: Date }>(
        "SELECT * FROM memories WHERE ig_user_id = $1 ORDER BY status, updated_at DESC",
        [id],
      ),
      many<{ direction: string; channel: string; text: string; status: string; created_at: Date }>(
        `SELECT m.direction, m.channel, m.text, m.status, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.ig_user_id = $1 ORDER BY m.id DESC LIMIT 40`,
        [id],
      ),
    ]);
    const body = `<h1>@${esc(u.username ?? u.ig_scoped_id)}</h1>
<div class="card"><p>${esc(u.relationship_summary ?? "No summary yet.")}</p><p class="muted small">First seen ${ago(u.first_interaction_at)} · ${u.interaction_count} interactions · interests: ${esc((u.known_interests ?? []).join(", ") || "—")}</p>
<div class="row"><form class="inline" method="post" action="/admin/people/${id}/trust"><select name="trust">${["normal", "vip", "muted", "blocked"].map((t) => `<option ${t === u.trust ? "selected" : ""}>${t}</option>`).join("")}</select><button>Set trust</button></form>
<form class="inline" method="post" action="/admin/people/${id}/forget" onsubmit="return confirm('Delete everything the agent remembers about this person?')"><button class="danger">Forget this person</button></form></div></div>
<div class="card"><h2>Memories</h2>${table(
      ["Kind", "Memory", "Confidence", "Status", "Expires", "Source"],
      mems.map((m) => [esc(m.kind), esc(m.content), m.confidence.toFixed(2), pill(m.status), m.expires_at ? ago(m.expires_at) : "never", `${esc(m.source_type)} ${esc(m.source_id ?? "")}`]),
    )}</div>
<div class="card"><h2>Messages</h2>${table(["When", "Dir", "Channel", "Text", "Status"], msgs.map((m) => [ago(m.created_at), m.direction === "in" ? "⬅️" : "➡️", esc(m.channel), esc(m.text), pill(m.status)]))}</div>`;
    return page(req, reply, "Person", body);
  });
  app.post("/admin/people/:id/trust", async (req: Req, reply) => {
    const t = req.body?.trust;
    if (!["normal", "vip", "muted", "blocked"].includes(t)) return back(reply, `/admin/people/${req.params.id}`, "invalid trust");
    await one("UPDATE ig_users SET trust = $2, updated_at = now() WHERE id = $1", [Number(req.params.id), t]);
    return back(reply, `/admin/people/${req.params.id}`, `Trust set to ${t}`);
  });
  app.post("/admin/people/:id/forget", async (req: Req, reply) => {
    const n = await forgetUser(Number(req.params.id));
    return back(reply, `/admin/people/${req.params.id}`, `Deleted ${n} memories`);
  });

  // ------------------------------------------------------------ costs
  app.get("/admin/costs", async (req: Req, reply) => {
    const [report, byOp, c, daily] = await Promise.all([
      costReport(),
      costByOperation(30),
      getControls(),
      many<{ day: string; llm: number; image: number }>(
        `SELECT occurred_at::date::text AS day, coalesce(sum(cost_usd) FILTER (WHERE category='llm'),0)::float AS llm,
           coalesce(sum(cost_usd) FILTER (WHERE category='image'),0)::float AS image
         FROM cost_ledger WHERE occurred_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1 DESC`,
      ),
    ]);
    const body = `<h1>Costs</h1>
<div class="grid">${Object.entries(report)
      .map(([k, v]) => `<div class="card"><h2>${esc(k.replace(/_/g, " "))}</h2><div class="kpi">${usd(v)}</div></div>`)
      .join("")}</div>
<div class="card"><h2>Limits</h2><p>Daily ${usd(c.daily_budget_usd)} (LLM ${usd(c.daily_llm_budget_usd)}, images ${usd(c.daily_image_budget_usd)}) · monthly ${usd(c.monthly_budget_usd)} · max ${c.max_retries_per_image} image retries · ${c.max_posts_per_day} posts/day</p></div>
<div class="grid"><div class="card"><h2>By operation (30d)</h2>${table(["Category", "Operation", "Calls", "USD"], byOp.map((r) => [esc(r.category), esc(r.operation), String(r.n), usd(r.usd)]))}</div>
<div class="card"><h2>Daily</h2>${table(["Day", "LLM", "Images"], daily.map((d) => [esc(d.day), usd(d.llm), usd(d.image)]))}</div></div>`;
    return page(req, reply, "Costs", body);
  });

  // ------------------------------------------------------------ events
  app.get("/admin/events", async (req: Req, reply) => {
    const [events, runs, failures] = await Promise.all([
      many<{ level: string; source: string; message: string; data: unknown; created_at: Date }>("SELECT * FROM system_events ORDER BY id DESC LIMIT 150"),
      many<{ queue: string; job_name: string; status: string; attempt: number; duration_ms: number | null; error: string | null; created_at: Date }>(
        "SELECT * FROM job_runs ORDER BY id DESC LIMIT 60",
      ),
      many<{ job_name: string; n: number; avg_ms: number | null }>(
        `SELECT job_name, count(*) FILTER (WHERE status <> 'completed')::int AS n, avg(duration_ms)::int AS avg_ms FROM job_runs WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`,
      ),
    ]);
    const body = `<h1>Events & jobs</h1>
<div class="card"><h2>Jobs (24h)</h2>${table(["Job", "Failures/retries", "Avg ms"], failures.map((f) => [esc(f.job_name), String(f.n), String(f.avg_ms ?? "—")]))}</div>
<div class="card"><h2>Recent job runs</h2>${table(
      ["When", "Queue", "Job", "Status", "Attempt", "ms", "Error"],
      runs.map((r) => [ago(r.created_at), esc(r.queue), esc(r.job_name), pill(r.status), String(r.attempt), String(r.duration_ms ?? ""), esc(r.error ?? "")]),
    )}</div>
<div class="card"><h2>System events</h2>${table(
      ["When", "Level", "Source", "Message", "Data"],
      events.map((e) => [ago(e.created_at), pill(e.level), esc(e.source), esc(e.message), `<details><summary class="small">data</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details>`]),
    )}</div>`;
    return page(req, reply, "Events", body);
  });

  // ------------------------------------------------------------ controls
  app.get("/admin/controls", async (req: Req, reply) => {
    const c = await getControls(true);
    const fields = Object.entries(controlsSchema.shape).map(([k]) => {
      const v = (c as Record<string, unknown>)[k];
      let input: string;
      if (k === "mode") input = `<select name="mode">${["development", "dry_run", "human_approval", "autonomous"].map((m) => `<option ${m === v ? "selected" : ""}>${m}</option>`).join("")}</select>`;
      else if (typeof v === "boolean") input = `<select name="${k}"><option value="true" ${v ? "selected" : ""}>on</option><option value="false" ${!v ? "selected" : ""}>off</option></select>`;
      else input = `<input name="${k}" value="${esc(v)}" inputmode="decimal" size="8">`;
      return [`<code>${esc(k)}</code>`, input];
    });
    const body = `<h1>Controls</h1><div class="card"><p class="muted small">Changes apply within seconds; no deploy needed. Modes: <b>development</b> (no external writes) · <b>dry_run</b> (full pipeline, nothing sent) · <b>human_approval</b> (everything waits for you) · <b>autonomous</b> (green goes out automatically).</p>
<form method="post" action="/admin/controls">${table(["Control", "Value"], fields)}<p><button class="primary">Save controls</button></p></form></div>`;
    return page(req, reply, "Controls", body);
  });
  app.post("/admin/controls", async (req: Req, reply) => {
    const patch: Record<string, unknown> = {};
    const shape = controlsSchema.shape as Record<string, { def?: unknown }>;
    const current = (await getControls(true)) as Record<string, unknown>;
    for (const [k, raw] of Object.entries(req.body ?? {})) {
      if (!(k in shape)) continue;
      const cur = current[k];
      patch[k] = typeof cur === "boolean" ? raw === "true" : typeof cur === "number" ? Number(raw) : raw;
    }
    try {
      await setControls(patch as Partial<Controls>, reviewer(req));
      return back(reply, "/admin/controls", "Saved");
    } catch (e) {
      return back(reply, "/admin/controls", `Not saved: ${(e as Error).message}`);
    }
  });

  // ------------------------------------------------------------ persona
  app.get("/admin/persona", async (req: Req, reply) => {
    const info = personaInfo();
    const versions = await many<{ hash: string; loaded_at: Date }>("SELECT hash, loaded_at FROM persona_versions ORDER BY id DESC LIMIT 10");
    const p = info.persona;
    const body = `<h1>${esc(p.identity.name)} ${esc(p.identity.handle ?? "")}</h1>
<div class="card"><p>${esc(p.identity.bio)}</p><p class="small"><b>Disclosure:</b> ${esc(p.identity.ai_disclosure)}</p>
<p class="muted small">Active version ${esc(info.hash)} · edit <code>${esc(env().PERSONA_PATH)}</code> and reload; no code changes needed.</p>
<form method="post" action="/admin/persona/reload"><button>Reload persona from file</button></form></div>
<div class="grid"><div class="card"><h2>Visual identity</h2><div class="slides">${p.visual.character.reference_images.map((u) => `<img src="${esc(u)}">`).join("")}</div>
<p class="small">${esc(p.visual.character.appearance)} · ${esc(p.visual.character.hairstyle)}</p></div>
<div class="card"><h2>Versions</h2>${table(["Hash", "Loaded"], versions.map((v) => [`<code>${esc(v.hash)}</code>`, ago(v.loaded_at)]))}</div></div>
<div class="card"><h2>Source</h2><pre>${esc(info.source)}</pre></div>`;
    return page(req, reply, "Persona", body);
  });
  app.post("/admin/persona/reload", async (_req: Req, reply) => {
    try {
      const p = reloadPersona();
      await recordPersonaVersion(p);
      return back(reply, "/admin/persona", `Reloaded ${p.persona.identity.name} (${p.hash}). Workers pick it up on their next restart.`);
    } catch (e) {
      return back(reply, "/admin/persona", `Persona invalid, not loaded: ${(e as Error).message}`);
    }
  });

  // ------------------------------------------------------------ actions
  app.post("/admin/actions/plan", async (_req: Req, reply) => {
    await queue("content").add(JOBS.contentPlan, { manual: true }, { jobId: jobId("plan", "manual", Date.now()), attempts: 1 });
    return back(reply, "/admin", "Content planner queued");
  });
  app.post("/admin/actions/sweep", async (_req: Req, reply) => {
    await queue("maintenance").add(JOBS.sweep, {}, { jobId: jobId("sweep", "manual", Date.now()) });
    return back(reply, "/admin", "Recovery sweep queued");
  });
  app.post("/admin/actions/analytics", async (_req: Req, reply) => {
    await queue("analytics").add(JOBS.analyticsProcess, {}, { jobId: jobId("analytics", "manual", Date.now()) });
    return back(reply, "/admin", "Analytics recompute queued");
  });

  /** Push a synthetic comment/DM through the real pipeline (ingest → worker). */
  app.post("/admin/simulate", async (req: Req, reply) => {
    const acct = await primaryAccount();
    const accountId = acct?.ig_user_id ?? env().INSTAGRAM_ACCOUNT_ID ?? "17840000000000000";
    const username = (req.body?.username || "test_follower").replace(/[^\w.]/g, "").slice(0, 30);
    const senderId = `sim_${username}`;
    const text = String(req.body?.text ?? "").slice(0, 1000);
    const now = Date.now();
    const payload =
      req.body?.kind === "dm"
        ? { object: "instagram", entry: [{ id: accountId, time: Math.floor(now / 1000), messaging: [{ sender: { id: senderId }, recipient: { id: accountId }, timestamp: now, message: { mid: `sim_mid_${now}`, text } }] }] }
        : {
            object: "instagram",
            entry: [{ id: accountId, time: Math.floor(now / 1000), changes: [{ field: "comments", value: { id: `sim_c_${now}`, text, from: { id: senderId, username }, media: { id: "sim_media" } } }] }],
          };
    const raw = JSON.stringify(payload);
    const stored = await storeWebhookEvent("simulated", raw, payload);
    if (stored) await queue("events").add(JOBS.instagramEvent, { webhookEventId: stored.id }, { jobId: jobId("webhook", stored.id) });
    return back(reply, "/admin/conversations", "Simulated interaction queued; refresh in a few seconds");
  });
}
