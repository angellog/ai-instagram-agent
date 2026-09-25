# Changelog

All notable changes. Versions are git tags; the running version is shown in the
console footer, `/health` and `/api/status`.

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
