# Railway deployment

**Live:** project `ai-instagram-agent` (id `d809f9a3-05cc-4d24-8932-29de192e9c97`), environment `production`.

| Service | What | URL |
|---|---|---|
| `web` | `ROLE=web`: webhooks, OAuth, dashboard, `/health` | https://web-production-2a489.up.railway.app |
| `worker` | `ROLE=worker`: BullMQ workers + schedulers | private |
| `postgres` | Railway Postgres | private (`DATABASE_URL`) |
| `redis` | Railway Redis | private (`REDIS_URL`) |

Infrastructure is defined in `.railway/railway.ts`:

```bash
railway config plan     # what would change
railway config apply    # converge
```

Migrations run on boot of either role (advisory-locked, forward-only).

## Secrets

Generated at deploy (values in the gitignored `output/railway-secrets.env`, mode 600): `ADMIN_TOKEN`, `ENCRYPTION_KEY`, `OPENREPLY_RELAY_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `PUBLIC_BASE_URL`.

Operator credentials (not set by the build; see SECURITY.md):

```bash
scripts/set-railway-secrets.sh --from-feetbit            # LLM (Anthropic), kie, Supabase, imgbb from sibling projects
scripts/set-railway-secrets.sh path/to/instagram.env     # INSTAGRAM_APP_ID/SECRET, INSTAGRAM_ACCOUNT_ID/ACCESS_TOKEN, TELEGRAM_*
```

## Deploying new code

The services point at `github.com/angellog/ai-instagram-agent` (branch `main`). Until the Railway GitHub App is granted access to that repo (GitHub → Settings → Applications → Railway → Repository access), deploy by upload:

```bash
railway up --service web --detach && railway up --service worker --detach
```

After access is granted, every push to `main` deploys both services.

## Connecting OpenReply (event source)

1. Merge angellog/openreply#1.
2. On OpenReply's Vercel project **and** its Railway worker set:
   `AGENT_RELAY_URL=https://web-production-2a489.up.railway.app/webhooks/openreply`,
   `AGENT_RELAY_SECRET=<OPENREPLY_RELAY_SECRET from output/railway-secrets.env>`,
   `AGENT_RELAY_ACCOUNT_IDS=<persona account id>`.
3. In the agent set `OPENREPLY_DEFER_KEYWORDS` to every OpenReply campaign keyword on that account.

Alternative for a dedicated Meta app: point its webhook at `/webhooks/instagram` with `WEBHOOK_VERIFY_TOKEN`, subscribe `comments` and `messages`, and set `INSTAGRAM_APP_SECRET`.

## Connecting the persona's Instagram account

Either set `INSTAGRAM_ACCOUNT_ID` + `INSTAGRAM_ACCESS_TOKEN` (long-lived token; refreshed daily by the worker), or add `https://web-production-2a489.up.railway.app/oauth/instagram/callback` as a redirect URI in the Meta app and use **Connect Instagram** on the dashboard. Requirements: Business/Creator account, public, and the in-app **AI-generated profile** label turned on.

## Checks

```bash
curl -s https://web-production-2a489.up.railway.app/health
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://web-production-2a489.up.railway.app/api/status
railway logs --service worker
```
