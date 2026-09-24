# Security

## Secrets
- Never committed. `.env*`, `output/` are gitignored; `.env.example` lists names only; `.railway/railway.ts` uses `preserve()`.
- Instagram tokens are stored AES-256-GCM encrypted (`ENCRYPTION_KEY`, 32-byte hex). Production refuses to boot without `ENCRYPTION_KEY` and `ADMIN_TOKEN`.
- Tokens go in `Authorization: Bearer` headers, never URLs; pino redacts token/key fields.
- Rotation: `ADMIN_TOKEN` any time (invalidates sessions). `ENCRYPTION_KEY` rotation requires reconnecting Instagram (stored token becomes unreadable). `OPENREPLY_RELAY_SECRET` must change on both sides together.

## Inbound authentication
- Meta webhooks: `X-Hub-Signature-256` HMAC over the raw body with the Instagram or Facebook app secret, constant-time compare.
- OpenReply relay: `t=<unix>,v1=<hmac(secret, t.body)>`, rejected outside ±5 minutes (replay protection).
- Verify handshake uses `WEBHOOK_VERIFY_TOKEN` (constant-time).
- Dashboard/API: `ADMIN_TOKEN` via Bearer or an HttpOnly, SameSite=Lax, Secure session cookie derived by HMAC (the token itself is never stored in the cookie). Open access only when `NODE_ENV!=production` and no token is set (banner shown).
- OAuth `state` is HMAC-signed with a 15-minute lifetime. `next` redirects are restricted to `/admin` paths.
- Local media route rejects path traversal.

## Permissions (least privilege)
Instagram Login scopes: `instagram_business_basic`, `…_content_publish`, `…_manage_comments`, `…_manage_messages`, `…_manage_insights`. No Facebook Page scopes, no password, no browser automation or scraping.

## Data protection
- Memory policy refuses health, religion, politics, sexuality, finances, precise location, minors, credentials, contact data and third-party data; the rest is redacted of phone/email before storage.
- Per-person erasure: `/admin/people/<id>` → Forget.
- The agent never asks for personal or payment data (persona boundary + outbound red rules).

## Operational safety
- RED never automated; YELLOW reviewed by default; fresh deploys start in `human_approval`.
- `is_ai_generated=true` on all published media; the persona discloses being an AI.
- Budgets checked before every paid call; `paused` kill switch.

## Reporting
Security issues: contact the repository owner privately.
