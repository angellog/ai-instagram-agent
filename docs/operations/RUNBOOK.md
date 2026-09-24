# Runbook

## Daily glance
Open `/admin`. Check: pending reviews, spend vs budget, queue `failed` counts, warnings. Everything important also pings Telegram if `TELEGRAM_*` is set.

## Stop everything now
`/admin` → **Pause everything** (or `npm run cli -- controls:set paused=true`). Webhooks keep being stored; nothing is planned, sent or published. Approved posts wait and are re-queued by the sweeper after resume.

## Going live, step by step
1. `dry_run` for a day: every stage runs, nothing leaves. Read `/admin/conversations` and `/admin/posts`.
2. `human_approval`: approve replies and posts from `/admin/reviews` (edit before approving if needed).
3. `autonomous` with `require_review_for_yellow=true`. Keep budgets tight at first.

## Symptoms → causes

| Symptom | Look at | Usual cause / fix |
|---|---|---|
| No interactions arriving | `/admin/events` (webhook signature warnings), OpenReply env | Relay not configured, secret mismatch, wrong account id in `AGENT_RELAY_ACCOUNT_IDS` |
| Interactions `failed` | `/admin/conversations`, `job_runs` | LLM key missing/invalid (`anthropic auth`), budget reached |
| "Token refresh failed" error | `/admin/events` | Token revoked or expired: reconnect via `/admin/connect` or set a new `INSTAGRAM_ACCESS_TOKEN` and delete the `ig_accounts` row |
| Posts stuck in `generating` | post page → Image generation table | kie out of credits (all keys 402), kie outage; sweeper retries every 10 min |
| Post `qc_failed` | post page → Decision trail | Vision QC kept rejecting (identity drift, hands). Improve reference images in persona.yaml; raise `max_retries_per_image` |
| Post `failed` at publish | post page `last_error` | Image URL not public (Supabase quota; imgbb fallback), 100/24h quota, token |
| Director keeps saying "wait" | `/admin/content` | Working as intended, or `repetition_threshold` too strict / too little variety in persona activities |
| Nothing planned | `/admin/content` activity plan empty | Outside posting window, a post already in the pipeline, `max_posts_per_day` reached, paused |

## Manual actions
- Run planner now: `/admin` → Run content planner now.
- Re-publish a failed post: post page → Publish now (idempotent; never duplicates).
- Forget a person (privacy request): `/admin/people/<id>` → Forget this person.
- Mute/block/VIP a person: same page → trust.
- Change persona: edit `config/persona.yaml`, deploy; or reload from `/admin/persona` (validates first).
- Recover stalled work: `/admin` → Recover stalled work (the sweeper also runs every 10 min).

## Useful SQL
```sql
-- what did the agent decide today
SELECT agent, action, intent, safety_level, reason FROM agent_decisions WHERE created_at > now() - interval '1 day' ORDER BY id DESC;
-- cost by operation this month
SELECT category, operation, round(sum(cost_usd)::numeric, 4) FROM cost_ledger WHERE occurred_at > date_trunc('month', now()) GROUP BY 1,2 ORDER BY 3 DESC;
```
