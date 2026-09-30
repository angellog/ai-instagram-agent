---
name: Influencer OS
description: Operator console for running a roster of AI influencers; calm solid working surfaces with glass only on the controls that float above them.
colors:
  signal-orange: "#ff5a1f"
  ember-action: "#c8410e"
  ember-action-deep: "#a93609"
  signal-orange-wash: "#fff0ea"
  focus-blue: "#2563eb"
  studio-floor: "#f6f6f8"
  surface: "#ffffff"
  surface-raised: "#f0f1f4"
  surface-well: "#e8e9ee"
  ink: "#12141a"
  ink-soft: "#3b3f4c"
  ink-muted: "#636878"
  hairline: "#e3e4ea"
  hairline-strong: "#d3d5dd"
  ok: "#137a3a"
  ok-wash: "#e4f5ea"
  warn: "#8a5300"
  warn-wash: "#fff3d6"
  bad: "#b3141a"
  bad-wash: "#fde6e6"
  info: "#1d4ed8"
  info-wash: "#e5ecfe"
  signal-orange-night: "#ff6a33"
  ember-action-night-ink: "#1b0b04"
  signal-orange-wash-night: "#2a1710"
  focus-blue-night: "#7aa2ff"
  night-floor: "#0d0e12"
  night-surface: "#15171c"
  night-surface-raised: "#1c1f26"
  night-surface-well: "#252932"
  night-ink: "#eceef2"
  night-ink-soft: "#c5c8d1"
  night-ink-muted: "#9a9fad"
  night-hairline: "#262a33"
  night-hairline-strong: "#343945"
typography:
  display:
    fontFamily: "Fira Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Fira Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Fira Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Fira Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "\"tnum\" 1"
  meta:
    fontFamily: "Fira Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Fira Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.08em"
  mono:
    fontFamily: "Fira Code, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
rounded:
  sm: "8px"
  control: "10px"
  md: "12px"
  lg: "16px"
  panel: "20px"
  hero: "22px"
  pill: "99px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
  s8: "32px"
  s10: "40px"
components:
  button-primary:
    backgroundColor: "{colors.ember-action}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.ember-action-deep}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
    height: "38px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-raised}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.bad}"
    rounded: "{rounded.control}"
  button-small:
    rounded: "{rounded.control}"
    padding: "4px 10px"
    height: "32px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 11px"
    height: "40px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "14px 20px 20px"
  pill:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  pill-ok:
    backgroundColor: "{colors.ok-wash}"
    textColor: "{colors.ok}"
  pill-warn:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.warn}"
  pill-bad:
    backgroundColor: "{colors.bad-wash}"
    textColor: "{colors.bad}"
  nav-item:
    textColor: "{colors.ink-soft}"
    rounded: "9px"
    padding: "8px 10px"
    height: "38px"
  nav-item-active:
    backgroundColor: "{colors.signal-orange-wash}"
    textColor: "{colors.ink}"
  glass-panel:
    rounded: "{rounded.panel}"
    padding: "14px 24px 20px"
---

# Design System: Influencer OS

## Overview

**Creative North Star: "The Glass Control Room"**

Influencer OS is a control room for one operator running several AI creators. The room is calm and legible: the working surfaces (tables, cards, forms, previews) are solid, and only the controls that float above them are glass. That means the top bar, sidebar, menus, dialogs, toasts and the Config & keys panels. Behind the glass is a faint orange-and-blue light field, like screens glowing in a dim room. It gives the glass something to refract without ever competing with the content.

Density is moderate and task-first. The same pages must work in a few thumb taps on a phone on the shop floor and in long laptop set-up sessions. FeetBit orange is a signal, not a paint: it marks the one primary action, the active place in the nav, progress and counts. Everything else is ink on quiet neutrals. Light and dark themes are designed together and carry equal weight.

The feel is precise and quiet. It uses soft corners, hairline borders, one clear primary action per page, and short motion that confirms state rather than decorates.

**Key Characteristics:**
- Solid working surfaces; glass reserved for floating chrome and Config panels.
- Orange used as a rare signal (10% or less of any screen).
- Status always carries words or an icon as well as colour.
- Light and dark designed as a pair; tabular figures everywhere.
- Motion from 150 to 220ms, off under reduced motion; glass off under reduced transparency.

## Colors

Cool, nearly colourless neutrals with a single warm signal and four semantic hues that only speak when something has a state.

### Primary
- **Signal Orange** (`signal-orange`; night `signal-orange-night`): the brand mark, active-nav wash and inset bar, progress bars and the readiness ring, count badges. Never body text, never a large fill.
- **Ember Action** (`ember-action`, hover `ember-action-deep`): primary buttons in light mode. It is a deeper orange so white text passes 4.5:1. In dark mode the primary button uses Signal Orange Night with near-black ink (`ember-action-night-ink`).
- **Orange Wash** (`signal-orange-wash`; night `signal-orange-wash-night`): the background of the active nav item and the selected step. It is the only tinted surface allowed to carry brand hue.

