import type { FastifyInstance } from "fastify";
import { getControls } from "../../config/controls.js";
import { env } from "../../config/env.js";
import { currentInfluencer, influencerId } from "../../context.js";
import { nextPublishTime, schedulePublish } from "../../content/produce.js";
import { cancelSchedule, localLabel, operatorPublish, PUBLISHABLE, zonedToUtc } from "../../content/schedule.js";
import { spendSummary } from "../../cost/ledger.js";
import { many, one, tx } from "../../db/pool.js";
import { storeWebhookEvent } from "../../ingest/webhook.js";
import { primaryAccount } from "../../instagram/accounts.js";
import { forgetUser } from "../../memory/store.js";
import { assessText } from "../../safety/safety.js";
import { persona } from "../../persona/loader.js";
import { JOBS, jobId, queue, queueCounts } from "../../queue/queues.js";
import { listEvents } from "../../calendar/events.js";
import { attempt, consoleRouter, done, isUuid, render, reviewer, type Req } from "../console.js";
import { approveReview, listReviews, rejectReview } from "../reviews.js";
import { action, ago, avatar, bar, button, card, empty, esc, field, header, icon, input, kpi, link, pill, select, table, tabs, textarea, usd } from "../ui/kit.js";

/** Post states in which the operator may still edit slides. */
const EDITABLE = ["awaiting_review", "dry_run", "qc_failed"];

export async function removeSlide(postId: string, position: number): Promise<string> {
  return tx(async (c) => {
    const post = (await c.query<{ status: string }>("SELECT status FROM posts WHERE id = $1 AND influencer_id = $2 FOR UPDATE", [postId, influencerId()])).rows[0];
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
  const own = await one("SELECT 1 FROM interactions WHERE id = $1 AND influencer_id = $2", [id, influencerId()]);
  if (!own) return "Interaction not found";
  const sent = await one("SELECT 1 FROM messages WHERE interaction_id = $1 AND direction = 'out' AND status IN ('sent','sending','pending_review')", [id]);
  if (sent) return "A reply already exists for this interaction";
  const r = await one<{ id: number }>(
    "UPDATE interactions SET status = 'pending', last_error = NULL, updated_at = now() WHERE id = $1 AND status IN ('ignored','failed') RETURNING id",
    [id],
  );
  if (!r) return "Only ignored or failed interactions can be re-run";
  await one("DELETE FROM messages WHERE interaction_id = $1 AND direction = 'out' AND status IN ('failed','rejected','blocked','dry_run')", [id]);
  await queue("conversation").add(JOBS.conversationProcess, { influencerId: influencerId(), interactionId: id }, { jobId: jobId("interaction", id, "rerun", Date.now()) });
  return "Re-run queued; refresh in a few seconds";
}

function localTime(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date());
  } catch {
    return "";
  }
}

