---
researched: 2026-09-24
method: official docs (developers.facebook.com, docs.kie.ai via kie MCP, docs.railway.com, docs.bullmq.io, platform.claude.com), npm registry, plus an audit of existing local projects
---

# Research findings

Every claim has a source and an implementation implication. Items marked
**UNVERIFIED** could not be confirmed against a primary source on the research
date; the code treats them defensively (see "How the code handles it").

## 0. Breaking changes that shaped the design

| Finding | Source | What we did |
|---|---|---|
| Railway Config-as-Code (`railway.json`/`railway.toml`) is deprecated; new services cannot opt in and existing files stop being read **2026-12-01**. Replacement is Infrastructure-as-Code, `.railway/railway.ts` (`npm i railway`, `railway/iac`). | https://docs.railway.com/config-as-code · https://docs.railway.com/infrastructure-as-code | Deployment is defined in `.railway/railway.ts`. No `railway.json`. |
| BullMQ is v6 (6.3.8, 2026-09-18). Repeatable jobs (`repeat`, `getRepeatableJobs`) and `debounce` are removed. v6 throws on legacy repeatable data. | https://docs.bullmq.io/guide/migrations/migrate-from-v5-to-v6 | All recurring work uses `upsertJobScheduler`. Fresh Redis prefix `aia`. |
| Instagram media containers accept `is_ai_generated=true` (self-disclosure). Since 2026-08-31, accounts featuring AI-generated people without the in-app **"AI-generated profile"** label get reduced reach. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media · https://techcrunch.com/2026/08/31/instagram-puts-new-limits-on-undisclosed-ai-profiles/ | Every container is created with `is_ai_generated=true`. Setting the profile label is an operator step (no API field found). |
| Anthropic `output_format` is deprecated; use `output_config.format`. Sonnet 5 rejects assistant prefill. | https://platform.claude.com/docs/en/about-claude/models/overview.md | Structured output via `output_config` JSON schema + zod validation + one repair retry. No prefill anywhere. |
| Graph API v26.0 released 2026-07-29; Instagram docs still show v25.0. | https://developers.facebook.com/docs/graph-api/changelog | `META_GRAPH_API_VERSION` env, default `v25.0` (matches OpenReply, documented examples). |

## 1. OpenReply (local fork `~/Projects/openreply`, upstream `diwenne/openreply`)

Inspected 2026-09-24 at commit `059cf3a`.

- **Stack:** Next.js 16 (Vercel) + BullMQ worker (`worker/dm-worker.ts`, Railway) + Prisma 7 / Postgres + Redis.
- **Instagram integration:** Instagram API with Instagram Login; OAuth at `app/api/instagram/{connect,callback}`; tokens AES-encrypted in `InstagramAccount`; refresh via `/api/cron/refresh-tokens`.
- **Webhook:** `app/api/webhook/route.ts` verifies `X-Hub-Signature-256` against *either* the Instagram or Facebook app secret (`lib/meta/webhook.ts`), stores the payload in `WebhookEvent`, then parses comments / messages / postbacks / reads and enqueues keyword-campaign jobs.
- **Worker:** one BullMQ queue for DM sends with per-account rate limiting (750 private replies/hour).
- **Extension point:** none for third-party consumers. Meta allows **one webhook callback URL per app**, and OpenReply owns it.
- **Implication:** the agent cannot also be the Meta webhook without a second Meta app. We added a small, opt-in **relay** to OpenReply that forwards the already-verified raw body to the agent, HMAC-signed with a shared secret and filtered to the persona's account id. The agent also accepts direct Meta webhooks so it stands alone (for a dedicated Meta app). See DECISIONS.md D-02.

## 2. Instagram API with Instagram Login (graph.instagram.com)

### Publishing
- `POST /{ig-user-id}/media` → container; `GET /{container-id}?fields=status_code`; `POST /{ig-user-id}/media_publish` with `creation_id`. Source: https://developers.facebook.com/docs/instagram-platform/content-publishing
- `status_code`: `FINISHED`, `IN_PROGRESS`, `ERROR`, `EXPIRED` (24 h), **`PUBLISHED`**. → Retry path checks `PUBLISHED` before calling `media_publish` again, which is what prevents duplicate posts after a lost response.
- Carousel: children with `is_carousel_item=true`, parent `media_type=CAROUSEL`, `children` = up to **10** ids; all slides are cropped to the first slide's aspect ratio. → Composer outputs every slide at 1080×1350 (4:5).
- Limit: **100** API-published posts per rolling 24 h (a carousel counts as one); `GET /{ig-user-id}/content_publishing_limit`. → Checked before every publish.
- Images: **JPEG only**, ≤ 8 MB, aspect 4:5 … 1.91:1, width 320–1440, sRGB. → Composer re-encodes to sRGB JPEG q88 at 1080×1350.
- Optional fields used: `alt_text` (≤ 1000 chars, images), `is_ai_generated`. **Verified live 2026-09-25:** for carousels `is_ai_generated` must be set on the CAROUSEL container only; on a carousel item Meta returns code 100 / subcode 2207100.
- Meta recommends polling container status about once a minute for ≤ 5 minutes; we poll with backoff (3 s → 30 s, ≤ 5 min) because image containers usually finish in seconds.

