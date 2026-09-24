# Architecture

## Shape

```
Instagram ──► Meta webhook ──► OpenReply (owns the app's one webhook URL; keyword campaigns)
                                   │  verified body, HMAC-signed, retried from a queue
                                   ▼
                     ┌──────────── web (ROLE=web) ─────────────┐
                     │ /webhooks/openreply  /webhooks/instagram │  store raw event (dedup by sha256)
                     │ /admin dashboard  /api/status  /oauth    │  → enqueue instagram.event
                     └──────────────────┬───────────────────────┘
                                        │ Redis (BullMQ v6, prefix "aia")
                     ┌──────────── worker (ROLE=worker) ────────┐
                     │ events        instagram.event            │ normalize → interactions (unique)
                     │ conversation  conversation.process       │ Conversation Agent
                     │               memory.extract             │ Memory Agent
                     │ content       content.plan               │ Activity engine + Content Director
                     │               content.produce            │ Visual Director → kie → QC → compose → safety
                     │ publish       post.publish (serial)      │ Publisher
                     │ analytics     engagement.collect …       │ Engagement engine + learning
                     │ maintenance   token.refresh, sweep …     │ recovery, expiry
                     └──────────────────┬───────────────────────┘
                                        ▼
                                PostgreSQL (all state, audit, costs)
External: Claude (LLM) · kie.ai (images) · Supabase Storage → imgbb (public media) · Instagram Graph API · Telegram (optional alerts)
```

One codebase, one Docker-less Node build, three roles (`web`, `worker`, `all`). Railway runs `web` and `worker` as separate services from the same repo (see DECISIONS.md D-04).

## The agents (logical, not processes)

| Agent | Code | Job |
|---|---|---|
| Persona | `config/persona.yaml`, `src/persona/*` | Identity, voice, boundaries, visual profile, daily life. Versioned by hash in `persona_versions`. |
| Conversation | `src/conversation/agent.ts` | The pipeline below. |
| Memory | `src/memory/*` | Extraction (LLM proposes) + policy (code decides) + retrieval + expiry. |
| Content Director | `src/content/director.ts` | Decides *whether* to post, designs the idea, gets vetoed by repetition. |
| Visual Director | `src/content/visual.ts`, `continuity.ts` | Prompts that hold identity, outfit, light and place; cross-post continuity. |
| Carousel | `src/content/produce.ts`, `src/render/compose.ts` | Slide generation, text layout, 1080×1350 JPEG. |
| Quality/Safety | `src/content/qc.ts`, `src/safety/*` | Pixel checks, vision QC, structural QC; rules + LLM moderation → green/yellow/red. |
| Publisher | `src/content/publish.ts` | Duplicate-proof container state machine. |
| Engagement | `src/analytics/learnings.ts` | Insights at 24h/72h/7d, score, learnings fed back to the director. |

## Conversation pipeline (brief §2, §4)

```
event → normalize (drop echoes/self/other accounts) → interaction row (unique kind+id)
  → user upsert → conversation upsert → inbound message
  → deterministic perception (paused, blocked user, OpenReply keyword, emoji-only, spam, story mention)
  → inbound safety rules (red → never engage; hide abusive comments in autonomous mode)
  → context: thread history, relationship memories, the post (own DB or Graph), knowledge base, recent posts
  → intent classification (fast model)
  → reasoning + action selection (smart model): reply | ask_clarifying | ignore | escalate | hide,
      channel public/private/dm, reply_value, cited memory/knowledge ids, workflow trigger
  → drop invented memory/knowledge ids · low-value → ignore · optional replies sampled
  → throttles (per-hour) · Meta windows (24h DM, 7d private reply)
  → outbound safety (rules + moderator; fails closed to yellow)
  → gate by mode: send | review | dry_run | block
  → reserve outbound slot (unique interaction+channel) → deliver → memory.extract (delayed job)
  → agent_decisions row (intent, action, confidence, safety, context_used, reason)
```

## Content loop (brief §6, §7, §19)

```
scheduler (persona local time) → content.plan
  → posting gate (paused, window, in-flight post, daily cap, spacing)       ← no LLM spend if closed
  → day plan (seeded, weighted, one per slot, weekday aware, location rotation)
  → director: post or wait (sees plan, recent posts, learnings, follower requests)
  → continuity (outfit/time-of-day/hairstyle) → repetition score (reject → feedback → retry ≤ N)
  → content.produce: per slide: budget → kie task (persisted task id) → download → pixel check
       → vision QC (identity, anatomy, text) → retry ≤ max_retries_per_image → compose → host → verify
  → structural QC → safety on caption + overlays → gate → approved (scheduled in window) | review | dry_run
  → post.publish → markPublished → engagement.collect ×3 (delayed) → analytics.process nightly → learnings
```

## Data model

`db/migrations/001_init.sql` (18 tables). Idempotency keys: `webhook_events.dedup_key`, `interactions(kind, ig_object_id)`, `messages(interaction_id, channel) WHERE out`, `posts.ig_media_id`, `generation_jobs.task_id`, `engagement_metrics(post_id, checkpoint)`, memory `(layer, user, kind, key) WHERE active`. Audit: `agent_decisions`, `safety_reviews`, `system_events`, `job_runs`, `cost_ledger`.

## Reliability

- Every handler is idempotent; job ids are deterministic (`interaction-42`, `publish-<uuid>`).
- `PermanentError` → BullMQ `UnrecoverableError` (fail once); transient errors retry with backoff that honours Meta rate-limit windows.
- Final failure compensation marks the entity failed (no stuck states).
- `maintenance.sweep` every 10 min re-queues stalled interactions, production and publishing.
- Webhook ingest persists before enqueueing; Redis down → 503 so the sender retries.

## Operating modes (brief §27)

`development` (mocks allowed, nothing external), `dry_run` (full pipeline, nothing sent), `human_approval` (default; everything waits in /admin/reviews), `autonomous` (green automatic, yellow per `require_review_for_yellow`, red never). Plus `paused`.