export function registerOperate(app: FastifyInstance): void {
  const r = consoleRouter(app);

  // ------------------------------------------------------------ overview
  r.get("/admin", async (req: Req, reply) => {
    const inf = currentInfluencer();
    const id = inf.id;
    const p = persona();
    const [c, spend, counts, acct, pending, posts, warnings, conv, followers, events, week] = await Promise.all([
      getControls(),
      spendSummary(),
      queueCounts().catch(() => ({}) as Record<string, Record<string, number>>),
      primaryAccount(),
      one<{ n: number }>("SELECT count(*)::int AS n FROM safety_reviews WHERE status = 'pending' AND influencer_id = $1", [id]),
      many<{ id: string; status: string; caption: string; created_at: Date; cover: string | null; topic: string | null }>(
        `SELECT p.id, p.status, p.caption, p.created_at, ci.topic,
           (SELECT public_url FROM post_assets pa WHERE pa.post_id = p.id ORDER BY position LIMIT 1) AS cover
         FROM posts p LEFT JOIN content_ideas ci ON ci.id = p.content_idea_id WHERE p.influencer_id = $1 ORDER BY p.created_at DESC LIMIT 6`,
        [id],
      ),
      many<{ level: string; source: string; message: string; created_at: Date }>(
        "SELECT level, source, message, created_at FROM system_events WHERE level IN ('warn','error') AND (influencer_id = $1 OR influencer_id IS NULL) ORDER BY id DESC LIMIT 6",
        [id],
      ),
      one<{ total: number; replied: number; ignored: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'done')::int AS replied, count(*) FILTER (WHERE status = 'ignored')::int AS ignored
         FROM interactions WHERE influencer_id = $1 AND created_at > now() - interval '24 hours'`,
        [id],
      ),
      many<{ day: string; followers: number | null }>("SELECT day::text, followers FROM account_metrics WHERE influencer_id = $1 ORDER BY day DESC LIMIT 8", [id]),
      listEvents(new Date(Date.now() - 86400_000), new Date(Date.now() + 14 * 86400_000)),
      one<{ n: number }>("SELECT count(*)::int AS n FROM posts WHERE influencer_id = $1 AND status = 'published' AND published_at > now() - interval '7 days'", [id]),
    ]);
    const f = followers[0]?.followers ?? null;
    const f7 = followers.at(-1)?.followers ?? null;
    const delta = f !== null && f7 !== null && followers.length > 1 ? f - f7 : null;
    const q = Object.entries(counts).map(([name, n]) => [esc(name), String(n.waiting ?? 0), String(n.active ?? 0), String(n.delayed ?? 0), n.failed ? `<b>${n.failed}</b>` : "0"]);

    const setup: string[] = [];
    if (!acct) setup.push(`Attach an Instagram account — <a href="/admin/persona#instagram">connect</a>`);
    if (c.mode === "development" || c.mode === "dry_run") setup.push(`Mode is <b>${esc(c.mode)}</b>: nothing is sent or published. Switch in <a href="/admin/controls">Controls</a> when ready.`);

    const body = `${header(inf.name, {
      eyebrow: `${p.identity.location} · ${localTime(p.identity.timezone)}`,
      sub: acct ? `@${esc(acct.username ?? acct.ig_user_id)} · ${esc(p.identity.occupation)}` : esc(p.identity.occupation),
      actions: `${action("/admin/actions/plan", "Plan a post now", { icon: "sparkles", variant: "primary" })}${link("Calendar", "/admin/calendar", { icon: "calendar" })}`,
    })}
${setup.length ? `<div class="callout warn">${icon("info")}<div>${setup.map((s) => `<p>${s}</p>`).join("")}</div></div>` : ""}
<div class="kpis">
  ${kpi("Followers", f === null ? "—" : f.toLocaleString("en"), { icon: "users", hint: delta === null ? "daily snapshot at 23:50" : `${delta >= 0 ? "+" : ""}${delta} over ${followers.length - 1}d`, tone: delta && delta > 0 ? "ok" : undefined })}
  ${kpi("Waiting for you", String(pending?.n ?? 0), { icon: "inbox", href: "/admin/reviews", tone: pending?.n ? "warn" : undefined, hint: pending?.n ? "open the review queue" : "nothing to review" })}
  ${kpi("Posted this week", String(week?.n ?? 0), { icon: "image", href: "/admin/posts", hint: `max ${c.max_posts_per_day}/day` })}
  ${kpi("Conversations (24h)", String(conv?.total ?? 0), { icon: "message", href: "/admin/conversations", hint: `${conv?.replied ?? 0} handled · ${conv?.ignored ?? 0} skipped` })}
  <div class="kpi"><div class="kpi-l">${icon("wallet", 16)}<span>Spend today</span></div><div class="kpi-v">${usd(spend.today)}</div>${bar(spend.today, c.daily_budget_usd)}<div class="kpi-h">of ${usd(c.daily_budget_usd)} · month ${usd(spend.month)}</div></div>
</div>
<div class="grid-2">
  <div>
  ${card(
    posts.length
      ? `<div class="thumbs">${posts
          .map(
            (x) =>
              `<a href="/admin/posts/${x.id}">${x.cover ? `<img src="${esc(x.cover)}" alt="${esc(x.topic ?? "post")}" loading="lazy">` : `<div class="empty" style="aspect-ratio:4/5;border:1px dashed var(--line-2);border-radius:12px">${icon("image")}</div>`}<div class="cap"><span>${esc((x.topic ?? x.caption).slice(0, 38))}</span>${pill(x.status)}</div></a>`,
          )
          .join("")}</div>`
      : empty("No posts yet", "Run the planner or wait for the next posting window.", action("/admin/actions/plan", "Plan a post now", { icon: "sparkles" })),
    { title: "Recent posts", actions: link("All posts", "/admin/posts", { small: true, variant: "ghost" }) },
  )}
  ${card(
    `<form method="post" action="/admin/simulate" class="cols">
      ${field("Kind", select("kind", [["comment", "Comment"], ["dm", "Direct message"]], "comment"))}
      ${field("From", input("username", "test_follower"))}
      <div style="grid-column:1/-1">${field("Message", input("text", "Which pair should I get for everyday wear?"), { help: "Runs the full pipeline (classify, memory, reasoning, safety). Recorded, never sent to Instagram." })}</div>
      <div>${button("Run through the agent", { icon: "send" })}</div></form>`,
    { title: "Simulate an interaction" },
  )}
  </div>
  <div>
  ${card(
    events.length
      ? `<ul class="list">${events
          .slice(0, 6)
          .map((e) => `<li>${icon("calendar", 16)}<div><b>${esc(e.title)}</b><div class="meta">${new Date(e.starts_at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · ${esc(e.kind)}${e.influencer_id === null ? " · shared" : ""}</div></div></li>`)
          .join("")}</ul>`
      : empty("Nothing on the calendar", "Add upcoming events and things that happened — the agent uses them for posts and conversations.", link("Open calendar", "/admin/calendar", { small: true })),
    { title: "What's going on", actions: link("Calendar", "/admin/calendar", { small: true, variant: "ghost" }) },
  )}
  ${card(
    warnings.length
      ? `<ul class="list">${warnings.map((w) => `<li>${pill(w.level)}<div><div>${esc(w.message)}</div><div class="meta">${esc(w.source)} · ${ago(w.created_at)}</div></div></li>`).join("")}</ul>`
      : `<p class="muted">${icon("check", 16)} No warnings.</p>`,
    { title: "Warnings & errors", actions: link("Events", "/admin/events", { small: true, variant: "ghost" }) },
  )}
  ${card(table(["Queue", "Waiting", "Active", "Delayed", "Failed"], q, "Redis unreachable"), { title: "Queues (platform)", actions: `${action("/admin/actions/sweep", "Recover stalled", { small: true, icon: "refresh" })}` })}
  </div>
</div>`;
    return render(req, reply, { title: "Overview", active: "overview", body });
  });

  // ------------------------------------------------------------ reviews
  r.get("/admin/reviews", async (req: Req, reply) => {
    const status = req.query.status === "all" ? "all" : "pending";
    const rows = await listReviews(status, 100, influencerId());
    const cards = rows.map((rv) => {
      const p = rv.proposed as Record<string, any>;
      const isPost = rv.subject_type === "post";
      const actionable = rv.status === "pending" && rv.level !== "red";
      const text = isPost ? (p.caption ?? "") : (p.text ?? "");
      return card(
        `<div class="row" style="margin-bottom:8px">${pill(rv.level)} ${pill(rv.status)} <span class="meta">${esc(rv.categories.join(", "))} · ${ago(rv.created_at)}</span></div>
        ${rv.reason ? `<p class="small muted">${esc(rv.reason)}</p>` : ""}
        ${!isPost && p.inbound ? `<div class="quote"><b>@${esc(p.username ?? "")}</b>: ${esc(p.inbound)}</div>` : ""}
        ${isPost ? `<div class="slides">${(p.slides ?? []).map((u: string, i: number) => `<figure><img src="${esc(u)}" alt="Slide ${i + 1}" loading="lazy"></figure>`).join("")}</div>` : ""}
        ${
          actionable
            ? `<form method="post" action="/admin/reviews/${rv.id}/approve">${field(isPost ? "Caption" : "Reply", textarea("text", text, { rows: isPost ? 6 : 3 }), { help: "Edit before approving if needed." })}
               <div class="row">${button(isPost ? "Approve (next window)" : "Approve & send", { variant: isPost ? "default" : "primary", icon: "check" })}${
                 isPost ? `<button class="btn primary" formaction="/admin/posts/${esc(rv.subject_id)}/post-now">${icon("send", 16)}<span>Post now</span></button>${link("Schedule…", `/admin/posts/${esc(rv.subject_id)}#publish`, { variant: "ghost", icon: "calendar" })}` : ""
               }</div></form>
               <form method="post" action="/admin/reviews/${rv.id}/reject" class="row" style="margin-top:10px"><input name="note" placeholder="Reason (optional)" aria-label="Rejection reason" style="max-width:320px">${button("Reject", { variant: "danger", icon: "x" })}</form>`
            : `<pre>${esc(text)}</pre>`
        }`,
        { title: isPost ? "Post" : `Reply (${esc(String(p.channel ?? "comment"))})` },
      );
    });
    const body = `${header("Review queue", { sub: "Everything the agent wants a human to check. Red items are never automated." })}
${tabs([
  { href: "/admin/reviews", label: "Pending", active: status === "pending" },
  { href: "/admin/reviews?status=all", label: "All", active: status === "all" },
])}
${cards.join("") || card(empty("Nothing waiting", "The agent is handling things on its own."))}`;
    return render(req, reply, { title: "Reviews", active: "reviews", body });
  });
  r.post("/admin/reviews/:id/approve", async (req: Req, reply) => {
    const own = await one("SELECT 1 FROM safety_reviews WHERE id = $1 AND influencer_id = $2", [Number(req.params.id), influencerId()]);
    if (!own) return done(req, reply, "/admin/reviews", "Review not found", false);
    const res = await approveReview(Number(req.params.id), reviewer(req), req.body?.text);
    return done(req, reply, "/admin/reviews", res.message, res.ok);
  });
  r.post("/admin/reviews/:id/reject", async (req: Req, reply) => {
    const own = await one("SELECT 1 FROM safety_reviews WHERE id = $1 AND influencer_id = $2", [Number(req.params.id), influencerId()]);
    if (!own) return done(req, reply, "/admin/reviews", "Review not found", false);
    const res = await rejectReview(Number(req.params.id), reviewer(req), req.body?.note || undefined);
    return done(req, reply, "/admin/reviews", res.message, res.ok);
  });

  // ------------------------------------------------------------ posts
  r.get("/admin/posts", async (req: Req, reply) => {
    const filter = req.query.status ?? "all";
    const rows = await many<{ id: string; status: string; media_type: string; caption: string; created_at: Date; published_at: Date | null; scheduled_for: Date | null; score: number | null; cover: string | null; topic: string | null; slides: number }>(
      `SELECT p.id, p.status, p.media_type, p.caption, p.created_at, p.published_at, p.scheduled_for, ci.topic,
         (SELECT score FROM engagement_metrics em WHERE em.post_id = p.id ORDER BY collected_at DESC LIMIT 1) AS score,
         (SELECT public_url FROM post_assets pa WHERE pa.post_id = p.id ORDER BY position LIMIT 1) AS cover,
         (SELECT count(*)::int FROM post_assets pa WHERE pa.post_id = p.id) AS slides
       FROM posts p LEFT JOIN content_ideas ci ON ci.id = p.content_idea_id
       WHERE p.influencer_id = $1 AND ($2 = 'all' OR p.status = $2 OR ($2 = 'attention' AND p.status IN ('awaiting_review','qc_failed','failed','dry_run')))
       ORDER BY p.created_at DESC LIMIT 120`,
      [influencerId(), filter],
    );
    const body = `${header("Posts", { actions: action("/admin/actions/plan", "Plan a post now", { icon: "sparkles", variant: "primary" }) })}
${tabs([
  { href: "/admin/posts", label: "All", active: filter === "all" },
  { href: "/admin/posts?status=published", label: "Published", active: filter === "published" },
  { href: "/admin/posts?status=attention", label: "Needs attention", active: filter === "attention" },
])}
${card(
  rows.length
    ? `<div class="thumbs">${rows
        .map(
          (p) =>
            `<a href="/admin/posts/${p.id}">${p.cover ? `<img src="${esc(p.cover)}" alt="${esc(p.topic ?? "post")}" loading="lazy">` : `<div class="empty" style="aspect-ratio:4/5;border:1px dashed var(--line-2);border-radius:12px">${icon("image")}<span class="small">${esc(p.status)}</span></div>`}
            <div class="cap"><span>${esc((p.topic ?? p.caption).slice(0, 34))}</span>${pill(p.status)}</div>
            <div class="meta">${p.slides > 1 ? `${p.slides} slides · ` : ""}${p.published_at ? `published ${ago(p.published_at)}` : p.status === "approved" && p.scheduled_for ? `scheduled ${esc(localLabel(new Date(p.scheduled_for), persona().identity.timezone))}` : `created ${ago(p.created_at)}`}${p.score !== null ? ` · score ${Number(p.score).toFixed(1)}` : ""}</div></a>`,
        )
        .join("")}</div>`
    : empty("No posts here"),
)}`;
    return render(req, reply, { title: "Posts", active: "posts", body });
  });

  r.get("/admin/posts/:id", async (req: Req, reply) => {
    const id = req.params.id;
    if (!isUuid(id)) return reply.code(404).send("not found");
    const p = await one<Record<string, any>>(
      `SELECT p.*, ci.topic, ci.hook, ci.structure, ci.format, ci.repetition_score, ci.repetition_detail FROM posts p LEFT JOIN content_ideas ci ON ci.id = p.content_idea_id WHERE p.id = $1 AND p.influencer_id = $2`,
      [id, influencerId()],
    );
    if (!p) return reply.code(404).send("not found");
    const [assets, decisions, metrics, attempts, costs] = await Promise.all([
      many<{ position: number; public_url: string | null; prompt: string | null; overlay: any }>("SELECT position, public_url, prompt, overlay FROM post_assets WHERE post_id = $1 ORDER BY position", [id]),
      many<{ agent: string; action: string; reason: string | null; safety_level: string | null; created_at: Date }>(
        "SELECT agent, action, reason, safety_level, created_at FROM agent_decisions WHERE subject_type = 'post' AND subject_id = $1 ORDER BY id",
        [id],
      ),
      many<Record<string, any>>("SELECT * FROM engagement_metrics WHERE post_id = $1 ORDER BY collected_at", [id]),
      many<{ position: number; status: string; provider: string; model: string; credits: number | null; cost_usd: number | null; error: string | null; error_class: string | null; latency_ms: number | null; request_id: string | null }>(
        "SELECT position, status, provider, model, credits, cost_usd::float, error, error_class, latency_ms, request_id FROM generation_attempts WHERE post_id = $1 ORDER BY id",
        [id],
      ),
      one<{ usd: number }>("SELECT coalesce(sum(cost_usd),0)::float AS usd FROM cost_ledger WHERE ref_type = 'post' AND ref_id = $1", [id]),
    ]);
    const tz = persona().identity.timezone;
    const acct = await primaryAccount();
    const canPublish = PUBLISHABLE.includes(p.status) && !p.ig_media_id && assets.length > 0 && p.safety_level !== "red";
    const scheduled = p.status === "approved" && p.scheduled_for && new Date(p.scheduled_for).getTime() > Date.now() + 60_000;
    const ctl = await getControls();
    const defaultAt = (() => {
      const q = 15 * 60_000;
      const next = nextPublishTime(new Date(Math.ceil((Date.now() + 60 * 60_000) / q) * q), ctl, tz);
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(next).map((x) => [x.type, x.value]));
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    })();
    const publishBar = canPublish
      ? card(
          `${scheduled ? `<div class="callout ok" style="margin-bottom:12px">${icon("calendar")}<p>Scheduled for <b>${esc(localLabel(new Date(p.scheduled_for), tz))}</b> (${esc(tz)}).</p></div>` : ""}
          <div class="row" style="align-items:flex-end;gap:12px">
            ${action(`/admin/posts/${id}/post-now`, "Post now", { variant: "primary", icon: "send", confirm: `Publish this post to ${acct ? `@${acct.username ?? acct.ig_user_id}` : "Instagram"} right now?` })}
            <form method="post" action="/admin/posts/${id}/schedule" class="row" style="align-items:flex-end">
              <div class="field" style="margin:0"><label for="sched-at">Schedule for <span class="meta">(${esc(tz)})</span></label><input id="sched-at" type="datetime-local" name="at" value="${esc(defaultAt)}" required style="width:auto"></div>
              ${button(scheduled ? "Reschedule" : "Schedule", { icon: "calendar" })}
            </form>
            ${scheduled ? action(`/admin/posts/${id}/unschedule`, "Unschedule", { variant: "ghost", icon: "x" }) : ""}
          </div>
          <p class="help" style="margin-top:8px">Your choice wins over the posting window${ctl.mode === "dry_run" ? " and dry-run mode" : ""}. RED posts are never published.</p>`,
          { title: "Publish", id: "publish" },
        )
      : "";
    const actions = [
      ["awaiting_review", "dry_run"].includes(p.status) ? action(`/admin/posts/${id}/approve`, "Approve (next window)", { icon: "check", variant: "ghost" }) : "",
      ["qc_failed", "failed"].includes(p.status) && !p.ig_media_id ? action(`/admin/posts/${id}/retry`, "Retry production", { icon: "refresh" }) : "",
      !["published", "rejected"].includes(p.status) ? action(`/admin/posts/${id}/reject`, "Reject", { variant: "danger", icon: "x", confirm: "Reject this post?" }) : "",
      p.permalink ? link("Open on Instagram", p.permalink, { external: true }) : "",
    ].join("");
    const body = `${header(p.topic ?? "Post", {
      eyebrow: `${esc(p.format ?? "")} / ${esc(p.structure ?? "")}`,
      sub: `${pill(p.status)} ${pill(p.safety_level)} <span class="meta">repetition ${p.repetition_score ?? "—"} · cost ${usd(costs?.usd)} · created ${ago(p.created_at)}</span>`,
      actions,
    })}
${p.last_error ? `<div class="callout bad">${icon("alert")}<p>${esc(p.last_error)}</p></div>` : ""}
${publishBar}
${card(
  `<div class="slides">${
    assets
      .map((a) =>
        a.public_url
          ? `<figure><img src="${esc(a.public_url)}" alt="${esc(a.overlay?.alt_text ?? `Slide ${a.position + 1}`)}"><figcaption><span>Slide ${a.position + 1}</span>${
              EDITABLE.includes(p.status) && assets.length > 1 ? action(`/admin/posts/${id}/slides/${a.position}/remove`, "Remove", { variant: "danger", small: true, icon: "trash", confirm: `Remove slide ${a.position + 1}?` }) : ""
            }</figcaption></figure>`
          : "",
      )
      .join("") || `<span class="muted">Not generated yet</span>`
  }</div>`,
  { title: "Slides" },
)}
<div class="grid">
${card(`<pre>${esc(p.caption)}</pre><p class="meta" style="margin-top:8px">Hook: ${esc(p.hook ?? "")}</p>`, { title: "Caption" })}
${card(
  table(
    ["Checkpoint", "Reach", "Likes", "Comments", "Saves", "Shares", "Follows", "Score"],
    metrics.map((m) => [esc(m.checkpoint), m.reach ?? "—", m.likes ?? "—", m.comments ?? "—", m.saves ?? "—", m.shares ?? "—", m.follows ?? "—", m.score ?? "—"].map(String)),
    "Collected 24h, 72h and 7d after publishing.",
  ),
  { title: "Engagement" },
)}
</div>
${card(
  table(
    ["Slide", "Status", "Provider / model", "Cost", "Latency", "Error"],
    attempts.map((j) => [
      j.position === null ? "—" : String(j.position + 1),
      pill(j.status),
      `${esc(j.provider)} / <code>${esc(j.model)}</code>`,
      j.cost_usd !== null ? usd(j.cost_usd) : j.credits !== null ? `${j.credits} cr` : "—",
      j.latency_ms ? `${Math.round(j.latency_ms / 1000)}s` : "—",
      j.error ? `${j.error_class ? pill(j.error_class) : ""} <span class="small">${esc(j.error.slice(0, 160))}</span>` : "",
    ]),
  ),
  { title: "Generation attempts", actions: link("Engine jobs", "/admin/generation/requests", { small: true, variant: "ghost" }) },
)}
${card(
  table(
    ["Agent", "Action", "Safety", "Reason", "When"],
    decisions.map((d) => [esc(d.agent), esc(d.action), pill(d.safety_level), esc(d.reason ?? ""), ago(d.created_at)]),
  ),
  { title: "Decision trail" },
)}
${card(
  `<pre>${esc(JSON.stringify(p.visual_state, null, 2))}</pre>${assets.map((a) => `<details><summary>Slide ${a.position + 1} prompt</summary><pre>${esc(a.prompt ?? "")}</pre></details>`).join("")}${
    p.repetition_detail ? `<details><summary>Repetition detail</summary><pre>${esc(JSON.stringify(p.repetition_detail, null, 2))}</pre></details>` : ""
  }`,
  { title: "Visual state & prompts" },
)}`;
    return render(req, reply, { title: "Post", active: "posts:detail", body });
  });

  r.post("/admin/posts/:id/slides/:pos/remove", async (req: Req, reply) => done(req, reply, `/admin/posts/${req.params.id}`, await removeSlide(req.params.id, Number(req.params.pos))));

  r.post("/admin/posts/:id/approve", async (req: Req, reply) => {
    const id = req.params.id;
    const to = `/admin/posts/${id}`;
    const review = await one<{ id: number }>("SELECT id FROM safety_reviews WHERE subject_type = 'post' AND subject_id = $1 AND status = 'pending' AND influencer_id = $2", [id, influencerId()]);
    if (review) {
      const res = await approveReview(review.id, reviewer(req));
      return done(req, reply, to, res.message, res.ok);
    }
    const post = await one<{ status: string; safety_level: string | null }>("SELECT status, safety_level FROM posts WHERE id = $1 AND influencer_id = $2", [id, influencerId()]);
    if (!post || !["awaiting_review", "dry_run"].includes(post.status)) return done(req, reply, to, "Post is not awaiting approval", false);
    if (post.safety_level === "red") return done(req, reply, to, "RED posts cannot be approved", false);
    await one("UPDATE posts SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [id, reviewer(req)]);
    const at = await schedulePublish(id, await getControls(), persona());
    return done(req, reply, to, `Approved; publishing ${at.getTime() <= Date.now() + 60_000 ? "now" : `at ${at.toISOString()}`}`);
  });
  r.post("/admin/posts/:id/post-now", async (req: Req, reply) => {
    // From a review card the (possibly edited) caption comes along; apply it first, never if it turns RED.
    const edited = String(req.body?.text ?? "").trim();
    if (edited) {
      const a = await assessText(edited, { direction: "outbound", skipLlm: true });
      if (a.level === "red") return done(req, reply, `/admin/posts/${req.params.id}`, `Edited caption is red: ${a.categories.join(", ")}`, false);
      await one("UPDATE posts SET caption = $2 WHERE id = $1 AND influencer_id = $3 AND ig_media_id IS NULL", [req.params.id, edited, influencerId()]);
    }
    const res = await operatorPublish(req.params.id, "now", reviewer(req));
    return done(req, reply, `/admin/posts/${req.params.id}`, res.message, res.ok);
  });
  r.post("/admin/posts/:id/schedule", async (req: Req, reply) =>
    attempt(req, reply, `/admin/posts/${req.params.id}`, async () => {
      const at = zonedToUtc(String(req.body?.at ?? ""), persona().identity.timezone);
      const res = await operatorPublish(req.params.id, at, reviewer(req));
      if (!res.ok) throw new Error(res.message);
      return res.message;
    }),
  );
  r.post("/admin/posts/:id/unschedule", async (req: Req, reply) => {
    const res = await cancelSchedule(req.params.id, reviewer(req));
    return done(req, reply, `/admin/posts/${req.params.id}`, res.message, res.ok);
  });
  r.post("/admin/posts/:id/publish", async (req: Req, reply) => {
    const id = req.params.id;
    const ok = await one("UPDATE posts SET status = 'approved', last_error = NULL WHERE id = $1 AND influencer_id = $2 AND status IN ('approved','failed') AND ig_media_id IS NULL RETURNING id", [id, influencerId()]);
    if (!ok) return done(req, reply, `/admin/posts/${id}`, "Only approved or failed posts can be published", false);
    await queue("publish").add(JOBS.postPublish, { influencerId: influencerId(), postId: id }, { jobId: jobId("publish", id, "manual", Date.now()) });
    return done(req, reply, `/admin/posts/${id}`, "Publishing queued");
  });
  // Re-run production for a failed post; slides that already passed are kept.
  r.post("/admin/posts/:id/retry", async (req: Req, reply) => {
    const id = req.params.id;
    const row = await one<{ id: string }>(
      "UPDATE posts SET status = 'draft', last_error = NULL, updated_at = now() WHERE id = $1 AND influencer_id = $2 AND status IN ('qc_failed','failed') AND ig_media_id IS NULL RETURNING id",
      [id, influencerId()],
    );
    if (!row) return done(req, reply, `/admin/posts/${id}`, "Only failed posts can be retried", false);
    await one("UPDATE content_ideas SET status = 'accepted', updated_at = now() WHERE id = (SELECT content_idea_id FROM posts WHERE id = $1)", [id]);
    await queue("content").add(JOBS.contentProduce, { influencerId: influencerId(), postId: id }, { jobId: jobId("produce", id, "retry", Date.now()) });
    return done(req, reply, `/admin/posts/${id}`, "Production restarted");
  });
  r.post("/admin/posts/:id/reject", async (req: Req, reply) => {
    const id = req.params.id;
    const review = await one<{ id: number }>("SELECT id FROM safety_reviews WHERE subject_type = 'post' AND subject_id = $1 AND status = 'pending' AND influencer_id = $2", [id, influencerId()]);
    if (review) await rejectReview(review.id, reviewer(req), "rejected from post page");
    else await one("UPDATE posts SET status = 'rejected', reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND influencer_id = $3 AND status NOT IN ('published','publishing')", [id, reviewer(req), influencerId()]);
    return done(req, reply, `/admin/posts/${id}`, "Rejected");
  });

  // ------------------------------------------------------------ content brain
  r.get("/admin/content", async (req: Req, reply) => {
    const id = influencerId();
    const [activities, ideas, learnings, requests, recaps] = await Promise.all([
      many<{ day: string; slot: string; activity: string; location: string | null; decision: string; reason: string | null }>(
        "SELECT day::text, slot, activity, location, decision, reason FROM activities WHERE influencer_id = $1 AND day >= (now() - interval '2 days')::date ORDER BY day DESC, id",
        [id],
      ),
      many<{ status: string; format: string; structure: string; topic: string; hook: string; repetition_score: number | null; reject_reason: string | null; created_at: Date }>(
        "SELECT status, format, structure, topic, hook, repetition_score, reject_reason, created_at FROM content_ideas WHERE influencer_id = $1 ORDER BY id DESC LIMIT 40",
        [id],
      ),
      many<{ dimension: string; value: string; samples: number; mean_score: number }>("SELECT * FROM learnings WHERE influencer_id = $1 ORDER BY dimension, mean_score DESC", [id]),
      many<{ content: string; updated_at: Date }>("SELECT content, updated_at FROM memories WHERE influencer_id = $1 AND layer = 'world' AND kind = 'content_request' AND status = 'active' ORDER BY updated_at DESC LIMIT 20", [id]),
      many<{ content: string; updated_at: Date }>("SELECT content, updated_at FROM memories WHERE influencer_id = $1 AND layer = 'world' AND kind = 'calendar_recap' AND status = 'active' ORDER BY updated_at DESC LIMIT 10", [id]),
    ]);
    const body = `${header("Content brain", { sub: "How the agent decides what to post: the virtual day, ideas it considered, what performed, and what it remembers." })}
${card(
  table(
    ["Day", "Slot", "Activity", "Location", "Decision", "Why"],
    activities.map((a) => [esc(a.day), esc(a.slot.replace("_", " ")), esc(a.activity), esc(a.location ?? ""), pill(a.decision), `<span class="small">${esc(a.reason ?? "")}</span>`]),
    "The day plan is created the first time the planner runs each day.",
  ),
  { title: "Virtual day" },
)}
${card(
  table(
    ["Status", "Format", "Topic", "Hook", "Repetition", "Note", "When"],
    ideas.map((i) => [pill(i.status), `${esc(i.format)}/${esc(i.structure)}`, esc(i.topic), `<span class="small">${esc(i.hook)}</span>`, i.repetition_score?.toFixed(2) ?? "—", `<span class="small">${esc(i.reject_reason ?? "")}</span>`, ago(i.created_at)]),
  ),
  { title: "Ideas" },
)}
<div class="grid">
${card(table(["Dimension", "Value", "Posts", "Mean"], learnings.map((l) => [esc(l.dimension), esc(l.value), String(l.samples), l.mean_score.toFixed(2)]), "Appears once posts have 24h of insights."), { title: "Learnings" })}
${card(table(["Request", "When"], requests.map((q) => [esc(q.content), ago(q.updated_at)]), "Follower requests show up here."), { title: "Follower requests" })}
${card(table(["Memory", "When"], recaps.map((q) => [esc(q.content), ago(q.updated_at)]), "Calendar events with an outcome become memories."), { title: "Lived experiences (from the calendar)" })}
</div>`;
    return render(req, reply, { title: "Content brain", active: "content", body });
  });

  // ------------------------------------------------------------ conversations
  r.get("/admin/conversations", async (req: Req, reply) => {
    const rows = await many<{ id: number; kind: string; status: string; sender_username: string | null; text: string; occurred_at: Date; reply: string | null; reply_status: string | null; action: string | null; reason: string | null; intent: string | null; user_id: number | null }>(
      `SELECT i.id, i.kind, i.status, i.sender_username, i.text, i.occurred_at,
         m.text AS reply, m.status AS reply_status, d.action, d.reason, d.intent, u.id AS user_id
       FROM interactions i
       LEFT JOIN LATERAL (SELECT text, status FROM messages WHERE interaction_id = i.id AND direction = 'out' ORDER BY id DESC LIMIT 1) m ON true
       LEFT JOIN LATERAL (SELECT action, reason, intent FROM agent_decisions WHERE subject_type = 'interaction' AND subject_id = i.id::text AND agent = 'conversation_agent' ORDER BY id DESC LIMIT 1) d ON true
       LEFT JOIN ig_users u ON u.ig_scoped_id = i.sender_ig_id AND u.influencer_id = i.influencer_id
       WHERE i.influencer_id = $1 ORDER BY i.id DESC LIMIT 80`,
      [influencerId()],
    );
    const body = `${header("Conversations", { sub: "Every comment and DM, what the agent understood, and what it did." })}
${card(
  table(
    ["When", "From", "Message", "Understood / did", "Reply", "Status"],
    rows.map((x) => [
      `<span class="meta">${ago(x.occurred_at)}</span><br>${pill(x.kind)}`,
      x.user_id ? `<a href="/admin/people/${x.user_id}">@${esc(x.sender_username ?? "?")}</a>` : `@${esc(x.sender_username ?? "?")}`,
      esc(x.text),
      `${esc(x.intent ?? "")} <code>${esc(x.action ?? "")}</code><div class="meta">${esc(x.reason ?? "")}</div>`,
      x.reply ? `${esc(x.reply)}<div>${pill(x.reply_status)}</div>` : "—",
      `${pill(x.status)}${["ignored", "failed"].includes(x.status) && !x.reply ? `<div style="margin-top:6px">${action(`/admin/interactions/${x.id}/rerun`, "Re-run", { small: true, icon: "refresh" })}</div>` : ""}`,
    ]),
    "No conversations yet. Simulate one from the Overview.",
  ),
)}`;
    return render(req, reply, { title: "Conversations", active: "conversations", body });
  });
  r.post("/admin/interactions/:id/rerun", async (req: Req, reply) => done(req, reply, "/admin/conversations", await rerunInteraction(Number(req.params.id))));

  // ------------------------------------------------------------ people & memory
  r.get("/admin/people", async (req: Req, reply) => {
    const rows = await many<{ id: number; username: string | null; interaction_count: number; last_interaction_at: Date; trust: string; relationship_summary: string | null; memories: number }>(
      `SELECT u.*, (SELECT count(*)::int FROM memories m WHERE m.ig_user_id = u.id AND m.status = 'active') AS memories
       FROM ig_users u WHERE u.influencer_id = $1 ORDER BY last_interaction_at DESC LIMIT 200`,
      [influencerId()],
    );
    const body = `${header("People & memory", { sub: "Everyone this influencer has talked to, and what it remembers about them." })}
${card(
  table(
    ["Person", "Interactions", "Memories", "Trust", "Summary", "Last seen"],
    rows.map((u) => [`<a href="/admin/people/${u.id}">@${esc(u.username ?? u.id)}</a>`, String(u.interaction_count), String(u.memories), pill(u.trust), `<span class="small">${esc(u.relationship_summary ?? "")}</span>`, ago(u.last_interaction_at)]),
    "Nobody yet.",
  ),
)}`;
    return render(req, reply, { title: "People", active: "people", body });
  });
  r.get("/admin/people/:id", async (req: Req, reply) => {
    const id = Number(req.params.id);
    const u = await one<Record<string, any>>("SELECT * FROM ig_users WHERE id = $1 AND influencer_id = $2", [id, influencerId()]);
    if (!u) return reply.code(404).send("not found");
    const [mems, msgs] = await Promise.all([
      many<{ kind: string; content: string; confidence: number; status: string; expires_at: Date | null; source_type: string; source_id: string | null }>(
        "SELECT * FROM memories WHERE ig_user_id = $1 AND influencer_id = $2 ORDER BY status, updated_at DESC",
        [id, influencerId()],
      ),
      many<{ direction: string; channel: string; text: string; status: string; created_at: Date }>(
        `SELECT m.direction, m.channel, m.text, m.status, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.ig_user_id = $1 AND c.influencer_id = $2 ORDER BY m.id DESC LIMIT 40`,
        [id, influencerId()],
      ),
    ]);
    const body = `${header(`@${u.username ?? u.ig_scoped_id}`, {
      sub: `First seen ${ago(u.first_interaction_at)} · ${u.interaction_count} interactions · interests: ${esc((u.known_interests ?? []).join(", ") || "—")}`,
      actions: `<form method="post" action="/admin/people/${id}/trust" class="row">${select("trust", ["normal", "vip", "muted", "blocked"], u.trust, 'aria-label="Trust level" style="width:auto"')}${button("Set trust", { small: true })}</form>${action(`/admin/people/${id}/forget`, "Forget this person", { variant: "danger", icon: "trash", confirm: "Delete everything the agent remembers about this person?" })}`,
    })}
${card(`<p>${esc(u.relationship_summary ?? "No summary yet.")}</p>`, { title: "Relationship" })}
${card(table(["Kind", "Memory", "Confidence", "Status", "Expires", "Source"], mems.map((m) => [esc(m.kind), esc(m.content), m.confidence.toFixed(2), pill(m.status), m.expires_at ? ago(m.expires_at) : "never", `<span class="meta">${esc(m.source_type)} ${esc(m.source_id ?? "")}</span>`])), { title: "Memories" })}
${card(table(["When", "", "Channel", "Text", "Status"], msgs.map((m) => [ago(m.created_at), m.direction === "in" ? icon("arrowRight", 14, "incoming") : icon("send", 14, "outgoing"), esc(m.channel), esc(m.text), pill(m.status)])), { title: "Messages" })}`;
    return render(req, reply, { title: "Person", active: "people:detail", body });
  });
  r.post("/admin/people/:id/trust", async (req: Req, reply) => {
    const t = req.body?.trust;
    if (!["normal", "vip", "muted", "blocked"].includes(t)) return done(req, reply, `/admin/people/${req.params.id}`, "Invalid trust level", false);
    await one("UPDATE ig_users SET trust = $2, updated_at = now() WHERE id = $1 AND influencer_id = $3", [Number(req.params.id), t, influencerId()]);
    return done(req, reply, `/admin/people/${req.params.id}`, `Trust set to ${t}`);
  });
  r.post("/admin/people/:id/forget", async (req: Req, reply) => {
    const own = await one("SELECT 1 FROM ig_users WHERE id = $1 AND influencer_id = $2", [Number(req.params.id), influencerId()]);
    if (!own) return done(req, reply, "/admin/people", "Not found", false);
    return done(req, reply, `/admin/people/${req.params.id}`, `Deleted ${await forgetUser(Number(req.params.id))} memories`);
  });

  // ------------------------------------------------------------ actions
  r.post("/admin/actions/plan", async (req: Req, reply) => {
    await queue("content").add(JOBS.contentPlan, { influencerId: influencerId(), manual: true }, { jobId: jobId("plan", influencerId(), "manual", Date.now()), attempts: 1 });
    return done(req, reply, "/admin", "Content planner queued");
  });
  r.post("/admin/actions/sweep", async (req: Req, reply) => {
    await queue("maintenance").add(JOBS.sweep, {}, { jobId: jobId("sweep", "manual", Date.now()) });
    return done(req, reply, "/admin", "Recovery sweep queued");
  });
  r.post("/admin/actions/analytics", async (req: Req, reply) => {
    await queue("analytics").add(JOBS.analyticsProcess, {}, { jobId: jobId("analytics", "manual", Date.now()) });
    return done(req, reply, "/admin", "Analytics recompute queued");
  });

  /** Push a synthetic comment/DM through the real pipeline (ingest → worker) for the selected influencer. */
  r.post("/admin/simulate", async (req: Req, reply) =>
    attempt(req, reply, "/admin/conversations", async () => {
      const acct = await primaryAccount();
      const accountId = acct?.ig_user_id ?? (influencerId() === 1 ? env().INSTAGRAM_ACCOUNT_ID : undefined);
      if (!accountId) throw new Error("attach an Instagram account first (simulations are routed by account)");
      const username = (req.body?.username || "test_follower").replace(/[^\w.]/g, "").slice(0, 30);
      const senderId = `sim_${username}`;
      const text = String(req.body?.text ?? "").slice(0, 1000);
      const now = Date.now();
      const payload =
        req.body?.kind === "dm"
          ? { object: "instagram", entry: [{ id: accountId, time: Math.floor(now / 1000), messaging: [{ sender: { id: senderId }, recipient: { id: accountId }, timestamp: now, message: { mid: `sim_mid_${now}`, text } }] }] }
          : { object: "instagram", entry: [{ id: accountId, time: Math.floor(now / 1000), changes: [{ field: "comments", value: { id: `sim_c_${now}`, text, from: { id: senderId, username }, media: { id: "sim_media" } } }] }] };
      const stored = await storeWebhookEvent("simulated", JSON.stringify(payload), payload);
      if (stored) await queue("events").add(JOBS.instagramEvent, { webhookEventId: stored.id }, { jobId: jobId("webhook", stored.id) });
      return "Simulated interaction queued; refresh in a few seconds";
    }),
  );
  void avatar;
}
