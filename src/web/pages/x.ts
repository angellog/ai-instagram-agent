import type { FastifyInstance } from "fastify";
import { getControls } from "../../config/controls.js";
import { setting } from "../../config/settings.js";
import { influencerId } from "../../context.js";
import { spendSummary } from "../../cost/ledger.js";
import { many, one } from "../../db/pool.js";
import { connectX, disconnectX, primaryX, xReadsToday } from "../../x/accounts.js";
import { collectXMetrics, latestPostMetrics } from "../../x/metrics.js";
import { pollMentions } from "../../x/poll.js";
import { attempt, consoleRouter, render, type Req } from "../console.js";
import { action, ago, card, empty, esc, field, header, input, kpi, link, pill, table, usd } from "../ui/kit.js";

const tweetUrl = (id: string) => `https://x.com/i/web/status/${id}`;
const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en"));

export function registerX(app: FastifyInstance): void {
  const r = consoleRouter(app);

  r.get("/admin/x", async (req: Req, reply) => {
    const [acct, hasToken, c] = await Promise.all([primaryX(), setting("X_BEARER_TOKEN"), getControls()]);

    if (!hasToken || !acct) {
      const steps = !hasToken
        ? empty(
            "Add your X bearer token",
            "console.x.com → your app → Keys and tokens → Bearer Token. It is read-only: it can read mentions and metrics, never post.",
            link("Open Config & keys", "/admin/config#x", { variant: "primary" }),
          )
        : `<form method="post" action="/admin/x/connect" class="stack">
             ${field("X username", input("username", "", { placeholder: "feetbitsneakers" }), { help: "The account to watch. No login needed while the agent is read-only.", required: true })}
             <button class="btn primary" type="submit">Connect</button>
           </form>`;
      const body = `${header("X (Twitter)", { sub: "Read-only for now: the agent reads mentions every 15 minutes and your posts' metrics once a day. It cannot post or reply." })}
${card(steps, { title: hasToken ? "Connect an account" : "Step 1 of 2" })}`;
      return render(req, reply, { title: "X (Twitter)", active: "x", body });
    }

    const [mentions, posts, spend, reads, counts] = await Promise.all([
      many<{ tweet_id: string; author_username: string | null; author_name: string | null; text: string; posted_at: Date; status: string }>(
        "SELECT tweet_id, author_username, author_name, text, posted_at, status FROM x_mentions WHERE influencer_id = $1 ORDER BY posted_at DESC LIMIT 80",
        [influencerId()],
      ),
      latestPostMetrics(acct.id),
      spendSummary(),
      xReadsToday(),
      one<{ unseen: number; week: number }>(
        "SELECT count(*) FILTER (WHERE status = 'new')::int AS unseen, count(*) FILTER (WHERE posted_at > now() - interval '7 days')::int AS week FROM x_mentions WHERE influencer_id = $1",
        [influencerId()],
      ),
    ]);

    const body = `${header("X (Twitter)", {
      sub: `Watching <a href="https://x.com/${esc(acct.username)}" target="_blank" rel="noopener">@${esc(acct.username)}</a>. Read-only: mentions every 15 minutes, post metrics daily. Replies come in phase 2.`,
      actions: `${action("/admin/x/poll", "Check mentions now", { icon: "refresh", variant: "primary" })}${action("/admin/x/metrics", "Collect metrics", { icon: "activity", variant: "ghost" })}`,
    })}
<div class="kpis">
${kpi("Followers", n(acct.stats.followers), { icon: "users" })}
${kpi("New mentions", n(counts?.unseen), { hint: `${n(counts?.week)} in the last 7 days`, icon: "message", tone: counts?.unseen ? "info" : undefined })}
${kpi("X reads today", `${reads} / ${c.x_daily_read_cap}`, { hint: `${usd(spend.todayX)} of ${usd(c.daily_x_api_budget_usd)} daily`, icon: "wallet", tone: reads >= c.x_daily_read_cap ? "bad" : undefined })}
${kpi("Last check", acct.last_polled_at ? ago(acct.last_polled_at) : "never", { hint: acct.last_poll_note ?? "", icon: "refresh" })}
</div>
${card(
  table(
    ["When", "From", "Mention", "Status", ""],
    mentions.map((m) => [
      ago(m.posted_at),
      m.author_username ? `<a href="https://x.com/${esc(m.author_username)}" target="_blank" rel="noopener">@${esc(m.author_username)}</a>${m.author_name ? `<div class="meta">${esc(m.author_name)}</div>` : ""}` : "—",
      esc(m.text),
      pill(m.status),
      `<a class="btn sm ghost" href="${tweetUrl(m.tweet_id)}" target="_blank" rel="noopener">Open</a>`,
    ]),
    "No mentions yet. They show up here within 15 minutes of someone tagging the account.",
  ),
  { title: "Mentions", actions: counts?.unseen ? action("/admin/x/seen", "Mark all seen", { small: true, variant: "ghost" }) : "" },
)}
${card(
  table(
    ["Posted", "Post", "Views", "Likes", "Replies", "Reposts", "Saves"],
    posts.map((p) => [ago(p.posted_at), `<a href="${tweetUrl(p.tweet_id)}" target="_blank" rel="noopener">${esc((p.text ?? "").slice(0, 90))}</a>`, n(p.impressions), n(p.likes), n(p.replies), n(p.reposts), n(p.bookmarks)]),
    "No posts measured yet. Metrics are collected every morning for posts from the last 7 days.",
  ),
  { title: "Your posts (last 7 days)" },
)}
${card(`<p class="meta" style="margin-top:0">Connected ${ago(acct.created_at)} · X user id ${esc(acct.x_user_id)}</p>${action("/admin/x/disconnect", "Disconnect", { variant: "ghost", small: true, confirm: `Stop watching @${acct.username}? Its mentions and metrics are deleted.` })}`, { title: "Account" })}`;
    return render(req, reply, { title: "X (Twitter)", active: "x", body });
  });

  r.post("/admin/x/connect", async (req: Req, reply) =>
    attempt(req, reply, "/admin/x", async () => {
      const acct = await connectX(await getControls(), String(req.body?.username ?? ""));
      return `Watching @${acct.username}. Mentions arrive within 15 minutes, or press Check mentions now.`;
    }),
  );

  r.post("/admin/x/disconnect", async (req: Req, reply) =>
    attempt(req, reply, "/admin/x", async () => {
      const u = await disconnectX();
      return u ? `Stopped watching @${u}` : "No account was connected";
    }),
  );

  r.post("/admin/x/poll", async (req: Req, reply) =>
    attempt(req, reply, "/admin/x", async () => {
      const res = await pollMentions();
      if ("skipped" in res) throw new Error(res.skipped);
      return `${res.inserted} new mention${res.inserted === 1 ? "" : "s"}`;
    }),
  );

  r.post("/admin/x/metrics", async (req: Req, reply) =>
    attempt(req, reply, "/admin/x", async () => {
      const res = await collectXMetrics();
      if ("skipped" in res) throw new Error(res.skipped);
      return `Measured ${res.posts} post${res.posts === 1 ? "" : "s"}`;
    }),
  );

  r.post("/admin/x/seen", async (req: Req, reply) =>
    attempt(req, reply, "/admin/x", async () => {
      const r2 = await many("UPDATE x_mentions SET status = 'seen' WHERE influencer_id = $1 AND status = 'new' RETURNING id", [influencerId()]);
      return `${r2.length} marked seen`;
    }),
  );
}
