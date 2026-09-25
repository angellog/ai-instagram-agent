import { esc } from "../html.js";
import { icon } from "./icons.js";

export { ago, bar, esc, pill, table, usd } from "../html.js";
export { icon } from "./icons.js";

/** Page header: title, optional subtitle and right-aligned actions. */
export function header(title: string, o: { sub?: string; actions?: string; eyebrow?: string } = {}): string {
  return `<div class="ph"><div>${o.eyebrow ? `<div class="eyebrow">${esc(o.eyebrow)}</div>` : ""}<h1>${esc(title)}</h1>${o.sub ? `<p class="sub">${o.sub}</p>` : ""}</div>${
    o.actions ? `<div class="ph-actions">${o.actions}</div>` : ""
  }</div>`;
}

export function card(body: string, o: { title?: string; actions?: string; id?: string; cls?: string; pad?: boolean } = {}): string {
  const head = o.title || o.actions ? `<div class="card-h">${o.title ? `<h2>${esc(o.title)}</h2>` : "<span></span>"}${o.actions ? `<div class="row">${o.actions}</div>` : ""}</div>` : "";
  return `<section class="card ${o.cls ?? ""}"${o.id ? ` id="${esc(o.id)}"` : ""}>${head}<div class="${o.pad === false ? "" : "card-b"}">${body}</div></section>`;
}

export function kpi(label: string, value: string, o: { hint?: string; icon?: string; tone?: "ok" | "warn" | "bad" | "info"; href?: string } = {}): string {
  const inner = `<div class="kpi-l">${o.icon ? icon(o.icon, 16) : ""}<span>${esc(label)}</span></div><div class="kpi-v ${o.tone ?? ""}">${value}</div>${o.hint ? `<div class="kpi-h">${o.hint}</div>` : ""}`;
  return o.href ? `<a class="kpi" href="${esc(o.href)}">${inner}</a>` : `<div class="kpi">${inner}</div>`;
}

export function empty(title: string, body = "", action = ""): string {
  return `<div class="empty">${icon("sparkles", 28)}<b>${esc(title)}</b>${body ? `<p>${body}</p>` : ""}${action}</div>`;
}

type Variant = "primary" | "danger" | "ghost" | "default";
export function button(label: string, o: { variant?: Variant; icon?: string; type?: "submit" | "button"; attrs?: string; small?: boolean } = {}): string {
  return `<button type="${o.type ?? "submit"}" class="btn ${o.variant ?? ""} ${o.small ? "sm" : ""}" ${o.attrs ?? ""}>${o.icon ? icon(o.icon, 16) : ""}<span>${esc(label)}</span></button>`;
}

export function link(label: string, href: string, o: { variant?: Variant; icon?: string; external?: boolean; small?: boolean } = {}): string {
  return `<a class="btn ${o.variant ?? ""} ${o.small ? "sm" : ""}" href="${esc(href)}"${o.external ? ' target="_blank" rel="noopener"' : ""}>${o.icon ? icon(o.icon, 16) : ""}<span>${esc(label)}</span>${o.external ? icon("external", 14) : ""}</a>`;
}

/** POST form wrapping a single action button; `confirm` asks first (destructive actions). */
export function action(url: string, label: string, o: { variant?: Variant; icon?: string; confirm?: string; fields?: Record<string, string>; small?: boolean } = {}): string {
  const hidden = Object.entries(o.fields ?? {})
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<form class="inline" method="post" action="${esc(url)}"${o.confirm ? ` data-confirm="${esc(o.confirm)}"` : ""}>${hidden}${button(label, { variant: o.variant, icon: o.icon, small: o.small })}</form>`;
}

let fid = 0;
/** Labelled field with helper text (labels are always visible, never placeholder-only). */
export function field(label: string, control: string, o: { help?: string; id?: string; required?: boolean } = {}): string {
  const id = o.id ?? `f${++fid}`;
  const ctl = control.replace(/^<(input|select|textarea)/, `<$1 id="${id}"${o.help ? ` aria-describedby="${id}-h"` : ""}`);
  return `<div class="field"><label for="${id}">${esc(label)}${o.required ? ' <span class="req" aria-hidden="true">*</span>' : ""}</label>${ctl}${
    o.help ? `<p class="help" id="${id}-h">${o.help}</p>` : ""
  }</div>`;
}

export function input(name: string, value: unknown = "", o: { type?: string; placeholder?: string; attrs?: string } = {}): string {
  return `<input name="${esc(name)}" type="${o.type ?? "text"}" value="${esc(value)}"${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ""} ${o.attrs ?? ""}>`;
}

export function select(name: string, options: Array<string | [string, string]>, value: unknown, attrs = ""): string {
  return `<select name="${esc(name)}" ${attrs}>${options
    .map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}"${String(value) === v ? " selected" : ""}>${esc(l)}</option>`;
    })
    .join("")}</select>`;
}

export function textarea(name: string, value = "", o: { rows?: number; mono?: boolean; attrs?: string } = {}): string {
  return `<textarea name="${esc(name)}" rows="${o.rows ?? 4}" class="${o.mono ? "mono" : ""}" ${o.attrs ?? ""}>${esc(value)}</textarea>`;
}

export function tabs(items: Array<{ href: string; label: string; active?: boolean; count?: number }>): string {
  return `<nav class="tabs" aria-label="Sections">${items
    .map((t) => `<a href="${esc(t.href)}"${t.active ? ' aria-current="page" class="on"' : ""}>${esc(t.label)}${t.count !== undefined ? ` <span class="count">${t.count}</span>` : ""}</a>`)
    .join("")}</nav>`;
}

/** Health/status dot with text (never colour alone). */
export function status(s: string | null | undefined): string {
  const v = s ?? "unknown";
  const tone = ({ healthy: "ok", active: "ok", verified: "ok", degraded: "warn", paused: "warn", hatching: "info", unknown: "", unavailable: "bad", archived: "" } as Record<string, string>)[v] ?? "";
  return `<span class="st ${tone}"><i></i>${esc(v)}</span>`;
}

export function avatar(url: string | null | undefined, name: string, size = 32): string {
  if (url) return `<img class="av" src="${esc(url)}" alt="" width="${size}" height="${size}" loading="lazy">`;
  return `<span class="av av-t" style="width:${size}px;height:${size}px" aria-hidden="true">${esc(name.slice(0, 1).toUpperCase())}</span>`;
}

export function steps(items: string[], current: number): string {
  return `<ol class="steps">${items
    .map((s, i) => `<li class="${i < current ? "done" : i === current ? "on" : ""}"${i === current ? ' aria-current="step"' : ""}><span>${i < current ? icon("check", 14) : i + 1}</span>${esc(s)}</li>`)
    .join("")}</ol>`;
}
