# Decisions

Each entry: context → decision → why → consequence. Dates are 2026-09-24 unless noted.

**D-01 New standalone repo, not an OpenReply fork.**
OpenReply is a Next.js comment-to-DM campaign tool; the agent is a long-running reasoning system with its own schema, queues and workers. Forking would drag in auth, workspaces, billing remnants and the Next runtime. The brief allows a fork only if it can stand alone; this build takes the ideas (signature check with either app secret, BullMQ worker split) and none of the attachments. The agent runs with or without OpenReply.

**D-02 OpenReply relays events instead of the agent owning the webhook.**
Meta allows one webhook callback URL per app and OpenReply owns it for FeetBit's accounts. A second Meta app would mean a second app review. OpenReply gained an opt-in relay (angellog/openreply#1): verified body, `t=,v1=` HMAC with replay window, filtered to the persona's account, retried from a dedicated queue. The agent still accepts direct Meta webhooks (`/webhooks/instagram`) for a dedicated app.

**D-03 Double-answer prevention with OpenReply campaigns.**
Campaign keywords are listed in `OPENREPLY_DEFER_KEYWORDS`; the agent stays silent on them. Chosen over reading OpenReply's database (coupling, the Meridian lesson in Ongoing.md).

**D-04 Two Railway app services (web, worker) + Postgres + Redis; BullMQ schedulers instead of Railway cron.**
An idle Node service costs roughly $1-2/month, so splitting is cheap, and it keeps webhook intake alive through worker crashes or heavy image jobs. Railway cron services must exit and have ≥5 min granularity; BullMQ `upsertJobScheduler` in the always-on worker needs no extra service and shares code paths with manual triggers.

**D-05 Railway Infrastructure-as-Code (`.railway/railway.ts`), not `railway.json`.**
Config-as-Code is deprecated and stops being read 2026-12-01. Secrets use `preserve()` and are never in the file.

**D-06 Plain SQL migrations + `pg`, no ORM.**
Full control over partial unique indexes and `ON CONFLICT` idempotency, no codegen step in the build, tiny runtime.

**D-07 Structured outputs everywhere, validated with zod, one repair round.**
Anthropic `output_config.format` (JSON schema) when supported; any provider's output is validated; a malformed answer gets one repair turn; twice malformed is a permanent error (no retry storm).

**D-08 Deterministic policy around every model decision.**
The LLM proposes; code decides: memory policy, safety rules, repetition score, continuity, throttles, windows and gates are deterministic and unit-tested. The model can never cite a memory it wasn't shown (ids are filtered and the drop is audited).

**D-09 Lexical repetition scoring (no embeddings) in v1.**
Word-cosine and 3-gram Jaccard plus categorical penalties (location, activity, outfit, structure, shot sequence). Free, explainable (reasons are fed back to the director), testable. Embeddings can be added behind the same function.

**D-10 Default persona is Zuri, FeetBit's existing AI model, openly an AI.**
Reuses the established character (Kickshot, Higgsfield reference). Disclosure is part of identity: she says she is an AI when sincerely asked, `is_ai_generated=true` is sent on every post, and an outbound rule blocks "I'm a real human". Since 2026-08-31 Instagram cuts reach for undisclosed AI-person accounts, so this is also the growth-optimal choice.

**D-11 kie.ai `nano-banana-pro` at 4:5 with persona reference images; cover reused as environment reference.**
kie first per FeetBit standing rule. 4:5 is the tallest ratio Instagram accepts; one ratio for all slides (carousels crop to the first). Sequential slides (cover first) trade speed for series consistency, the approach Kickshot proved.

**D-12 Vision QC with the fast model before composition.**
Catches anatomy errors, garbled text, extra people and identity drift for about $0.003 per image, far cheaper than a bad post. Skipped for the offline mock generator.

**D-13 Text overlays rendered with resvg + bundled OFL fonts.**
Identical output on a laptop and a font-less container; no headless browser in production.

**D-14 Publishing is a persisted state machine behind an advisory lock.**
Container ids are saved before the next call; `PUBLISHED` container status triggers feed recovery instead of a second `media_publish`. Tested for lost responses, crashes mid-carousel, concurrency and expired containers.

**D-15 Outbound message slot reserved before sending.**
Unique `(interaction_id, channel)`. A send whose outcome is unknown (network drop) is not retried: a missing reply is better than a duplicate public reply. A send Meta explicitly rejected (429/5xx with an error body) is re-armed and retried.

**D-16 Fresh deploy starts in `human_approval` mode.**
Nothing reaches Instagram until an operator approves it or switches to `autonomous` in /admin/controls.

**D-17 Operator credentials are not copied between projects by the agent.**
The deploy has generated internal secrets only. LLM, kie, Supabase, imgbb and Instagram credentials are set by the operator (`scripts/set-railway-secrets.sh` reads them from local env files).
