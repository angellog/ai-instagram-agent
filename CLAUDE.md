# ai-instagram-agent (Influencer OS): rules for coding agents

## Zuri is the blueprint
Zuri (influencer #1, `config/persona.yaml`) is the reference for every influencer.
Anything she gets is standard for all of them, existing and future:

1. **Features live in shared code**, driven by each influencer's own persona,
   brand and knowledge. Never hard-code Zuri, FeetBit, sneakers, Kampala places
   or "she" in shared code. Use `persona()`, `pronouns(p)`, `p.brand`, `knowledge()`.
2. **New persona fields** go into all three places in the same change:
   - `src/persona/schema.ts` (optional, with a sensible default),
   - `config/persona.template.yaml` (so hatched influencers are born with it;
     `tests/unit/blueprint.test.ts` fails if Zuri has a field the template lacks),
   - a check in `src/influencers/standard.ts` with an `ai` (or `manual`) fix, so
     existing influencers are measured on it and brought up to it.
3. **After deploying**, bring every live influencer up to standard (Standard page →
   "Bring all up to standard", one at a time) and copy any hand-written Zuri data
   from the file into her live persona.
4. The template holds structure only (placeholders), never another influencer's content.

## Isolation and tenants
Every query on influencer-owned data filters by `influencer_id`; jobs carry their
`influencerId` (a job without one fails); media lives under `mediaPrefix(id)`.
Tenant users (one influencer's business) are confined by `src/auth/access.ts`
(checked in the server's auth hook before any route) and `resolveInfluencer`
(always their own influencer). Any new page that is platform-wide, spends across
influencers or onboards must be added to `ADMIN_ONLY`; any page showing data must
show a tenant only their own (`isTenant(req)`). No billing or subscriptions.

## Working rules
- Deploy only when the operator says "deploy" (push to `main` auto-deploys on Railway).
- `npx tsc --noEmit -p .` and `npx vitest run` (real Postgres `aia_test`, Redis db) before committing.
- Bump `package.json` and `src/version.ts` together and add a `CHANGELOG.md` entry per release.
