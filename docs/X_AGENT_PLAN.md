# X (Twitter) channel — build plan

Adds X as a third channel to this agent (after Instagram and TikTok), for **@feetbitsneakers**.
Publishing stays in self-hosted Postiz; this agent owns conversation, lead-finding and learning.

## Jobs (agreed 2026-09-30)

1. **Reply to mentions and DMs** in FeetBit's voice — sizes, price, delivery, "is it real" questions.
2. **Auto-fill the calendar** — pull approved items from the Supabase content library, rewrite for X, queue in Postiz.
3. **Watch and report performance** — per-post metrics, weekly summary, feed learnings back to the planner.
4. **Listen for leads** — find people in Uganda asking about sneakers; draft a reply or flag to Angelo.

## Architecture (reuses what exists)

```
X API ──poll──► src/x/poll.ts ──► Redis queue ──► worker
                                                   │
        existing conversation agent (memory, safety, approval modes)
                                                   │
                        ├──► X API: reply / DM
                        ├──► Postiz API: queue scheduled posts
                        └──► Postgres: memory, audit, costs
```

New: `src/x/` (client, poll, leads, adapt, metrics) + `src/postiz/client.ts`.
Unchanged: conversation agent, memory, safety, controls, budgets, admin UI, cost ledger.

## Cost control (X API is pay-per-use, reads billed per object returned)

| Call | Cadence | Notes |
|---|---|---|
| Mentions poll (`since_id`) | every 15 min | returns 0 objects when quiet ≈ free |
| Replies sent | per reply | ~$0.015 |
| Lead search | 2×/day, `max_results` capped | the only read that reliably costs |
| Post metrics | 1×/day, batched by id | cheap per batch |

Hard caps in `config/controls` — daily read cap, daily reply cap, monthly USD ceiling. Worker
stops and alerts at the ceiling rather than degrading silently. Target: **under $10/month**.
Never put links in post text ($0.20 vs $0.015) — links live in bio.

## Phases

| Phase | Scope | Ships |
|---|---|---|
| **1** | `src/x/client.ts` + mentions poll + metrics; read-only, writes nothing | Mentions land in the admin queue; daily metrics |
| **2** | Replies through the existing conversation agent, `human_approval` mode | You approve each reply in the admin UI |
| **3** | Postiz bridge: library → X rewrite → queued posts, weekly report | Calendar fills itself |
| **4** | Lead search + flagging; optional `autonomous` mode for replies only | Account finds customers |

## Operator blockers

- **DMs need a scope change.** The X app is currently *Read and write*. DM read/write needs
  *Read, write and Direct Messages*, then regenerating keys and reconnecting Postiz — do this
  only when phase 2 lands, since it invalidates the current keys.
- Spend limit set in console.x.com (recommended $10/month).
- `X_API_KEY` / `X_API_SECRET` (+ user tokens) as Railway secrets on this project.

## Decisions

- **Publishing stays Postiz.** Avoids a second scheduler and keeps the calendar in one place.
- **Replies start gated.** `human_approval` until the reply quality is proven over ~2 weeks.
- **No persona.** This is FeetBit's own brand account, not Zuri — a separate voice profile,
  and it never claims to be a human employee when asked directly.
