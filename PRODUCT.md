# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: the operator (Angelo), running AI influencers for FeetBit today.** He sets influencers up, approves or edits what they post, watches replies, costs and failures, and switches operating modes.
- **Next: the same operator running influencers for client brands through Salesgen** (for example See-Me Cosmetics and AG Gadgets). The operator onboards each influencer; a client business can be invited as a tenant user that signs in and sees only its own influencer's dashboard (no other influencers, no platform settings, no spend controls). There are no subscriptions or billing.

## Product Purpose

Influencer OS runs several AI Instagram influencers from one console. Each one has its own persona, account, memory, budget and schedule. Each plans content from a virtual daily life, generates images, builds carousels and Stories, publishes through the official Instagram API (TikTok photo posts are being added), answers comments and DMs using memory and business facts, and learns from engagement.

Success means the influencers post and reply every day with little operator time, never say anything false about the business, and stay within budget.

## Positioning

A single operator can run a roster of distinct AI creators for real local businesses (starting with FeetBit in Kampala). Every influencer gets the same "Standard" of depth (wardrobe, routine, locations, knowledge), replies are fact-checked against each business's verified knowledge, and a human can review anything before it goes out.

## Operating Context

- **Phone, on the go:** approving posts and Stories, checking reviews and replies, often from the shop floor.
- **Laptop, longer sessions:** hatching influencers, Config & keys, the Standard page, planning, costs.
- **Quick daily check-ins:** what's waiting, what went out, what broke.
- **Services it depends on:** Railway (web + worker), Postgres, Redis, Anthropic, kie.ai (default images), Supabase/imgbb media hosting, Meta Graph API through the OpenReply relay, TikTok Open API, X (read-only), Telegram alerts.
- **Operating modes per influencer:** development, dry_run, human_approval, autonomous, plus pause.

## Capabilities and Constraints

- Server-rendered HTML (Fastify + TypeScript) with small progressive-enhancement scripts; no front-end build step. The design system lives in `src/web/ui/{styles,shell,kit,icons}.ts` and is described in `docs/design/HANDOFF.md`.
- Admin sign-in (an admin user, or `ADMIN_TOKEN`) sees everything and picks the influencer in the sidebar switcher. Tenant users (invited on Team & access, email + password) are pinned to one influencer and can't reach platform pages.
- Posts and Stories can be edited before approval: caption, slide order, cover, slide removal, story text, delete.
- Posts carry each platform's AI-content flag (`is_ai_generated` on Instagram, `is_aigc` on TikTok).
- Instagram and TikTok tokens can die. The console marks the account disconnected, holds its posts, and returns them to Reviews after a reconnect.
- Deploys happen on push to `main`; the operator decides when to deploy.
- **Undecided:** TikTok Phase 2 (native planning, auto cross-posting), the "Studio" that composites real creators' photos (consent-based collab only), client-facing reporting for Salesgen brands.

## Brand Commitments

- Product name: **Influencer OS**. Brand accent `#FF5A1F` (FeetBit orange); Fira Sans / Fira Code; light and dark themes designed together.
- Personas' photos never carry text, handles or branding on the person.
- Business facts in replies (e.g. FeetBit: Pioneer Mall, Level 5, Shop PH-100, Kampala; WhatsApp +256 789 652 909) come only from `config/knowledge.yaml` or each influencer's knowledge entries.

## Evidence on Hand

- Five influencers exist; the four live Instagram accounts are @zurikarale, @pareshmardi01, @kemicynthiana and @salimasymons.
- Real engagement data comes from Instagram insights in the database. There are no testimonials, client case studies or published metrics; do not invent any.
- Kemigisha (See-Me Cosmetics) and Salima (AG Gadgets) still need verified business facts from the operator.

## Product Principles

1. **The human stays in control.** Anything risky has a clear review step. Mode and pause are always one tap away, and nothing is published silently after a failure or disconnect.
2. **Cost is always visible.** Spend and budget sit next to every action that costs money (LLM, images, APIs), per influencer and in total.
3. **Only real business facts.** Replies and posts state addresses, prices and contacts only from verified knowledge; anything unverified is held for review.
4. **Built for a phone and a quick glance.** The day-to-day jobs (approve, edit, check what broke) must work one-handed on a phone in minutes. Longer set-up work can assume a laptop.

## Accessibility & Inclusion

Keep WCAG AA contrast (4.5:1 body text) in both themes, visible focus, colour always paired with text or an icon, and working fallbacks for `prefers-reduced-motion` and `prefers-reduced-transparency`.
