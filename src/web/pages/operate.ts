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
import { deletePost, editCaption, EDITABLE, editStoryText, moveSlide, removeSlide } from "../../content/edit.js";
import { recentStories } from "../../content/stories.js";
import { createButton, directLink, storyButton } from "./create.js";
import { persona } from "../../persona/loader.js";
import { JOBS, jobId, queue, queueCounts } from "../../queue/queues.js";
import { listEvents } from "../../calendar/events.js";
import { attempt, consoleRouter, done, isTenant, isUuid, render, reviewer, type Req } from "../console.js";
import { approveReview, listReviews, rejectReview } from "../reviews.js";
import { action, ago, bar, button, card, empty, esc, field, header, icon, input, kpi, link, pill, select, table, tabs, textarea, usd } from "../ui/kit.js";

/** Slide tools for one image: move left/right, make cover, remove. */
function slideTools(id: string, pos: number, count: number): string {
  const move = (to: number, label: string, ico: string, title: string) =>
    `<form method="post" action="/admin/posts/${id}/slides/${pos}/move"><input type="hidden" name="to" value="${to}"><button class="btn sm ghost" type="submit" title="${esc(title)}" aria-label="${esc(title)}">${icon(ico, 14)}${label ? `<span>${label}</span>` : ""}</button></form>`;
  return `<span class="slide-tools">${pos > 0 ? move(pos - 1, "", "arrowLeft", `Move slide ${pos + 1} left`) : ""}${pos < count - 1 ? move(pos + 1, "", "arrowRight", `Move slide ${pos + 1} right`) : ""}${
    pos > 0 ? move(0, "", "star", `Make slide ${pos + 1} the cover`) : ""
  }${
    count > 1
      ? `<form method="post" action="/admin/posts/${id}/slides/${pos}/remove" data-confirm="Remove slide ${pos + 1}?"><button class="btn sm danger" type="submit" title="Remove slide ${pos + 1}" aria-label="Remove slide ${pos + 1}">${icon("trash", 14)}</button></form>`
      : ""
  }</span>`;
}

const PRIVACY_CHOICES: Array<[string, string]> = [
  ["PUBLIC_TO_EVERYONE", "Everyone"],
  ["FOLLOWER_OF_CREATOR", "Followers"],
  ["MUTUAL_FOLLOW_FRIENDS", "Friends"],
  ["SELF_ONLY", "Only me"],
];

/** TikTok's per-post settings: chosen by the operator before it goes out (TikTok requires an explicit privacy choice). */
function tiktokSettingsCard(id: string, t: Record<string, any>, canEdit: boolean): string {
  const used = t.privacy_used ? `<p class="meta" style="margin-top:8px">Posted as <b>${esc(PRIVACY_CHOICES.find(([k]) => k === t.privacy_used)?.[1] ?? t.privacy_used)}</b>${t.note ? ` · ${esc(t.note)}` : ""}</p>` : "";
  if (!canEdit) {
    return card(
      `<dl class="kv"><dt>Title</dt><dd>${esc(t.title || "—")}</dd><dt>Who can view</dt><dd>${esc(PRIVACY_CHOICES.find(([k]) => k === t.privacy)?.[1] ?? "—")}</dd><dt>Comments</dt><dd>${t.allow_comments === false ? "Off" : "On"}</dd><dt>Promotes own business</dt><dd>${t.promotes_own_business ? "Yes" : "No"}</dd><dt>AI label</dt><dd>On (always)</dd></dl>${used}`,
      { title: "TikTok settings", id: "tiktok" },
    );
  }
  return card(
    `<form method="post" action="/admin/posts/${id}/tiktok-settings">
      ${field("Title", input("title", t.title ?? "", { attrs: 'maxlength="90"' }), { help: "Shown on the photo post; up to 90 characters." })}
      ${field("Who can view", select("privacy", PRIVACY_CHOICES, t.privacy ?? "PUBLIC_TO_EVERYONE"), { help: "Until TikTok audits the app, posts go up as Only me whatever you pick." })}
      <label class="row small" style="margin:6px 0"><input type="checkbox" name="allow_comments" value="1"${t.allow_comments === false ? "" : " checked"}> Allow comments</label>
      <label class="row small" style="margin:6px 0"><input type="checkbox" name="promotes_own_business" value="1"${t.promotes_own_business ? " checked" : ""}> Promotes the influencer's own business: shown as promotional content</label>
      <label class="row small muted" style="margin:6px 0 12px"><input type="checkbox" checked disabled> AI-generated label (always on)</label>
      ${button("Save TikTok settings", { icon: "check" })}</form>${used}`,
    { title: "TikTok settings", id: "tiktok" },
  );
}

