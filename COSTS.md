# Costs

Assumptions as of 2026-09-24 (sources in docs/RESEARCH.md). Observed numbers live in `/admin/costs` and `cost_ledger`.

## Unit prices
| Item | Price | Source |
|---|---|---|
| Claude Sonnet 5 (reasoning, planning) | $2 in / $10 out per MTok | Anthropic pricing |
| Claude Haiku 4.5 (classify, moderate, memory, vision QC) | $1 / $5 per MTok | Anthropic pricing |
| kie.ai `nano-banana-pro` 2K | real `creditsConsumed` per task × `KIE_USD_PER_CREDIT` (default $0.005); budget pre-estimate 24 credits ≈ $0.12 | kie docs; exact per-image price **unverified** |
| X API reads, app-only bearer (phase 1) | $0.005 per post, $0.010 per account returned | docs.x.com/x-api/getting-started/pricing |
| X API Owned Reads, as the app owner (phase 2+) | $0.001 per post/account for your own mentions, posts, followers | same |
| X API writes | $0.015 per post or reply; **$0.20 if the post contains a link** | same |
| Railway Hobby | $5/mo incl. $5 usage; ~$20/vCPU-mo, ~$10/GB-RAM-mo | railway.com/pricing |
| Supabase Storage / imgbb | existing FeetBit plans | — |

## Estimated per operation
| Operation | Calls | Est. cost |
|---|---|---|
| Conversation (reply) | classify (Haiku) + decide (Sonnet) + moderate (Haiku) | ≈ $0.006–0.01 |
| Memory extraction | 1 Haiku | ≈ $0.001 |
| Ignored comment (emoji, spam, keyword) | 0 LLM calls | $0 |
| Content plan | 1–4 Sonnet (repetition retries) | ≈ $0.02–0.08 |
| Image (per slide) | 1 kie task + 1 Haiku vision QC | ≈ $0.10–0.13 |
| 5-slide carousel | 5 images + QC + caption safety | ≈ $0.55–0.75 |
| Single image post | | ≈ $0.12–0.16 |
| X mentions poll (every 15 min) | 0 items when quiet; each mention = 1 post + its author | $0 quiet · ≈ $0.015 per new mention |
| X daily metrics | 1 account + up to 100 posts from the last 7 days | ≈ $0.01 + $0.005/post (~$0.06/day at 1 post/day) |

## Monthly envelope (1 post/day avg, 30 conversations/day)
Content ≈ $12–20 · conversations ≈ $6–9 · Railway ≈ $5–10 → **≈ $25–40/month**.

X read-only (phase 1), ~10 mentions/day: mentions ≈ $4.50 + metrics ≈ $1.80 → **≈ $6/month**, capped by `daily_x_api_budget_usd` ($0.50/day). Moving to Owned Reads in phase 2 cuts this about 5×.

## Limits (controls, defaults)
`daily_x_api_budget_usd` 0.5 · `x_daily_read_cap` 500 items ·
`daily_budget_usd` 3 · `monthly_budget_usd` 60 · `daily_llm_budget_usd` 1.5 · `daily_image_budget_usd` 2 · `max_retries_per_image` 2 · `max_posts_per_day` 2. A limit of 0 blocks that spend entirely. Checked before every paid call; production stops cleanly with a logged event when reached.

## Ledger
Every LLM call (tokens, model, operation, subject) and image task (credits) is recorded; `/admin/costs` shows daily/weekly/monthly cost and cost per post, conversation, image and carousel.
