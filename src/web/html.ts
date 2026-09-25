/** Server-side HTML primitives shared by the console (see ui/kit.ts for components). No build step. */

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
  succeeded: "ok",
  success: "ok",
  running: "info",
  queued: "info",
  submitted: "info",
  paused: "warn",
  hatching: "info",
  cancelled: "",
  content_policy: "bad",
  auth: "bad",
  rate_limit: "warn",
  timeout: "warn",
  provider: "warn",
  validation: "warn",
  budget: "warn",
  unsupported: "",
  retrying: "warn",
  expired: "",
};

export const pill = (s: string | null | undefined) => (s ? `<span class="pill ${PILL[s] ?? ""}">${esc(s)}</span>` : "");

export function table(headers: string[], rows: string[][], empty = "Nothing here yet."): string {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<div class="tw"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

export function bar(value: number, max: number): string {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `<div class="bar" title="${pct}%"><i style="width:${pct}%"></i></div>`;
}
