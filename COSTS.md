# Costs

Assumptions as of 2026-09-24 (sources in docs/RESEARCH.md). Observed numbers live in `/admin/costs` and `cost_ledger`.

## Unit prices
| Item | Price | Source |
|---|---|---|
| Claude Sonnet 5 (reasoning, planning) | $2 in / $10 out per MTok | Anthropic pricing |
| Claude Haiku 4.5 (classify, moderate, memory, vision QC) | $1 / $5 per MTok | Anthropic pricing |
| kie.ai `nano-banana-pro` 2K | real `creditsConsumed` per task × `KIE_USD_PER_CREDIT` (default $0.005); budget pre-estimate 24 credits ≈ $0.12 | kie docs; exact per-image price **unverified** |
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

## Monthly envelope (1 post/day avg, 30 conversations/day)
Content ≈ $12–20 · conversations ≈ $6–9 · Railway ≈ $5–10 → **≈ $25–40/month**.

## Limits (controls, defaults)
`daily_budget_usd` 3 · `monthly_budget_usd` 60 · `daily_llm_budget_usd` 1.5 · `daily_image_budget_usd` 2 · `max_retries_per_image` 2 · `max_posts_per_day` 2. A limit of 0 blocks that spend entirely. Checked before every paid call; production stops cleanly with a logged event when reached.

## Ledger
Every LLM call (tokens, model, operation, subject) and image task (credits) is recorded; `/admin/costs` shows daily/weekly/monthly cost and cost per post, conversation, image and carousel.