/** Live character count for the caption editor (progressive enhancement). */
const CAPTION_JS = `<script>document.querySelectorAll("[data-count]").forEach(function(t){var o=document.getElementById(t.dataset.count),max=+t.getAttribute("maxlength")||2200;function u(){var n=t.value.length,tags=(t.value.match(/#[\\p{L}\\p{N}_]+/gu)||[]).length;o.textContent=n+" / "+max+" characters · "+tags+" hashtags";o.classList.toggle("over",n>max||tags>30)}t.addEventListener("input",u);u()})</script>`;

/** Why a post can't be published yet, and the one action that unblocks it. */
export function publishBlocker(status: string, slides: number, safety: string | null, published: boolean): { reason: string } {
  if (published) return { reason: "Already on Instagram." };
  if (safety === "red") return { reason: "The safety check marked this post RED; it is never published." };
  if (status === "rejected") return { reason: "This post was rejected." };
  if (["draft", "generating", "composing"].includes(status)) return { reason: "Images are still being made; the buttons appear when they're ready." };
  if (status === "publishing") return { reason: "Publishing is in progress." };
  if (!slides) return { reason: "No images yet: production stopped before any were made. Use Retry production above, or Create a post now." };
  return { reason: `A ${status.replace("_", " ")} post can't be published.` };
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

/** A reel on the post page: the video itself (cover as poster), its length, and the cover on its own. */
function reelView(assets: Array<{ public_url: string | null; media_kind: "image" | "video"; duration_s: string | null; overlay: { alt_text?: string } | null }>): string {
  const video = assets.find((a) => a.media_kind === "video" && a.public_url);
  const cover = assets.find((a) => a.media_kind === "image" && a.public_url);
  if (!video) return `<span class="muted">Not made yet</span>`;
  return `<div class="slides story"><figure><video src="${esc(video.public_url!)}"${cover ? ` poster="${esc(cover.public_url!)}"` : ""} controls playsinline preload="metadata" aria-label="${esc(video.overlay?.alt_text ?? "Reel")}"></video><figcaption><span>9:16 reel${video.duration_s ? ` · ${Math.round(Number(video.duration_s))}s` : ""}</span></figcaption></figure>${
    cover ? `<figure><img src="${esc(cover.public_url!)}" alt="Reel cover"><figcaption><span class="slide-cover">${icon("star", 12)}Cover</span></figcaption></figure>` : ""
  }</div>`;
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
           (SELECT public_url FROM post_assets pa WHERE pa.post_id = p.id ORDER BY (pa.media_kind = 'video'), position LIMIT 1) AS cover
         FROM posts p LEFT JOIN content_ideas ci ON ci.id = p.content_idea_id WHERE p.influencer_id = $1 AND p.media_type <> 'STORY' ORDER BY p.created_at DESC LIMIT 6`,
        [id],
      ),
      many<{ level: string; source: string; message: string; created_at: Date }>(
        "SELECT level, source, message, created_at FROM system_events WHERE level IN ('warn','error') AND influencer_id = $1 ORDER BY id DESC LIMIT 6",
        [id],
      ),
      one<{ total: number; replied: number; ignored: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'done')::int AS replied, count(*) FILTER (WHERE status = 'ignored')::int AS ignored
         FROM interactions WHERE influencer_id = $1 AND created_at > now() - interval '24 hours'`,
        [id],
      ),
      many<{ day: string; followers: number | null }>("SELECT day::text, followers FROM account_metrics WHERE influencer_id = $1 ORDER BY day DESC LIMIT 8", [id]),
      listEvents(new Date(Date.now() - 86400_000), new Date(Date.now() + 14 * 86400_000)),
      one<{ n: number }>("SELECT count(*)::int AS n FROM posts WHERE influencer_id = $1 AND media_type <> 'STORY' AND status = 'published' AND published_at > now() - interval '7 days'", [id]),
    ]);
    const live = acct?.profile && typeof (acct.profile as { followers_count?: number }).followers_count === "number" ? (acct.profile as { followers_count: number }).followers_count : null;
    const f = live ?? followers[0]?.followers ?? null;
    const f7 = followers.at(-1)?.followers ?? null;
    const delta = f !== null && f7 !== null && followers.length > 1 ? f - f7 : null;
    const q = Object.entries(counts).map(([name, n]) => [esc(name), String(n.waiting ?? 0), String(n.active ?? 0), String(n.delayed ?? 0), n.failed ? `<b>${n.failed}</b>` : "0"]);

    const setup: string[] = [];
    if (!acct) setup.push(`Attach an Instagram account — <a href="/admin/persona#instagram">connect</a>`);
    if (c.mode === "development" || c.mode === "dry_run") setup.push(`Mode is <b>${esc(c.mode)}</b>: nothing is sent or published. Switch in <a href="/admin/controls">Controls</a> when ready.`);

    const body = `${header(inf.name, {
      eyebrow: `${p.identity.location} · ${localTime(p.identity.timezone)}`,
      sub: acct ? `@${esc(acct.username ?? acct.ig_user_id)} · ${esc(p.identity.occupation)}` : esc(p.identity.occupation),
      actions: `${createButton()}${storyButton()}${directLink()}${link("Calendar", "/admin/calendar", { icon: "calendar" })}`,
    })}
${setup.length ? `<div class="callout warn">${icon("info")}<div>${setup.map((s) => `<p>${s}</p>`).join("")}</div></div>` : ""}
<div class="kpis">
  ${kpi("Followers", f === null ? "—" : f.toLocaleString("en"), { icon: "users", hint: delta === null ? "synced hourly from Instagram" : `${delta >= 0 ? "+" : ""}${delta} over ${followers.length - 1}d`, tone: delta && delta > 0 ? "ok" : undefined })}
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
      : empty("No posts yet", "Create one now to see this influencer in action, or wait for the next posting window.", createButton()),
    { title: "Recent posts", actions: link("All posts", "/admin/posts", { small: true, variant: "ghost" }) },
  )}
  ${card(
    `<form method="post" action="/admin/simulate" class="cols">
      ${field("Kind", select("kind", [["comment", "Comment"], ["dm", "Direct message"]], "comment"))}
      ${field("From", input("username", "test_follower"))}
      <div style="grid-column:1/-1">${field("Message", input("text", persona().brand?.curiosity_hooks[0] ?? "love this! what are you up to today?"), { help: "Runs the full pipeline (classify, memory, reasoning, safety). Recorded, never sent to Instagram." })}</div>
      <div>${button("Run through the agent", { icon: "send" })}</div></form>`,
    { title: "Simulate an interaction" },
  )}
  </div>
  <div>
  ${card(
    events.length
      ? `<ul class="list">${events
          .slice(0, 6)
          .map((e) => `<li>${icon("calendar", 16)}<div><b>${esc(e.title)}</b><div class="meta">${new Date(e.starts_at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: p.identity.timezone })} · ${esc(e.kind)}${e.influencer_id === null ? " · shared" : ""}</div></div></li>`)
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
  ${isTenant(req) ? "" : card(table(["Queue", "Waiting", "Active", "Delayed", "Failed"], q, "Redis unreachable"), { title: "Queues (platform)", actions: `${action("/admin/actions/sweep", "Recover stalled", { small: true, icon: "refresh" })}` })}
  </div>
</div>`;
    return render(req, reply, { title: "Overview", active: "overview", body });
  });

  // ------------------------------------------------------------ reviews
  r.get("/admin/reviews", async (req: Req, reply) => {
    const status = req.query.status === "all" ? "all" : "pending";
    const rows = await listReviews(status, 100, influencerId());
    // Post reviews show the post as it is now (edits included), not the snapshot taken when the review opened.
    const postIds = rows.filter((rv) => rv.subject_type === "post" && isUuid(rv.subject_id)).map((rv) => rv.subject_id);
    const live = new Map(
      (
        await many<{ id: string; media_type: string; platform: string; caption: string; slides: string[] | null; text: string | null }>(
          `SELECT p.id, p.media_type, p.platform, p.caption,
             (SELECT array_agg(public_url ORDER BY position) FROM post_assets pa WHERE pa.post_id = p.id AND public_url IS NOT NULL) AS slides,
             (SELECT overlay->>'heading' FROM post_assets pa WHERE pa.post_id = p.id AND position = 0) AS text
           FROM posts p WHERE p.id = ANY($1::uuid[])`,
          [postIds],
        )
      ).map((x) => [x.id, x]),
    );
    const cards = rows.map((rv) => {
      const p = rv.proposed as Record<string, any>;
      const isPost = rv.subject_type === "post";
      const now = isPost ? live.get(rv.subject_id) : undefined;
      const isStory = now?.media_type === "STORY";
      const tall = isStory || now?.platform === "tiktok"; // both are 9:16
      const actionable = rv.status === "pending" && rv.level !== "red" && (!isPost || Boolean(now));
      const text = isPost ? (now?.caption ?? p.caption ?? "") : (p.text ?? "");
      const slides: string[] = isPost ? (now?.slides ?? p.slides ?? []) : [];
      return card(
        `<div class="row" style="margin-bottom:8px">${pill(rv.level)} ${pill(rv.status)} <span class="meta">${esc(rv.categories.join(", "))} · ${ago(rv.created_at)}</span></div>
        ${rv.reason ? `<p class="small muted">${esc(rv.reason)}</p>` : ""}
        ${!isPost && p.inbound ? `<div class="quote"><b>@${esc(p.username ?? "")}</b>: ${esc(p.inbound)}</div>` : ""}
        ${isPost ? `<div class="slides${tall ? " story" : ""}">${slides.map((u: string, i: number) => `<figure><img src="${esc(u)}" alt="${isStory ? "Story" : `Slide ${i + 1}`}" loading="lazy"></figure>`).join("")}</div>` : ""}
        ${isPost && now && rv.status === "pending" ? `<p style="margin:8px 0">${link(isStory ? "Edit the story text or delete it" : "Edit caption, reorder or remove slides", `/admin/posts/${esc(rv.subject_id)}`, { small: true, icon: "pencil" })}</p>` : ""}
        ${isPost && !now ? `<p class="muted small">This ${isStory ? "story" : "post"} was deleted.</p>` : ""}
        ${
          actionable
            ? `<form method="post" action="/admin/reviews/${rv.id}/approve">${
                isStory
                  ? `<p class="small">${now?.text ? `Words on the image: <b>${esc(now.text)}</b>` : "No text on this story."} Stories go up without a caption.</p>`
                  : field(isPost ? "Caption" : "Reply", textarea("text", text, { rows: isPost ? 6 : 3 }), { help: "Edit before approving if needed." })
              }
               <div class="row">${button(isPost ? "Approve (next window)" : "Approve & send", { variant: isPost ? "ghost" : "primary", icon: "check" })}${
                 isPost ? `<button class="btn primary" formaction="/admin/posts/${esc(rv.subject_id)}/post-now">${icon("send", 16)}<span>Post now</span></button>${link("Schedule…", `/admin/posts/${esc(rv.subject_id)}#publish`, { variant: "ghost", icon: "calendar" })}` : ""
               }</div></form>
               <form method="post" action="/admin/reviews/${rv.id}/reject" class="row" style="margin-top:10px"><input name="note" placeholder="Reason (optional)" aria-label="Rejection reason" style="max-width:320px">${button("Reject", { variant: "danger", icon: "x" })}</form>`
            : `<pre>${esc(text)}</pre>`
        }`,
        { title: isPost ? (isStory ? "Story" : now?.platform === "tiktok" ? "TikTok post" : "Post") : `Reply (${esc(String(p.channel ?? "comment"))})` },
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
    const rows = await many<{ id: string; status: string; media_type: string; platform: string; caption: string; created_at: Date; published_at: Date | null; scheduled_for: Date | null; score: number | null; cover: string | null; topic: string | null; slides: number }>(
      `SELECT p.id, p.status, p.media_type, p.platform, p.caption, p.created_at, p.published_at, p.scheduled_for, ci.topic,
         (SELECT score FROM engagement_metrics em WHERE em.post_id = p.id ORDER BY collected_at DESC LIMIT 1) AS score,
         (SELECT public_url FROM post_assets pa WHERE pa.post_id = p.id ORDER BY (pa.media_kind = 'video'), position LIMIT 1) AS cover,
         (SELECT count(*)::int FROM post_assets pa WHERE pa.post_id = p.id) AS slides
       FROM posts p LEFT JOIN content_ideas ci ON ci.id = p.content_idea_id
       WHERE p.influencer_id = $1 AND p.media_type <> 'STORY' AND ($2 IN ('all', 'tiktok') OR p.status = $2 OR ($2 = 'attention' AND p.status IN ('awaiting_review','qc_failed','failed','dry_run')))
         AND ($2 <> 'tiktok' OR p.platform = 'tiktok')
       ORDER BY p.created_at DESC LIMIT 120`,
      [influencerId(), filter],
    );
    const body = `${header("Posts", { sub: "Feed posts. Open one to edit its caption, reorder or remove slides, or delete it before it's approved.", actions: `${createButton()}${directLink()}${link("Stories", "/admin/stories", { icon: "phone" })}` })}
${tabs([
  { href: "/admin/posts", label: "All", active: filter === "all" },
  { href: "/admin/posts?status=published", label: "Published", active: filter === "published" },
  { href: "/admin/posts?status=attention", label: "Needs attention", active: filter === "attention" },
  { href: "/admin/posts?status=tiktok", label: "TikTok", active: filter === "tiktok" },
])}
${card(
  rows.length
    ? `<div class="thumbs">${rows
        .map(
          (p) =>
            `<a href="/admin/posts/${p.id}">${p.cover ? `<img src="${esc(p.cover)}" alt="${esc(p.topic ?? "post")}" loading="lazy">` : `<div class="empty" style="aspect-ratio:4/5;border:1px dashed var(--line-2);border-radius:12px">${icon("image")}<span class="small">${esc(p.status)}</span></div>`}
            <div class="cap"><span>${esc((p.topic ?? p.caption).slice(0, 34))}</span>${pill(p.status)}</div>
            <div class="meta">${p.platform === "tiktok" ? "TikTok · " : ""}${p.slides > 1 ? `${p.slides} slides · ` : ""}${p.published_at ? `published ${ago(p.published_at)}` : p.status === "approved" && p.scheduled_for ? `scheduled ${esc(localLabel(new Date(p.scheduled_for), persona().identity.timezone))}` : `created ${ago(p.created_at)}`}${p.score !== null ? ` · score ${Number(p.score).toFixed(1)}` : ""}</div></a>`,
        )
        .join("")}</div>`
    : empty("No posts here"),
)}`;
    return render(req, reply, { title: "Posts", active: "posts", body });
  });

  // ------------------------------------------------------------ stories
  r.get("/admin/stories", async (req: Req, reply) => {
    const [c, rows, today] = await Promise.all([
      getControls(),
      recentStories(40),
      one<{ n: number }>("SELECT count(*)::int AS n FROM posts WHERE influencer_id = $1 AND media_type = 'STORY' AND status = 'published' AND published_at > now() - interval '24 hours'", [influencerId()]),
    ]);
    const tz = persona().identity.timezone;
    const hours = (process.env.STORY_PLAN_CRON ?? "50 9,13,17,20 * * *").split(" ")[1] ?? "";
    const mins = (process.env.STORY_PLAN_CRON ?? "50 9,13,17,20 * * *").split(" ")[0] ?? "0";
    const checks = hours.split(",").filter((h) => /^\d+$/.test(h)).map((h) => `${h.padStart(2, "0")}:${mins.padStart(2, "0")}`).join(", ");
    const body = `${header("Stories", {
      sub: "Light, in-the-moment frames from their day, separate from feed posts. They stop for review like posts do; open one to change its words or delete it.",
      actions: `${storyButton("Create a story now", true)}${directLink("story")}${link("Settings", "/admin/controls", { icon: "sliders", variant: "ghost" })}`,
    })}
${
  c.stories_enabled
    ? `<div class="callout ok">${icon("phone")}<p><b>${today?.n ?? 0} of ${c.stories_per_day}</b> stories in the last 24 hours. The planner checks at ${esc(checks || "set times")} (${esc(tz)}) and posts one when there's something worth sharing, at least ${c.min_hours_between_stories}h apart.</p></div>`
    : `<div class="callout warn">${icon("pause")}<p>Stories are off. Turn them on in <a href="/admin/controls">Controls</a>.</p></div>`
}
${card(
  rows.length
    ? `<div class="thumbs story">${rows
        .map(
          (s) =>
            `<a href="/admin/posts/${s.id}">${s.cover ? `<img src="${esc(s.cover)}" alt="${esc(s.text || s.kind || "story")}" loading="lazy">` : `<div class="empty" style="aspect-ratio:9/16;border:1px dashed var(--line-2);border-radius:12px">${icon("phone")}<span class="small">${esc(s.status)}</span></div>`}
            <div class="cap"><span>${esc(s.kind ?? "story")}</span>${pill(s.status)}</div>
            <div class="meta">${s.text ? `"${esc(s.text.slice(0, 40))}" · ` : ""}${s.published_at ? `up ${ago(s.published_at)}` : s.status === "approved" && s.scheduled_for ? `scheduled ${esc(localLabel(new Date(s.scheduled_for), tz))}` : `made ${ago(s.created_at)}`}</div></a>`,
        )
        .join("")}</div>`
    : empty("No stories yet", "Make one now to see how their stories look.", storyButton("Create a story now", true)),
)}
${card(
  `<ul class="small" style="margin:0;padding-left:18px;display:grid;gap:6px">
    <li>Kinds: a moment from their day, a look, a brand moment (the brand's world in a natural shot; the store line from the business knowledge only on a turn the brand may be named), a trend reaction, or a question followers answer by replying.</li>
    <li>No text on photos of the influencer; words only on shots without them, never with numbers the business knowledge doesn't have.</li>
    <li>Instagram's API can't add link stickers, polls, mentions or music, so the words are part of the image. Replies to a story arrive as DMs and are answered like any DM.</li>
    <li>Stories disappear after 24 hours on Instagram; they stay listed here.</li></ul>`,
  { title: "How stories work" },
)}`;
    return render(req, reply, { title: "Stories", active: "stories", body });
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
      many<{ position: number; public_url: string | null; prompt: string | null; overlay: any; media_kind: "image" | "video"; duration_s: string | null }>("SELECT position, public_url, prompt, overlay, media_kind, duration_s FROM post_assets WHERE post_id = $1 ORDER BY position", [id]),
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
    const canPublish = PUBLISHABLE.includes(p.status) && !p.ig_media_id && assets.length > 0 && assets.every((a) => a.public_url) && p.safety_level !== "red";
    const scheduled = p.status === "approved" && p.scheduled_for && new Date(p.scheduled_for).getTime() > Date.now() + 60_000;
    const ctl = await getControls();
    const defaultAt = (() => {
      const q = 15 * 60_000;
      const next = nextPublishTime(new Date(Math.ceil((Date.now() + 60 * 60_000) / q) * q), ctl, tz);
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(next).map((x) => [x.type, x.value]));
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    })();
    const blocked = publishBlocker(p.status, assets.length, p.safety_level, Boolean(p.ig_media_id));
    const isStory = p.media_type === "STORY";
    const isTikTok = p.platform === "tiktok";
    const noun = isStory ? "story" : isTikTok ? "TikTok post" : "post";
    const tiktokTwin = !isTikTok ? await one<{ id: string; status: string }>("SELECT id, status FROM posts WHERE source_post_id = $1 AND platform = 'tiktok'", [id]) : undefined;
    const tiktokOn = (await getControls()).tiktok_enabled;
    const canEdit = EDITABLE.includes(p.status) && !p.ig_media_id;
    const lockedNote = p.status === "approved" && !p.ig_media_id ? `<p class="help">${icon("info", 14)} It's approved and scheduled. Unschedule it to edit.</p>` : "";
    const publishBar = canPublish
      ? card(
          `${scheduled ? `<div class="callout ok" style="margin-bottom:12px">${icon("calendar")}<p>Scheduled for <b>${esc(localLabel(new Date(p.scheduled_for), tz))}</b> (${esc(tz)}).</p></div>` : ""}
          <div class="row" style="align-items:flex-end;gap:12px">
            ${action(`/admin/posts/${id}/post-now`, "Post now", {
              variant: "primary",
              icon: "send",
              confirm: `${p.status === "qc_failed" ? `The quality check flagged this ${noun}. ` : ""}Publish ${isStory ? "this story" : "it"} to ${acct ? `@${acct.username ?? acct.ig_user_id}` : "Instagram"} right now?`,
            })}
            <form method="post" action="/admin/posts/${id}/schedule" class="row" style="align-items:flex-end">
              <div class="field" style="margin:0"><label for="sched-at">Schedule for <span class="meta">(${esc(tz)})</span></label><input id="sched-at" type="datetime-local" name="at" value="${esc(defaultAt)}" required style="width:auto"></div>
              ${button(scheduled ? "Reschedule" : "Schedule", { icon: "calendar" })}
            </form>
            ${scheduled ? action(`/admin/posts/${id}/unschedule`, "Unschedule", { variant: "ghost", icon: "x" }) : ""}
          </div>
          <p class="help" style="margin-top:8px">Your choice wins over the posting window${ctl.mode === "dry_run" ? " and dry-run mode" : ""}. RED posts are never published.</p>`,
          { title: "Publish", id: "publish" },
        )
      : p.status === "published"
        ? ""
        : card(
            `<div class="row" style="align-items:center;gap:12px"><button class="btn primary" disabled aria-disabled="true">${icon("send", 16)}<span>Post now</span></button><button class="btn" disabled aria-disabled="true">${icon("calendar", 16)}<span>Schedule</span></button>
             <span class="meta">${esc(blocked.reason)}</span></div>`,
            { title: "Publish", id: "publish" },
          );
    const actions = [
      ["awaiting_review", "dry_run"].includes(p.status) ? action(`/admin/posts/${id}/approve`, "Approve (next window)", { icon: "check", variant: "ghost" }) : "",
      ["qc_failed", "failed"].includes(p.status) && !p.ig_media_id ? action(`/admin/posts/${id}/retry`, "Retry production", { icon: "refresh" }) : "",
      !["published", "rejected"].includes(p.status) ? action(`/admin/posts/${id}/reject`, "Reject", { variant: "ghost", icon: "x", confirm: `Reject this ${noun}?` }) : "",
      !p.ig_media_id && !["published", "publishing"].includes(p.status)
        ? action(`/admin/posts/${id}/delete`, "Delete", { variant: "danger", icon: "trash", confirm: `Delete this ${noun} for good? It can't be undone.` })
        : "",
      !isTikTok && tiktokOn && !tiktokTwin && !["rejected", "failed", "draft", "generating", "composing"].includes(p.status) && p.safety_level !== "red"
        ? action(`/admin/posts/${id}/tiktok`, "Also post to TikTok", { icon: "zap", variant: "ghost" })
        : "",
      tiktokTwin ? link(`TikTok version (${tiktokTwin.status.replace("_", " ")})`, `/admin/posts/${tiktokTwin.id}`, { variant: "ghost" }) : "",
      isTikTok && p.source_post_id ? link("From the Instagram post", `/admin/posts/${p.source_post_id}`, { variant: "ghost" }) : "",
      p.permalink ? link(isTikTok ? "Open on TikTok" : "Open on Instagram", p.permalink, { external: true }) : "",
    ].join("");
    const storyText = isStory ? String(assets[0]?.overlay?.heading ?? "") : "";
    const storyHasHer = isStory && (await one<{ c: boolean | null }>("SELECT (plan->'slides'->0->>'include_character')::boolean AS c FROM content_ideas WHERE id = $1", [p.content_idea_id]))?.c;
    const textCard = isStory
      ? card(
          storyHasHer
            ? `<p class="muted">${icon("info", 14)} The influencer is in this photo, so it stays text-free (house rule: no text on photos of them).</p>`
            : canEdit
              ? `<form method="post" action="/admin/posts/${id}/story-text">${field("Words on the image", input("text", storyText, { attrs: 'maxlength="90" id="story-text"', placeholder: "Leave empty for a plain photo" }), {
                  help: `Plain words, no emoji. The image is re-rendered from the original photo.${assets[0]?.overlay?.body ? ` The line "${esc(String(assets[0].overlay.body))}" underneath comes from the business knowledge and stays.` : ""}`,
                })}${button("Update the image", { variant: "primary", icon: "pencil" })}</form>`
              : `<p>${storyText ? esc(storyText) : '<span class="muted">No text on this story.</span>'}</p>${lockedNote}`,
          { title: "Story text", id: "caption" },
        )
      : card(
          canEdit
            ? `<form method="post" action="/admin/posts/${id}/caption" class="edit-caption">${field("Caption", textarea("caption", p.caption, { rows: 7, attrs: 'maxlength="2200" data-count="cap-count" id="caption-text"' }), {
                help: "Edit freely: it's what goes under the photos. Hashtags at the end.",
              })}<div class="row" style="justify-content:space-between;align-items:center">${button("Save caption", { variant: "primary", icon: "check" })}<span class="counter" id="cap-count"></span></div></form><p class="meta" style="margin-top:8px">Hook: ${esc(p.hook ?? "")}</p>`
            : `<pre>${esc(p.caption)}</pre>${lockedNote}<p class="meta" style="margin-top:8px">Hook: ${esc(p.hook ?? "")}</p>`,
          { title: "Caption", id: "caption" },
        );
    const body = `${header(p.topic ?? (isStory ? "Story" : isTikTok ? "TikTok post" : "Post"), {
      eyebrow: isTikTok ? `TikTok · ${p.media_type === "CAROUSEL" ? "photo carousel" : "photo"}` : isStory ? `story / ${p.structure ?? ""}` : `${p.format ?? ""} / ${p.structure ?? ""}`,
      sub: `${pill(p.status)} ${pill(p.safety_level)} <span class="meta">repetition ${p.repetition_score ?? "—"} · cost ${usd(costs?.usd)} · created ${ago(p.created_at)}</span>`,
      actions,
    })}
${p.last_error ? `<div class="callout bad">${icon("alert")}<p>${esc(p.last_error)}</p></div>` : ""}
${publishBar}
${p.media_type === "REEL"
  ? card(reelView(assets), { title: "Reel" })
  : card(
  `<div class="slides${isStory || isTikTok ? " story" : ""}">${
    assets
      .map((a) =>
        a.public_url
          ? `<figure><img src="${esc(a.public_url)}" alt="${esc(a.overlay?.alt_text ?? `Slide ${a.position + 1}`)}"><figcaption>${
              isStory ? "<span>9:16 story</span>" : a.position === 0 ? `<span class="slide-cover">${icon("star", 12)}Cover</span>` : `<span>Slide ${a.position + 1}</span>`
            }</figcaption>${canEdit && !isStory && assets.length > 1 ? slideTools(id, a.position, assets.length) : ""}</figure>`
          : "",
      )
      .join("") || `<span class="muted">Not generated yet</span>`
  }</div>${canEdit && !isStory && assets.length > 1 ? `<p class="help" style="margin-top:8px">Arrows reorder, the star makes a slide the cover, the bin removes it. A carousel needs 2 to 10 slides; one left makes it a single photo.</p>` : ""}`,
  { title: isStory ? "Story" : `Slides (${assets.length})` },
)}
<div class="grid">
${textCard}
${isTikTok ? tiktokSettingsCard(id, p.tiktok ?? {}, canEdit) : ""}
${isStory || isTikTok ? "" : card(
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
    return render(req, reply, { title: isStory ? "Story" : "Post", active: isStory ? "stories:detail" : "posts:detail", body, scripts: canEdit && !isStory ? CAPTION_JS : undefined });
  });

  const edited = (req: Req, reply: Parameters<typeof done>[1], res: { ok: boolean; message: string }, hash = "") => done(req, reply, `/admin/posts/${req.params.id}${hash}`, res.message, res.ok);
  r.post("/admin/posts/:id/slides/:pos/remove", async (req: Req, reply) => edited(req, reply, await removeSlide(req.params.id, Number(req.params.pos), reviewer(req))));
  r.post("/admin/posts/:id/slides/:pos/move", async (req: Req, reply) => edited(req, reply, await moveSlide(req.params.id, Number(req.params.pos), Number(req.body?.to), reviewer(req))));
  r.post("/admin/posts/:id/caption", async (req: Req, reply) => edited(req, reply, await editCaption(req.params.id, String(req.body?.caption ?? ""), reviewer(req)), "#caption"));
  r.post("/admin/posts/:id/story-text", async (req: Req, reply) =>
    attempt(req, reply, `/admin/posts/${req.params.id}#caption`, async () => {
      const res = await editStoryText(req.params.id, String(req.body?.text ?? ""), reviewer(req));
      if (!res.ok) throw new Error(res.message);
      return res.message;
    }),
  );
  r.post("/admin/posts/:id/delete", async (req: Req, reply) => {
    const kind = (await one<{ media_type: string }>("SELECT media_type FROM posts WHERE id = $1 AND influencer_id = $2", [req.params.id, influencerId()]))?.media_type;
    const res = await deletePost(req.params.id, reviewer(req));
    return done(req, reply, res.ok ? (kind === "STORY" ? "/admin/stories" : "/admin/posts") : `/admin/posts/${req.params.id}`, res.message, res.ok);
  });

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

  /** Push a synthetic comment/DM through the real pipeline (ingest → worker) for the selected influencer. */
  r.post("/admin/simulate", async (req: Req, reply) =>
    attempt(req, reply, "/admin/conversations", async () => {
      const acct = await primaryAccount();
      const accountId = acct?.ig_user_id;
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
}