### Comments
- Reply: `POST /{ig-comment-id}/replies` (`message`). Hide: `POST /{comment-id}` (`hide=true`). Source: https://developers.facebook.com/docs/instagram-platform/comment-moderation
- Webhook `field: "comments"`, `value: {id, text, from{id,username}, media{id, media_product_type}}`. `parent_id` for replies is **UNVERIFIED** (absent from Meta's example) → treated as optional.

### Messaging
- `POST /{ig-id}/messages` with `recipient: {id}`; private reply to a comment uses `recipient: {comment_id}`. Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api · https://developers.facebook.com/docs/instagram-platform/private-replies
- Private reply: within **7 days** of the comment, **one** per commenter until they reply.
- Standard window: **24 h** after the user's last message. `HUMAN_AGENT` tag (7 days) is for humans only; the bot never uses it.
- Rate limits per account: Send API 100 calls/s (text), Conversations API 2 calls/s, private replies **750/hour**. Source: https://developers.facebook.com/docs/instagram-platform/overview
- Webhook `entry[].messaging[]`: `sender.id`, `recipient.id`, `timestamp`, `message{mid,text,is_echo}`. → `is_echo` is dropped; `mid` is the idempotency key.

### Insights
- Media (`GET /{media-id}/insights`): `views, reach, likes, comments, saved, shares, total_interactions, profile_visits, follows` (+ `profile_activity`, `reposts`). `impressions`, `plays` etc. are **deprecated** (v22 / 2025-04-21). Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/insights
- Carousel children have no insights; query the parent album (parent returning FEED metrics is **UNVERIFIED** → collector requests metrics individually and tolerates per-metric errors).
- Data can lag up to **48 h**. → Checkpoints at 24 h, 72 h and 7 d; the score uses the latest checkpoint.
- Account (`GET /{ig-user-id}/insights`, `period=day`, `metric_type=total_value`): `reach, views, accounts_engaged, total_interactions, …`; `follower_count` needs 100+ followers. → Followers are read from the profile `followers_count` field instead.

### Webhooks, tokens, permissions
- Verification handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`); `X-Hub-Signature-256` = HMAC-SHA256(raw body, app secret). Source: https://developers.facebook.com/docs/instagram-platform/webhooks
- Scopes: `instagram_business_basic, instagram_business_content_publish, instagram_business_manage_comments, instagram_business_manage_messages, instagram_business_manage_insights`.
- Long-lived token (60 d) refresh: `GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`, allowed when ≥ 24 h old and unexpired. → Daily scheduler refreshes tokens with < 20 days left and alerts at < 7 days.
- Webhooks require the app Live, Advanced Access for `comments`, and a **public** account.

## 3. kie.ai (primary source: docs.kie.ai via the kie MCP)

- `POST https://api.kie.ai/api/v1/jobs/createTask` `{model, callBackUrl?, input}` → `{code:200, data:{taskId}}`. Envelope `code !== 200` is an error even with HTTP 200 (matches `~/Projects/kickshot/src/kie.mjs`).
- `GET /api/v1/jobs/recordInfo?taskId=` → `state: waiting|queuing|generating|success|fail`, `resultJson` (a JSON **string**, `{resultUrls:[…]}`), `failCode`, `failMsg`, `costTime`, `creditsConsumed`.
- Codes: 401, **402 insufficient credits** (→ fail over to next key), 422, **429** (→ transient), 455 maintenance, 501 generation failed.
- Rate limit: 20 new tasks / 10 s per account.
- Retention: results 14 days (recordInfo page says URLs "typically expire after 24 hours") → results are copied to durable storage immediately after success.
- Uploads: `https://kieai.redpandaai.co/api/file-url-upload|file-stream-upload|file-base64-upload`, free, deleted after 24 h.
- Balance: `GET /api/v1/chat/credit`.
- Models (ids for `createTask`):

| Model | id | Reference field | Notes |
|---|---|---|---|
| Nano Banana Pro | `nano-banana-pro` | `image_input[]` ≤ 8 | `aspect_ratio` incl. `4:5`, `resolution` 1K/2K/4K, `output_format` png/jpg |
| Nano Banana 2 | `nano-banana-2` | `image_input[]` ≤ 14 | as above |
| Nano Banana Edit | `google/nano-banana-edit` | `image_urls[]` ≤ 10 | |
| Seedream 4.5 Edit | `seedream/4.5-edit` | `image_urls[]` ≤ 14 | no 4:5 |
| GPT Image 2.5 Flare i2i | `gpt-image-2-5-flare-image-to-image` | `input_urls[]` ≤ 16 | Kickshot's current default |

  → `src/kie/models.ts` is a per-model input adapter; default `nano-banana-pro` at 4:5, 2K, jpg, with the persona reference images.
- Pricing per image: **UNVERIFIED** (pricing page not machine-readable; docs say "typically 10–50 credits"). → The ledger records the real `creditsConsumed` from each task; `KIE_USD_PER_CREDIT` (default 0.005) converts to USD; budgets use a conservative pre-estimate of 24 credits.

## 4. Railway

- Config-as-Code deprecated (see §0). IaC: `defineRailway`, `project`, `service`, `postgres`, `redis`; `railway config plan|apply`. Source: https://docs.railway.com/infrastructure-as-code/reference
- Cron services: UTC, ≥ 5 min interval, process must exit. Source: https://docs.railway.com/reference/cron-jobs → Not used; BullMQ schedulers inside the always-on worker are cheaper and keep one code path (DECISIONS D-04).
- Private networking `<service>.railway.internal` (runtime only). Postgres `DATABASE_URL`, Redis `REDIS_URL` (there is no `REDIS_PRIVATE_URL`). Sources: https://docs.railway.com/databases/postgresql · https://docs.railway.com/databases/redis
- Hobby: $5/month incl. $5 usage; ~$20/vCPU-month, ~$10/GB-RAM-month. Source: https://railway.com/pricing

## 5. BullMQ v6

- `queue.upsertJobScheduler(id, {pattern|every, tz}, {name, data, opts})` — idempotent by id.
- Custom `jobId` dedupes adds; ids must not contain `:` and must not be purely numeric.
- `attempts` + `backoff: {type: 'exponential'}`; worker `concurrency`; ioredis `maxRetriesPerRequest: null`.
- Source: https://docs.bullmq.io/guide/jobs/job-ids · https://docs.bullmq.io/guide/job-schedulers

## 6. LLM (Anthropic Claude)

- Models: `claude-sonnet-5` ($2 / $10 per MTok), `claude-haiku-4-5-20251001` ($1 / $5), `claude-opus-5-5` ($4 / $20). Source: https://platform.claude.com/docs/en/about-claude/pricing.md
- Structured outputs via `output_config.format` (json_schema). SDK `@anthropic-ai/sdk` 0.128.0.
- Fallback: any OpenAI-compatible endpoint (e.g. OpenRouter `https://openrouter.ai/api/v1`, slug `anthropic/claude-sonnet-5`). Whether OpenRouter honours `response_format: json_schema` for Claude is **UNVERIFIED** → the provider asks for JSON in the prompt and validates with zod regardless.

## 7. Existing FeetBit code reused (not rebuilt)

| Need | Reused from | Notes |
|---|---|---|
| kie client (envelope handling, key failover on 402, polling backoff) | `kickshot/src/kie.mjs`, `kie-mcp/index.js` | Ported to TypeScript with injectable fetch. |
| Public image hosting (Supabase → imgbb, verify 200 + image/*) | `kickshot/src/host.mjs` | Ported; FeetBit standing rule. |
| Zuri character description, outfits, Kampala scenes | `kickshot/src/creative.mjs` | Moved into `config/persona.yaml`. |
| Webhook signature (accept Instagram *or* Facebook app secret) | `openreply/lib/meta/webhook.ts` | Same behaviour. |
| Caption limits (2,200 chars, 30 hashtags) | `ig-poster/src/publish.mjs` `fitCaption` | Ported. |
| Carousel publish | `meta-graph-publisher`, `feetbit-content-library` | Rewritten: both skip polling the parent carousel container and ignore `PUBLISHED`/`EXPIRED`. |
