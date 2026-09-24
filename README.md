# ai-instagram-agent

An autonomous AI Instagram persona: it answers comments and DMs with memory, plans its own content from a virtual daily life, generates realistic images through kie.ai, builds 4–6 slide carousels, publishes through the official Instagram API, and learns from engagement. Safety-gated, cost-capped and auditable.

The default persona is **Zuri**, FeetBit's AI sneaker creator in Kampala. She is openly an AI (`config/persona.yaml`).

**Live:** https://web-production-2a489.up.railway.app (Railway; login with `ADMIN_TOKEN`). Status and next steps: [BUILD_STATUS.md](BUILD_STATUS.md).

## How it works

```
Instagram → Meta → OpenReply (relay) → web → Redis → worker ──► Claude · kie.ai · Supabase · Instagram API
                                                     │
                                                     └──► Postgres (memory, content, audit, costs)
```

- **Conversation agent**: perception → memory + post + knowledge retrieval → intent → reasoning and action choice (reply, ask, ignore, escalate, hide) → safety → idempotent send → memory update. It does not reply to everything.
- **Memory**: identity (persona), world (recent posts, follower requests, what performed), relationship (per follower). A deterministic policy decides what is stored, what expires and what is never stored.
- **Content brain**: a seeded virtual day, a Content Director that may decide *not* to post, repetition scoring with feedback, outfit/time/hair continuity, Visual Director prompts with reference images, vision QC, carousel composition, safety.
- **Publisher**: carousel/single containers with `is_ai_generated`, duplicate-proof across retries, crashes and concurrent workers.
- **Learning**: insights at 24h/72h/7d → engagement score (saves, shares and follows weigh more than likes) → learnings the director sees.
- **Controls**: `development`, `dry_run`, `human_approval` (default), `autonomous`, plus pause, rate limits and budgets, all changeable live in `/admin/controls`.

## Run it locally (no API keys needed)

```bash
npm install
docker compose up -d            # or local Postgres + Redis
cp .env.example .env            # set DATABASE_URL, LLM_PROVIDER=mock, MOCK_IMAGES=true
npm run dev                     # web + worker on http://localhost:3000/admin
```

Try it:

```bash
npm run cli -- controls:set mode=dry_run
npm run cli -- simulate "I love Jordan 4s, which colourway next?"
npm run cli -- plan
```

## Tests

```bash
createdb aia_test
npm test          # 138 tests: unit, integration (real Postgres/Redis), failure modes, 2 end-to-end flows
```

## Docs

| | |
|---|---|
| [docs/RESEARCH.md](docs/RESEARCH.md) | Current API facts with sources and implications |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, pipelines, data model, reliability |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Build order and repository layout |
| [docs/deployment/RAILWAY.md](docs/deployment/RAILWAY.md) | Deploy, secrets, OpenReply and Instagram connection |
| [docs/operations/RUNBOOK.md](docs/operations/RUNBOOK.md) | Operating, troubleshooting, manual actions |
| [DECISIONS.md](DECISIONS.md) · [SECURITY.md](SECURITY.md) · [COSTS.md](COSTS.md) · [BUILD_STATUS.md](BUILD_STATUS.md) | |

## Change the persona

Edit `config/persona.yaml` (identity, voice, boundaries, appearance, reference images, locations, daily activities, carousel structures, hashtags) and `config/knowledge.yaml` (business facts the agent may cite). No code changes. `npm run cli -- persona:check` validates it.
