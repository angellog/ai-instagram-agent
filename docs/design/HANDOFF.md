# Handoff spec: Influencer OS console

Server-rendered HTML (Fastify) with small progressive-enhancement scripts. No
build step. Source: `src/web/ui/{styles,shell,kit,icons}.ts`, pages in
`src/web/pages/*`, routing and context in `src/web/console.ts`.

## Overview
The operator runs several AI influencers from one console. Every
influencer-scoped page runs inside the influencer picked in the sidebar switcher
(cookie `aia_inf`). Platform pages (Influencers, Config, Costs, Events, Hatch)
work with or without a selected influencer.

## Layout
| Breakpoint | Layout |
|---|---|
| ≥1024px | Two columns: 252px sticky sidebar + fluid main (max 1320px, 24px padding) |
| 641–1023px | Sidebar becomes an off-canvas drawer (menu button, scrim, Esc closes); main 16px padding |
| ≤640px | KPI tiles shrink, tables scroll horizontally inside cards, calendar starts in list view |

The top bar is sticky and translucent. It shows a breadcrumb, a mode pill, a pause/resume button and the theme toggle.

## Design tokens (`:root`, redefined for dark)
| Token | Light | Dark | Usage |
|---|---|---|---|
| `--bg` | #f6f6f8 | #0d0e12 | Page |
| `--surface` / `-2` / `-3` | #fff / #f0f1f4 / #e8e9ee | #15171c / #1c1f26 / #252932 | Cards, hover, wells |
| `--ink` / `--ink-2` / `--muted` | #12141a / #3b3f4c / #636878 | #eceef2 / #c5c8d1 / #9a9fad | Text tiers (muted passes AA on surface) |
| `--brand` | #ff5a1f | #ff6a33 | Accent: active nav bar, bars, badges (never body text) |
| `--primary` | #c8410e | #ff6a33 | Primary buttons (white/dark ink ≥ 4.5:1) |
| `--ok/warn/bad/info` (+`-bg`) | semantic | semantic | Pills, callouts, status dots (always with text) |
| `--s1…--s10` | 4px scale | | Spacing |
| `--r-sm/--r/--r-lg` | 8/12/16px | | Radii |
| `--t-fast/--t` | 150/220ms | | Motion |

Type: Fira Sans (UI) and Fira Code (code/YAML). Body is 15px/1.55, H1 is 26px, tabular figures everywhere.

## Components (`kit.ts`)
| Component | Notes |
|---|---|
| `header(title,{eyebrow,sub,actions})` | One primary action per page, right-aligned |
| `card(body,{title,actions,id})` | The section unit; `id` is used for deep links (`/admin/config#generation`) |
| `kpi(label,value,{hint,icon,tone,href})` | Clickable tiles link to the detail page |
| `table` | Sticky header, row hover, horizontal scroll on small screens, empty-state text |
| `pill` / `status` | Colour + text (never colour alone) |
| `field(label, control, {help, required})` | Visible label, help text tied with `aria-describedby` |
| `action(url,label,{confirm})` | POST form; `confirm` opens the native `<dialog>` |
| `tabs`, `steps`, `empty`, `avatar`, `callout` | |
| `data-async` forms | Submitted with fetch, result shown as a toast (Test buttons) |
| `data-upload` file inputs | Downscale to ≤1600px JPEG in-browser and append data URLs to a textarea (no multipart) |

## States and interactions
| Element | State | Behaviour |
|---|---|---|
| Button | Hover / press / busy | Surface tint / scale .98 / disabled + 55% opacity while submitting |
| Destructive action | Submit | Confirm dialog (Cancel is the default escape route) |
| Flash | After redirect | Toast (`aria-live=polite`, errors `role=alert`), 5s (9s for errors); removed from the URL |
| Theme | Toggle | system → light → dark, stored in localStorage, applied before first paint |
| Calendar | Select a day / click an event / drag | Create dialog / edit dialog / move (reverted on error) |
| Hatch faces | Generating | Page auto-refreshes every 6s until done |

## Edge cases
- **No influencer yet**: influencer pages redirect to Hatch; platform pages still work.
- **Hatching influencer selected**: the switcher sends you to the wizard.
- **Missing keys**: the Config checklist, Engine "add KEY" links, and the Hatch launch checklist all name exactly what is missing.
- **Long text**: tables wrap; captions and prompts sit in `pre`/`details`.
- **Offline CDN**: the calendar falls back to the quick-add form.

## Accessibility
- There is a skip link and landmarks (`aside` nav, `main`). The current page is marked with `aria-current`.
- Focus rings are 2px `--focus` and always visible.
- Touch targets are ≥38–44px.
- `prefers-reduced-motion` disables all transitions.
- Icons are inline SVG in one stroke style. They are `aria-hidden` unless labelled.

## Motion
| Element | Trigger | Animation | Duration |
|---|---|---|---|
| Drawer | Menu | translateX | 220ms ease-out |
| Toast | Appear | fade + 8px rise | 220ms |
| KPI tile | Hover | 1px lift | 150ms |