### Secondary
- **Focus Blue** (`focus-blue`; night `focus-blue-night`): keyboard focus rings and input focus glow, and in-content links (as `info`). Reserved for "you are here with the keyboard".

### Neutral
- **Studio Floor** (`studio-floor`; night `night-floor`): the page behind everything; the light field sits on top of it.
- **Surface / Raised / Well** (`surface`, `surface-raised`, `surface-well`; night variants): cards and inputs, hover and secondary fills, tracks and deep wells (progress track, avatar placeholder).
- **Ink / Ink Soft / Ink Muted** (`ink`, `ink-soft`, `ink-muted`; night variants): headings and values, body and nav text, meta and help text. Ink Muted passes AA on Surface in both themes.
- **Hairline / Hairline Strong** (`hairline`, `hairline-strong`): dividers and card borders, input and button borders.

### Semantic
- **OK / Warn / Bad / Info** with matching `-wash` backgrounds: pills, callouts, status dots, banners and KPI tones. Always paired with a label or icon.

### Named Rules
**The Rare Signal Rule.** Orange covers 10% or less of any screen: one primary button, the active nav item, progress, badges. If a second element wants orange, it probably wants ink or a semantic colour instead.

**The Colour-Plus-Words Rule.** No state is shown by colour alone. Every dot, pill, ring and tint has text or an icon next to it.

## Typography

**Display Font:** Fira Sans (with ui-sans-serif, system-ui)
**Body Font:** Fira Sans
**Label/Mono Font:** Fira Code for keys, IDs, YAML and masked secrets

**Character:** A single humanist sans in several weights. It is readable at small sizes on a phone and technical enough for a console, and Fira Code sits beside it for anything the operator might copy.

### Hierarchy
- **Display** (700, 26px, 1.2, -0.02em; 22px under 640px): page titles only, one per page.
- **Headline** (600, 17px, 1.3): section panels on Config & keys, the readiness heading (18px), dialog titles.
- **Title** (600, 15px): card titles, field labels (14px), table values that need weight.
- **Body** (400, 15px/1.55, tabular figures): all running text. Page subtitles cap at 70ch.
- **Meta** (400, 12.5–13.5px): help text, timestamps, secondary lines.
- **Label** (600, 11–12px, 0.04–0.08em, uppercase): nav group headings, table headers and source badges only.
- **KPI value** (700, 26px, -0.02em; 22px on phones): numbers on overview tiles.

### Named Rules
**The Tabular Rule.** Every number uses tabular figures (`tnum`), so counts, costs and times never jitter as they update.

**The Sparse Caps Rule.** Uppercase tracking is for nav group headings, table headers and small source badges. It is never a kicker above every section.

## Layout

Two columns from 1024px up: a 252px sticky sidebar and a fluid main column (max 1320px, 24px padding). From 641 to 1023px the sidebar becomes an off-canvas drawer with a scrim and Escape to close, and main padding drops to 16px. At 640px and below, KPI tiles go two-up, tables scroll inside their cards, settings fields stack to one column, and top-bar button labels hide behind icons.

Spacing follows a 4px scale (4, 8, 12, 16, 20, 24, 32, 40). Cards stack 16px apart. Card bodies use 14px top and 20px sides (24px on glass panels). Grids use `repeat(auto-fit, minmax(280px, 1fr))` for cards and `minmax(180px, 1fr)` for KPIs.

The sticky top bar is about 61px tall (57px under 1024px). Anything else that sticks, like the Config section bar, docks directly beneath it, and anchored sections set `scroll-margin-top` so they land below both.

## Elevation & Depth

This is a hybrid system. Working content is flat: surfaces sit at rest on a hairline border with a barely-there ambient shadow. Depth appears only for things that genuinely float, and those are made of glass. Glass is a translucent surface (about 58–64% of Surface in dark and light), a 22px backdrop blur with 1.7 saturation, a bright one-pixel top edge, and a soft drop shadow. It needs the light field behind it; without it the glass reads as grey.

### Shadow Vocabulary
- **Rest** (`0 1px 2px rgb(16 18 26/.06), 0 1px 3px rgb(16 18 26/.05)`; dark `0 1px 2px rgb(0 0 0/.4)`): cards and KPI tiles at rest.
- **Lifted** (`0 12px 32px rgb(16 18 26/.14)`; dark `0 16px 40px rgb(0 0 0/.55)`): menus, dialogs, toasts, the mobile drawer.
- **Glass** (`inset 0 1px 0 rgb(255 255 255/.85), inset 0 -1px 0 rgb(16 18 26/.04), 0 1px 1px rgb(16 18 26/.04), 0 8px 28px -6px rgb(16 18 26/.12)`; dark uses a 10% white edge and a deeper 60% shadow): glass panels and the Config section bar.

