# Build status

_Updated 2026-09-24._

## Milestones (brief §20)

| # | Milestone | Status | Tested by |
|---|---|---|---|
| 1 | Infrastructure (Railway, Postgres, Redis, event intake) | ✅ deployed, healthy | webhook-http, failures, live `/health` |
| 2 | Conversation agent | ✅ | conversation.test (13), e2e flow 1 |
| 3 | Memory (3 layers + policy) | ✅ | memory-policy, conversation, e2e flow 1 |
| 4 | Persona (YAML, versioned) | ✅ | content, live boot |
| 5 | Content planner (activity engine + director) | ✅ | content.test planning |
| 6 | Image generation (kie.ai) | ✅ | adapters (kie), content.test production, e2e flow 2 |
| 7 | Publishing (single image) | ✅ | content.test publishing |
| 8 | Carousel engine (4–6 slides) | ✅ | compose unit, content.test, e2e flow 2 |
| 9 | Analytics + learning loop | ✅ | engagement unit, content.test, e2e flow 2 |
| 10 | Autonomous operation (schedulers, sweeper, controls) | ✅ built · ⏸ live in `human_approval` | failures.test, live worker logs |

## Tests
`npm test` → **148 passed** (13 files): 95 unit, 46 integration (real Postgres + Redis, including 9 failure-mode tests), 2 end-to-end flows through real BullMQ workers. OpenReply relay: 10 new tests, 163 total passing there.

Brief §23 coverage: memory extraction, intent classification, repetition detection, content planning, safety classification, API adapters (unit) · event→worker, worker→LLM/DB/KIE/publishing API (integration) · Instagram API failure, LLM timeout, KIE failure, duplicate webhook, duplicate publishing, DB failure, Redis failure, malformed LLM output (failure) · both E2E chains.

## Operator steps

- [x] Claude key with credit (2026-09-25; live DM test passed)
- [x] Persona account connected: @zurikarale, IG user id 17841427470541858
- [x] Credentials on Railway (`scripts/set-railway-secrets.sh`)
- [x] angellog/openreply#1 merged
- [x] Railway GitHub App installed for this repo (push to `main` deploys)
- [x] Relay variables on OpenReply (Vercel + Railway worker); @zurikarale subscribed to `comments` + `messages`
- [x] First post published 2026-09-25: https://www.instagram.com/p/DdsTKMDmkFm/
- [ ] Profile photo, name, bio and highlights set in the Instagram app (kit in `output/profile/`)
- [ ] 24h in `dry_run`, then `human_approval`, then `autonomous`

## Known limitations
- Story mentions are recorded but not answered (no reply endpoint for mentions).
- Carousel-album insights: whether the parent returns FEED metrics is unverified; the collector requests metrics individually and tolerates gaps.
- kie per-image price is unverified; the ledger uses actual `creditsConsumed` and a configurable USD rate.
- Repetition uses lexical similarity (no embeddings); paraphrases with totally different wording can pass.
- Persona reload from the dashboard affects the web process immediately and workers on their next restart.
- Reels/video are out of scope for v1 (images and carousels only).

## Next executable task
Run `scripts/set-railway-secrets.sh --from-feetbit`, connect the persona account, set mode to `dry_run` in `/admin/controls` for 24h, review `/admin/posts` and `/admin/conversations`, then switch to `human_approval`.
