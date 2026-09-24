# Implementation plan (as executed)

Brief §29 build order, with where each step landed. All steps are complete except the operator-owned items in BUILD_STATUS.md.

| # | Step | Result |
|---|---|---|
| 1 | Research APIs and OpenReply | docs/RESEARCH.md (sources, dates, implications) |
| 2 | Architecture document | docs/ARCHITECTURE.md |
| 3 | Technical plan | this file |
| 4 | Database schema | db/migrations/001_init.sql (18 tables, idempotency keys, audit) |
| 5 | Service boundaries | `web` / `worker` roles, DECISIONS D-04 |
| 6 | Event/job schemas | src/queue/queues.ts (`JOBS`), src/ingest/webhook.ts (`NormalizedInteraction`) |
| 7 | Local dev environment | docker-compose.yml, `.env.example`, `LLM_PROVIDER=mock`, `MOCK_IMAGES=true`, CLI |
| 8 | Minimal Railway infrastructure | .railway/railway.ts, applied |
| 9 | Connect OpenReply/Instagram | angellog/openreply#1 relay; `/webhooks/instagram`; OAuth `/admin/connect` |
| 10 | Webhook/event ingestion | src/web/server.ts, src/ingest/* |
| 11 | Conversation agent | src/conversation/* |
| 12 | Memory | src/memory/* |
| 13 | Persona | config/persona.yaml, src/persona/* |
| 14 | Safety layer | src/safety/* |
| 15 | Content planner | src/content/activities.ts, director.ts, repetition.ts, continuity.ts |
| 16 | KIE integration | src/kie/* |
| 17 | Media storage | src/storage/host.ts |
| 18 | Carousel generation | src/content/produce.ts, visual.ts, qc.ts, src/render/compose.ts |
| 19 | Instagram publishing | src/content/publish.ts, src/instagram/client.ts |
| 20 | Analytics | src/analytics/learnings.ts |
| 21 | Observability | system_events, job_runs, agent_decisions, cost_ledger, pino JSON logs, /admin, /api/status |
| 22 | Integration/E2E tests | tests/integration, tests/e2e |
| 23 | Staged production | Railway, `human_approval` mode |
| 24 | Monitor | dashboard, Telegram alerts, sweeper |
| 25 | Optimize cost/reliability | budgets, zero-LLM fast paths for ignorable comments, fast-model tiering |

## Repository layout

```
src/
  config/      env (zod) + runtime controls
  db/          pool, migration runner
  ingest/      webhook normalization, signatures, event processing
  conversation/ agent pipeline, context, prompts, idempotent send, knowledge
  memory/      policy, extraction, store
  persona/     schema, loader (versioned), prompt block
  safety/      rules, assessment, gate, reviews
  content/     activities, director, repetition, continuity, visual, produce, qc, caption, publish
  kie/         client, model adapters, generator (kie | mock)
  render/      slide composer (resvg + sharp)
  storage/     Supabase → imgbb → local hosting
  instagram/   Graph API client, accounts & tokens
  analytics/   insights, scoring, learnings
  cost/        ledger & budgets
  queue/       queues, workers, schedulers, sweeper
  llm/         provider interface, Anthropic, OpenAI-compatible, mock
  web/         Fastify server, dashboard, reviews
config/        persona.yaml, knowledge.yaml
db/migrations/ SQL
tests/         unit, integration, e2e, helpers (fake Instagram, fake kie)
```