### Named Rules
**The Floating Glass Rule.** Glass is for surfaces that float over content (top bar, sidebar, menus, dialogs, toasts, sticky section bars) and for Config & keys panels. Tables, lists, previews and ordinary cards stay solid. If it doesn't float, it isn't glass.

**The Solid Fallback Rule.** Every glass surface has a solid twin. Without backdrop-filter support, or under `prefers-reduced-transparency` or `prefers-contrast: more`, glass becomes solid Surface, the light field disappears, and borders strengthen to Hairline Strong.

## Shapes

Soft, consistent corners that grow with the size of the thing: 8px for small chips and menu rows, 10px for buttons and inputs, 12px for callouts and images, 16px for cards and KPI tiles, 20px for glass panels, 22px for the readiness hero. Pills and status badges are fully round. Borders are always one pixel. Circles are reserved for avatars, status dots and the readiness ring.

## Components

### Buttons
- **Shape:** gently rounded (10px), 38px tall (32px small), 14px text at weight 500, icon plus label.
- **Primary:** Ember Action with white text in light mode, Signal Orange with near-black text in dark mode. One per page or panel; on glass it gains a soft orange under-glow and a light top edge.
- **Hover / Focus / Press:** fill deepens on hover, a 2px Focus Blue ring on keyboard focus, scale 0.98 on press, 55% opacity with a progress cursor while submitting.
- **Secondary:** Surface fill with a Hairline Strong border; on glass it becomes a half-translucent fill.
- **Ghost:** transparent until hover; used for Test buttons and tertiary actions.
- **Danger:** Bad text and a tinted border. Always behind the confirm dialog, where Cancel is the default escape.

### Chips
- **Pills:** fully round, 12px weight 600, a semantic wash with its own ink. Always a word, never just a colour.
- **Source badges:** small uppercase tags on settings ("set here" in OK, "from env" in Info, "not set" neutral).
- **Status dots:** 8px dot plus a text label.

### Cards / Containers
- **Corner Style:** 16px (glass panels 20px).
- **Background:** Surface; glass panels use the glass material.
- **Shadow Strategy:** Rest shadow; glass panels use the Glass shadow.
- **Border:** 1px Hairline; glass uses a bright translucent edge.
- **Internal Padding:** 14px top and 20px sides (24px on glass), header and actions in one row. Never nest a card inside a card.

### Inputs / Fields
- **Style:** 40px tall, 10px corners, 1px Hairline Strong, 15px text (no iOS zoom). Inside glass: a translucent fill with a faint inner shadow.
- **Focus:** Focus Blue border with a 3px 22% Focus Blue glow; inside glass the field turns solid.
- **Labels:** always visible above the control; help text sits below in Meta. Secret fields pair with a reveal button.
- **Config field tile:** each setting sits in its own 14px-radius tile that brightens and picks up a blue edge while focused.

### Navigation
- **Sidebar:** 38px rows, 14–15px Ink Soft with an icon. Hover fills with Surface Raised. The active item gets the Orange Wash, Ink text at weight 600, and a 3px inset orange bar. Group headings use the Label style.
- **Top bar:** glass, with breadcrumb, pause/resume, the operating-mode pill with a coloured dot and a dropdown, and the theme toggle.
- **Section tabs:** underline tabs (brand-coloured underline on the active tab) on ordinary pages. Config & keys uses the glass section bar instead.
- **Mobile:** the sidebar becomes a drawer; the top bar keeps the menu button, pause, mode dot and theme.

### Readiness Ring (signature)
A conic ring that fills with Signal Orange for the share of setup that is done, and turns fully OK green at 100%. It sits in a glass hero next to a checklist. Missing items come first, each tile in a Warn wash that links to its section; done items get a quiet check.

### Glass Section Bar (signature)
A sticky glass pill bar under the top bar. It lists sections with a status dot (grey none set, amber partly set, green all set) and highlights the section currently in view as a solid raised chip.

## Do's and Don'ts

### Do:
- **Do** keep orange to one primary action per page plus navigation, progress and badges (the Rare Signal Rule).
- **Do** pair every status colour with a word or icon, and keep body text at 4.5:1 or better in both themes.
- **Do** use glass only for floating chrome and Config panels, and give every glass surface its solid fallback.
- **Do** design light and dark together, and check both before shipping.
- **Do** make the daily jobs (approve, edit, see what broke) work one-handed at 375px, with 38–40px targets.
- **Do** use Fira Code for anything copyable: keys, IDs, masked secrets, YAML.

### Don't:
- **Don't** make tables, lists, previews or ordinary content cards glass.
- **Don't** use orange for body text, large fills or decorative gradients.
- **Don't** put uppercase tracked eyebrows above every section, or use gradient text.
- **Don't** use side-stripe accent borders on cards or callouts. The nav's inset active bar is the one sanctioned exception.
- **Don't** nest cards, or rely on hover alone for any action.
- **Don't** animate longer than 220ms or animate layout; everything must still work under reduced motion.
