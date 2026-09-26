# Changelog

All notable changes. Versions are git tags; the running version is shown in the
console footer, `/health` and `/api/status`.

## v1.0.8: Closet remixing, occasion wear, weekends, trends and news

**Closet of separates** (`visual.character.closet`)
- Tops, bottoms, layers, one-pieces and activewear. Any top with any bottom (sometimes plus a layer) is a new outfit made from pieces the influencer owns: the real-life remix trick.
- Zuri goes from 16 fixed outfits to 522 possible looks.
- Rotation rules:
  - The exact look can't repeat for up to 21 days, and a single piece rests 2 days before reappearing in a new combination.
  - Picks are weighted by kind (mostly plain top + bottom, sometimes layered, a dress, or a saved outfit).
  - When a piece comes back with something new, the director is told it's a remix, as a styling angle.
- **Occasion wear** per influencer (church, Jumu'ah, Eid, kwanjula, wedding guest…). It triggers on its weekday or when the activity, topic or a calendar event mentions it.
- Zuri has Sunday church, kwanjula gomesi, wedding guest and an Eid visit. New influencers get occasions matching the faith and culture given in the Hatch brief's new "Faith and occasions" field.

**Weekends**
- Activities can be `weekends_only` or limited to specific `days` (Sunday church, Saturday market run, weekend brunch, football watch party).
- `weekend_ideas` plus an "it's the weekend" brief go to the director on Saturdays and Sundays.

**Trends and news**
- Per-influencer `trends`: Google News searches for their region, plus RSS/Atom feeds (Zuri: sneaker releases, Kampala events, Uganda fashion and music, Sneaker News, Hypebeast Footwear).
- Collected every 6 hours. Hard filter on politics, crime and tragedy, then the model keeps at most 6 items this creator would genuinely know, with a one-line note each.
- The brief goes to the director and to replies (never adding facts beyond the headline).
- New Trends & news page: brief, sources, raw headlines, Refresh now, and Add to calendar.

**Also**
- A Wardrobe card on Persona & soul shows closet size and today's planned look, workout outfit, remix and occasion wear.
- The composer writes closets, occasions, weekend activities, weekend ideas and news sources for new influencers.

## v1.0.7: Simple, readable captions

- Captions were paragraphs narrating the photo (the rooftop, the coffee, the sky, the "rotation"), with the same tics ("Rotation check", "Some days…", "like it owes me") and a question almost every time.
- **New rules for the director:** the photo already shows the scene, so the caption never describes it. One simple thought, feeling or small joke in 1–2 short lines, under 150 characters (educational carousels: a hook plus up to 3 short tips, under 320). A question only about one post in three. It sees recent captions so it doesn't reuse their openings or phrases. Good and bad examples are included.
- **Deterministic checker:** a caption that's too long, has too many sentences, uses an overused phrase, opens the same way as a recent caption, or would be the third question in a row is sent back with specific feedback. The rejected caption is kept on the idea for audit. On the last attempt it is trimmed at a sentence boundary instead.
- **Readable layout:** one sentence per line, then a blank line, then hashtags.
- Persona rule updated: "Captions are 1-2 short lines with one simple thought".

## v1.0.6: Create a post now, live followers, full console audit

**Create a post now** (Overview, Posts, the sidebar, and automatically after a Hatch launch)
- One tap runs the real pipeline for the selected influencer: idea → photos → quality and safety checks.
- It always stops for review, ignoring the posting window and cadence, and never auto-publishes.
- A live progress page shows an animated bar, a 4-step stepper, and photos fading in as each is hosted. Progress is measured from real pipeline rows, not a timer.
- When done: caption plus Post now / Schedule / Open / Make another. On failure: a readable reason and Try again.
- A second tap while a run is active reopens that run.

**Live follower numbers**
- An hourly Instagram profile sync (followers, following, posts), plus a sync right after an account is attached and a Refresh button on influencer cards.
- Cards and the Overview KPI no longer wait for the nightly snapshot.

**Audit fixes** (each has a regression test; a new crawler test visits every page and link and submits every form)
- Hatch actions are billed and logged to the influencer being hatched, not the one selected in the sidebar.
- The "Use platform default" button sat inside another form, so it re-saved the policy instead of resetting it.
- Failures now show as error toasts (`tone=bad`), not success toasts.
- Dates use the influencer's timezone, and all-day events are no longer "past" on their own day.
- Saving Controls only pins changed values, so platform defaults keep flowing. An emptied number field no longer becomes 0.
- Scheduling a time in the past is refused instead of posting immediately.
- Malformed ids return 404 instead of a database error. Unexpected errors on console forms come back as a message, not a raw 500.
- Removed a double escape, dead routes, and an unused switcher field. Button styles are consistent.
- Mobile: fixed horizontal overflow on every page (grid min-width), compact top bar, two-column KPIs.

## v1.0.5: Post now / Schedule

- A **Publish** card on every unpublished post, plus the same buttons on post review cards:
  - **Post now** publishes immediately. From a review card, an edited caption is applied first.
  - **Schedule** takes a date and time in the influencer's timezone (DST-safe). Reschedule and **Unschedule** are included.
- These are explicit operator decisions, so they win over the posting window and dry-run mode (`posts.publish_override = 'operator'`). They never override a RED safety verdict, development mode, or a pause; a paused influencer's post goes out on resume.
- Rescheduling replaces the queued job, so a post is never published twice. Scheduled times show on the Posts grid.

## v1.0.4: Wardrobe rotation + Profile kit

**Wardrobe rotation** (fixes "same all-black fit two days running")
- Root cause: the persona listed only 4 outfits, one of which matched the face reference photo. The director kept choosing it and the image model copied the reference's clothes. Repeats were only a soft 0.12 penalty.
- `visual.character.wardrobe` is the closet: Zuri now has 16 outfits, and hatched personas get 12–16.
- One outfit is planned per local day. It is deterministic, kept all day for continuity, and never repeats one worn within the cooldown window (up to 6 days).
- Workouts get activewear.
- The director may still choose freely, but repeats and wrong-kind outfits are rotated out, and the change is logged in continuity adjustments.
- Image prompts now say the reference is for identity only and its clothing, background and light should be ignored.

**Profile kit** (Instagram's API can't edit name, bio or photo)
- A new Hatch step, Profile, comes right after the soul face is chosen. There is also a Profile kit page for existing influencers.
- The text is written from the persona:
  - a searchable Name (≤30 characters)
  - three bios (≤150 characters, each states it's an AI creator)
  - handle ideas, category, link idea, highlight names (≤15 characters) and a first-story idea
  - copy buttons and live character counts
- Profile picture: a free face-weighted crop of the soul face, or a designed headshot (one generation). It is previewed at circle and avatar sizes and can be downloaded.

## v1.0.3: Hatch an influencer (with the v1.0.1 and v1.0.2 work)

The three releases shipped as one commit because the new console underpins all of them.

**v1.0.3 Hatch wizard** (`/admin/hatch`)
1. The **brief** (name, niche, city, look, vibe…) is turned by the LLM into a complete, validated persona.
2. **Review** the persona, edit it, or re-compose it.
3. **Soul**: generate three face options through the engine or bring your own photos, then name the Soul ID (e.g. `soul_nova_v1`). Optionally train a Higgsfield Soul ID.
4. **Instagram**: attach by token (validated with `/me`; Creator/Business only; webhooks subscribed), log in with Instagram (OAuth now carries the influencer), or skip.
5. **Launch**: pick the starting mode (human approval by default), posts per day and budgets. The per-influencer schedule starts in its own timezone, with an optional first post.

**v1.0.2 Console redesign + calendar**
- A new design system: tokens, light/dark, Fira type, SVG icons, WCAG AA, reduced motion. See `docs/design/HANDOFF.md`.
- An app shell with sections, an influencer switcher and pause/resume.
- An interactive **calendar** (FullCalendar 7). You can add, drag, edit and delete events.
  - Events are world (shared) or private.
  - Each event has an importance and a "use for" setting.
  - "What happened?" outcomes become memories.
  - Upcoming events feed the director and the conversation agent.
- Every page is scoped to the selected influencer.

**v1.0.1 Config + Generation Control Center**
- **Config & keys**: one page for every service key (LLM, 7 generation providers, storage, Meta app, OpenReply, Telegram).
  - Keys are encrypted and override env. Changes apply in about 15 seconds.
  - A setup checklist shows what is missing.
  - Per-provider **Test** buttons.
- **Generation Control Center**, with five views:
  - Providers & models (health, quarantine release, enable/disable).
  - Routing policy (platform + per influencer) with a spend-free **route preview**.
  - Jobs & failures (route + attempts per request).
  - Assets.
  - **Benchmarks**: a vision-judged suite, budget-capped, whose scores feed the router.

Also:
- Shared prompts are gender-neutral, so influencers can be of any gender.
- Planning is allowed in dry-run/development before an Instagram account is attached.
- A bad cron or timezone can no longer crash the worker.
- `scripts/preview-console.sh` runs a fully offline preview.

## v1.0.0 — Multi-influencer core + Generation Engine

**Platform**
- One deployment now runs many influencers. Every table that holds
  influencer data carries `influencer_id`; every job carries its owner and runs
  inside that influencer's context (persona, knowledge, controls, Instagram
  account, budgets). Cross-influencer access is a hard error, not a warning.
- Webhooks are routed per entry to the influencer that owns the Instagram
  account; unknown accounts are dropped.
- Controls are layered: platform values (influencer 0) under per-influencer
  values. New platform-wide daily/monthly budget ceilings.
- Persona and knowledge live in the database (versioned); `config/persona.yaml`
  only seeds influencer #1 on upgrade (`PERSONA_SYNC_FROM_FILE=true` keeps
  syncing it).
