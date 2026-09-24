/** Tiny server-side HTML kit for the admin dashboard. No build step. */

export const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function ago(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 0) return `in ${fmtDur(-s)}`;
  return `${fmtDur(s)} ago`;
}

function fmtDur(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const usd = (n: number | null | undefined) => `$${Number(n ?? 0).toFixed(Number(n ?? 0) < 1 ? 4 : 2)}`;

const PILL: Record<string, string> = {
  green: "ok",
  published: "ok",
  sent: "ok",
  done: "ok",
  approved: "ok",
  completed: "ok",
  accepted: "ok",
  active: "ok",
  yellow: "warn",
  awaiting_review: "warn",
  pending_review: "warn",
  pending: "warn",
  escalated: "warn",
  dry_run: "info",
  generating: "info",
  composing: "info",
  publishing: "info",
  processing: "info",
  draft: "info",
  info: "info",
  warn: "warn",
  red: "bad",
  failed: "bad",
  qc_failed: "bad",
  rejected: "bad",
  blocked: "bad",
  error: "bad",
};

export const pill = (s: string | null | undefined) => (s ? `<span class="pill ${PILL[s] ?? ""}">${esc(s)}</span>` : "");

export function table(headers: string[], rows: string[][], empty = "Nothing here yet."): string {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<div class="tw"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

export function layout(o: { title: string; body: string; flash?: string; mode?: string; paused?: boolean; openAccess?: boolean }): string {
  const nav = [
    ["/admin", "Overview"],
    ["/admin/reviews", "Reviews"],
    ["/admin/posts", "Posts"],
    ["/admin/content", "Content"],
    ["/admin/conversations", "Conversations"],
    ["/admin/people", "People"],
    ["/admin/costs", "Costs"],
    ["/admin/events", "Events"],
    ["/admin/controls", "Controls"],
    ["/admin/persona", "Persona"],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} · AI Agent</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#16161a;--muted:#6b6b76;--line:#e6e3dd;--accent:#ff5a1f;--ok:#157f3b;--okbg:#e3f5e8;--warn:#8a5a00;--warnbg:#fff2d6;--bad:#a4161a;--badbg:#fde3e3;--info:#1d4ed8;--infobg:#e3ebfd}
@media (prefers-color-scheme:dark){:root{--bg:#111114;--card:#1a1a1f;--ink:#ecebe8;--muted:#9a9aa5;--line:#2b2b33;--okbg:#12301d;--ok:#6fd892;--warnbg:#33270c;--warn:#f5c35b;--badbg:#3a1414;--bad:#ff8a8a;--infobg:#142040;--info:#8fb0ff}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:2}
header b{font-size:16px}header nav{display:flex;flex-wrap:wrap;gap:2px}header nav a{padding:4px 9px;border-radius:8px;color:var(--ink);text-decoration:none;font-size:14px}header nav a:hover{background:var(--bg)}
main{max-width:1180px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:4px 0 16px}h2{font-size:16px;margin:0 0 10px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.kpi{font-size:26px;font-weight:700}.muted{color:var(--muted)}.small{font-size:13px}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;background:var(--bg);color:var(--muted);white-space:nowrap}
.pill.ok{background:var(--okbg);color:var(--ok)}.pill.warn{background:var(--warnbg);color:var(--warn)}.pill.bad{background:var(--badbg);color:var(--bad)}.pill.info{background:var(--infobg);color:var(--info)}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
button,.btn{font:inherit;padding:6px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad)}
input,select,textarea{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);max-width:100%}textarea{width:100%;min-height:70px}
form.inline{display:inline}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.flash{padding:10px 14px;border-radius:10px;background:var(--infobg);color:var(--info);margin-bottom:14px}.banner{padding:8px 16px;background:var(--warnbg);color:var(--warn);font-size:14px}
.slides{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px}.slides img{height:300px;border-radius:10px;border:1px solid var(--line)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);padding:10px;border-radius:8px;font-size:12.5px;max-height:360px;overflow:auto}
.bar{height:8px;background:var(--bg);border-radius:9px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
</style></head><body>
${o.openAccess ? `<div class="banner">Development mode: the dashboard has no password. Set ADMIN_TOKEN before exposing it.</div>` : ""}
${o.paused ? `<div class="banner">⏸ The agent is PAUSED. Nothing is planned, sent or published.</div>` : ""}
<header><b>🤖 ${esc(o.title)}</b>${o.mode ? pill(o.mode) : ""}<nav>${nav.map(([h, l]) => `<a href="${h}">${l}</a>`).join("")}</nav></header>
<main>${o.flash ? `<div class="flash">${esc(o.flash)}</div>` : ""}${o.body}</main></body></html>`;
}

export function bar(value: number, max: number): string {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `<div class="bar" title="${pct}%"><i style="width:${pct}%"></i></div>`;
}