- **Souls**: each influencer has a versioned identity pack (approved face
  references + provider bindings such as a Higgsfield Soul ID). Zuri was
  migrated to `soul_zuri_v1`.
- In-app **settings** (`app_settings`, AES-256-GCM): provider keys can be set
  in the console and override environment variables. LLM, storage, Telegram,
  webhook and OAuth settings are re-read without a restart.

**Generation Engine** (brief v2)
- Provider-agnostic contract, model/provider registry (DB is the source of
  truth; the code catalog seeds it), deterministic router (fixed,
  preferred+fallback, best quality, best value, fastest, capability-first,
  auto), idempotent requests, fallback on transient/provider classes only
  (never on content policy or budget), rolling health with automatic
  quarantine, durable influencer-scoped asset storage, per-attempt audit.
- Adapters: kie.ai, Higgsfield (incl. Soul ID training), fal.ai, Replicate,
  Runway, Luma (Agents API), Topview, plus an offline mock. 25 catalog models
  across image, reference/identity, edit, upscale and image/text-to-video.

**Calendar (backend)**: operator events (world or per influencer) feed the
content director and conversation context; ended events with an outcome are
recapped hourly into world memory.

**Fixes found during the upgrade**
- Webhook signature checks are awaited (they became async).
- Memory-extraction jobs carry their influencer.

Tests: 201 (router, engine fallback/idempotency/quarantine/budget, adapter
contracts for all providers, two-influencer isolation, settings, bootstrap,
calendar recaps).
