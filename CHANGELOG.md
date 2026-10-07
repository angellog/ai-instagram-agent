# Changelog

All notable changes. Versions are git tags; the running version is shown in the
console footer, `/health` and `/api/status`.

## v1.0.29: Liquid glass everywhere, real-life timelines, short-form and engagement (in progress, not deployed)

**1. Liquid glass across the whole console** (the Config & keys look, everywhere)
- Every section panel is glass now: cards, KPI tiles and tab bars (tabs are a glass pill bar with a solid chip for the current one). Table headers sit on stronger glass; inputs, previews, code and stat cells stay solid insets so dense data reads cleanly. DESIGN.md's rule is now "The Glass Panel Rule".
- No sideways page scroll at phone or desktop width on any page. Wide tables scroll inside their panel and fade at whichever edge has more to see.
- Long words, links and ids wrap inside panels; numbers in tables no longer break mid-figure.
- Reels: the post page shows the playable reel with its cover, sized so both fit on a phone. Thumbnails on Overview, Posts and Stories use the cover image, never a broken video frame. Library reels get a cover frame taken from the first second.
- Controls use plain labels ("AI brain", not `llm_brain`), and fields line up across a row.
- Themed text selection, caret and scrollbars in both themes. Section kickers are plain sentence case. The Create progress bar animates smoothly (no layout thrash) and the step tick no longer overshoots; quotes are a tinted inset instead of a side stripe.
- Every glass surface keeps its solid fallback (no backdrop-filter support, reduced transparency, more contrast).

**Fix: fact check reads units.** A number now has to match its unit: "2 hours" in the delivery facts no longer lets "only 2 pairs left" through. A follower's own numbers and bare numbers work as before.

## v1.0.28: Tenant set-up and the Interview

**Each influencer stands alone** (tenant set-up, no billing)
- Accounts: email and password sign-in (scrypt-hashed), one-time invite links (7 days), 14-day sessions stored only as hashes. The admin token still signs you in as admin.
- **Team & access** (admin): invite a tenant user for one influencer's business, or another admin; new link or password reset; disable (signs them out everywhere).
- A tenant sees only their own influencer: no switcher, no other influencer's name, no platform pages. Enforced in the server before any route runs (`src/auth/access.ts`): Influencers, Hatch, Standard, Config & keys, Team & access, switching, routing policy, benchmarks, providers, soul training, Instagram connection, the raw persona editor, platform budgets and the status API are refused even when typed. Their requests always run as their own influencer, whatever cookie or id they send.
- Costs and Events show a tenant only their own. Budgets, the language-model brain and reel volume are read-only for tenants. The platform queue card is admin-only.

**Interview** (new page under Identity)
- Asks a few specific questions at a time: missing business facts first (address, how to order), then whatever the Standard finds short, then life, voice, audience and places. Not repeated within two weeks.
- Answers become a structured change set (interests, phrases, boundaries, place looks, business facts with exact `must_include`, remembered experiences). It's shown for review and saved only on confirm, as a versioned persona update.
- **Add an experience**: a sentence or two goes straight into the influencer's remembered story, used in chats.
- Migration `014_tenants.sql`.

## v1.0.27: Social conversations (a friend, not a sales rep)

- **How every influencer talks:** like a person on Instagram. Replies mirror the other person's length (a "hey" gets a few words), one short message, an occasional question back, small real-sounding details from their own life, and friendly follow-ups on what people told them before. No paragraphs, lists, help-desk phrases ("how can I help", "let me know if") or sales talk.
- **Not a salesperson:** the brand, shop, prices and stock come up only when someone asks how to buy, what something costs or where it's from, and then the answer comes exactly from the business knowledge.
- **Social check on every draft** (code, not just the prompt): too long for the message it answers, line breaks or lists, help-desk or ad phrases, more than one question, or the brand named in small talk. The draft gets one rewrite in the influencer's voice before the fact check and safety check.
- **Their own canon:** details an influencer invents about their life in a chat (a film they're watching, a game, weekend plans) are saved as their own memory, shared across every conversation so they never contradict themselves, and each person's memory notes what they were told. Replies also see what the influencer is actually doing today (the day plan).
- **Honest when sincerely asked:** they never bring up being an AI or talk like a bot, but if someone sincerely asks whether they're real or a bot, they answer honestly in one light line and keep chatting.
- Zuri's interests now include movies and series, gaming, and Kampala events.

**Zuri is the blueprint** (rule in `CLAUDE.md` and `docs/ARCHITECTURE.md`): any feature or persona field she gets is standard for every influencer, existing and future.
- The hatch template now carries everything Zuri has: place `look`s, a rounded social life (films/series, music, a hobby, a team, local events), activity `weight` and `postable`, and news feeds.
- New Standard check **A life to chat about** (8+ interests covering films/music, a hobby and local events), with an AI fix. **Places look local** applies to everyone. Hatching requires both.
- `tests/unit/blueprint.test.ts` fails if Zuri has any field the template lacks, or if she fails any Standard check, so a Zuri-only field can't ship again.

## v1.0.26: Local realism, story styles, content library, reels

**Looks like Kampala, not anywhere**
- Every image prompt states the real setting (present-day Kampala), what that kind of place really looks like (tiled floors and burglar-bar windows at home; glass-fronted units with packed glass counters in Pioneer Mall; boda bodas and MTN-yellow shopfronts on the street), that anyone else in frame is a Ugandan local, and what to avoid (Western suburban rooms, carpets, snow).
- Hands-only and POV shots now carry the creator's own skin tone and accessories. They used to have none, so the model drew white hands.
- A shop or workplace must read as a business, stocked with the influencer's own brand (phones for AG Gadgets, shea butter for See-Me).
- Locations can carry a hand-tuned `look`; new Standard check "Places look local" (AI fix writes them from local knowledge). Zuri's nine places have one.

**Story text styles**
- Six styles picked at random per story, never repeating the last two: panel, plain, caption pill, script calligraphy (Pacifico), marker label (Permanent Marker) and highlight blocks, plus vector stickers (sparkle, heart, star, sun, arrow, burst). Editing a story's words keeps its style.

**Content library** (new page: Library)
- Businesses upload photos (one, or up to 10 for a carousel) or one video, with a title and notes. "Let them decide": the content director posts it when it fits the day. "At a set time": the caption is written now and waits in Reviews, then publishes at that time. "Reel material": screen recordings and b-roll cut into AI reels, never posted alone.
- Captions are written in the influencer's voice from the notes only (no invented prices or dates); numbers not in the notes are flagged. Business videos are not marked AI-generated.

**Reels**
- Instagram Reels publishing (video container, longer processing wait, cover image).
- AI reels, 2 a week by default (Controls → Reels): moments (1-3 short AI clips of the creator's life) or, for tips creators, explainers. The creator introduces the tip in an AI clip, then the steps play on a recreated phone screen (finger, tap ripple, highlighted row, switches flipping, screens sliding). Steps get a second, sceptical research pass, and explainers always wait for review.
- Each clip is a validated photo of the creator in their real setting, animated by image→video (Seedance on kie, about $0.06/s). The hook line uses a story text style. Uploaded reel material can be cut in. Length 5-55 s.
- Create page: "Create a reel".
- Video is allowed in routing policies (it predated reels); bundled ffmpeg (`ffmpeg-static`); the media bucket accepts MP4.
- Migration `013_library_and_reels.sql`.

## v1.0.25: Every influencer is its own creator (independent brains, UGC brand pull, isolation)

All influencers ran on Zuri's architecture with her world baked in: a required `sneakers` field on every idea, "sneakers clearly visible" in the image framing, FeetBit in the reply prompts, "she" everywhere, and Zuri's whole persona as the hatch template.

**Independent brains**
- Persona gains `identity.pronouns` (asked at hatch, never inferred from the name) and a `brand` block: name, category, products that can appear naturally, natural moments from this person's own day, curiosity hooks, and a mention rate.
- **Brand pull, not ads:** the post and story directors make everyday UGC ("a breakfast post is about breakfast"); one item from the brand's category may sit naturally in the frame (`featured_item`, replacing `sneakers`) so followers ask about it. Naming the brand is limited to the influencer's mention rate, counted from their own recent captions; a caption that names it off-turn goes back for a rewrite.
- Image framings are neutral (no "head to sneakers"); the featured item is placed naturally, never posed with.
- Story kinds: moment, look, brand, trend, question. A brand story carries the store line only on a turn the brand may be named.
- Reply brain, safety reviewer, impersonation rule and memory examples are built from the influencer's own occupation, interests and brand; `sneaker_talk` is now `niche_talk`; "the FeetBit team" is the influencer's own brand.
- Hatching uses a neutral structural template (`config/persona.template.yaml`), never another influencer's persona. Zuri's own file gains her FeetBit brand profile.
- Standard: new checks **Pronouns** (manual) and **Brand pull** (AI fix drafts it from the affiliation and the influencer's own business knowledge).

**Isolation**
- A job without an influencer id fails instead of running as influencer #1.
- Memory expiry, review approve/reject and post edits are scoped to their own influencer; approving another influencer's review from the wrong page is refused.
- Influencer pages show only their own events and job runs (Events has "<name> only", "Platform" and "Everything"); per-influencer failures are logged in that influencer's context; boot events no longer name Zuri.
- Dashboard copy and Create direction examples come from the current influencer's own life; no Zuri-only Instagram fallback.
- New media is stored under `influencers/i<id>/…` (slugs can change or be reused); existing files keep their paths.
- Telegram alerts say which influencer they're about.

## v1.0.24: One-click Telegram alerts setup

- **Find my chat ID** on Config & keys → Alerts: after you message your new bot, it reads the bot's latest private chat, saves `TELEGRAM_CHAT_ID` and sends a confirmation. No getUpdates URL by hand.
- **Test telegram** now really checks: it reports a missing token or chat ID, a refused token, or a bot another app already reads (409), instead of always saying "sent".
- Clearer help text for creating the bot with @BotFather.

## v1.0.23: Say so loudly when the LLM account is out of credit

On 2026-09-30 the Anthropic account ran out of credit. For about three hours every plan, story, Create-now run and reply failed with a raw 400 buried in Events & jobs.

- **Out-of-credit is its own error** (`LLMBillingError`) for Anthropic ("credit balance is too low") and OpenAI (429 `insufficient_quota`, which used to be retried as a rate limit).
- **Red banner on every console page** while a brain is out of credit, with the billing link, plus one error event and one Telegram alert (not one per failed call).
- **Self-healing:** the first successful call clears the banner and re-queues comments and DMs that failed for this reason in the last 24 hours.
- Create a post now shows "LLM out of credit: … top up at console.anthropic.com → Plans & Billing" instead of the raw API response.

## v1.0.22: OpenAI as a second brain, chosen per influencer

- **Language model brain** in each influencer's Controls: Claude (Anthropic) or OpenAI (GPT). Everyone else keeps their own setting, so the two can run side by side. Platform-level calls stay on the default.
- **Config & keys → Language model:** OpenAI API key, reasoning model (default `gpt-6.1-sol`, $2/$10 per million tokens) and fast model (default `gpt-6-luna`, $0.10/$0.50). **Test openai** checks both models and that the reasoning model can read images (photo checks need it).
- **OpenAI-ready provider:** uses `max_completion_tokens` with room for hidden reasoning on api.openai.com, retries once without `temperature` when a model only allows the default, and turns an empty reasoning-starved reply or a refused key into a clear error.
- **Costs:** OpenAI prices in the ledger, including dated snapshots (`gpt-6.1-sol-2026-08-12`). New **Claude vs OpenAI (14 days)** table: brain, models used, calls, LLM spend, cost per post plan, repair rate (wrong-shape replies that had to be re-asked) and replies decided.
- **Safe fallback:** an influencer set to OpenAI with no OpenAI key stays on Claude and logs a warning (once an hour), instead of failing its posts and replies.

## v1.0.21: Direct "Create a post now"

- **Direction box** on Create a post now: a few words (a product, place, occasion or mood, up to 300 characters) that the content director must build the post or story around. Example chips fill it in one tap. Leave it empty to let the influencer pick, as before.
- The direction outranks the day plan, trends and the director's own preference, and it can't "wait". It never outranks the persona, the safety rules or verified business facts. An outfit you name is kept even if the wardrobe rotation would have swapped it. Repetition retries keep the subject and change the angle.
- **Direct it** link next to the one-tap buttons on Overview, Posts and Stories. The progress page shows "Your direction", Try again keeps it, and Change direction reopens the box. Recent runs list each run's direction.
- Migration `012_create_direction.sql` adds `create_runs.direction`.

## v1.0.20: Liquid-glass console, redesigned Config & keys

- **Glass material** for the chrome that floats over content: top bar, sidebar, mode and influencer menus, dialogs and toasts, over a soft brand-tinted light field. Regular content cards stay solid. Solid fallbacks when the browser lacks `backdrop-filter`, and under `prefers-reduced-transparency` or `prefers-contrast: more`.
- **Config & keys:** readiness ring with a checklist (missing items first, each links to its section), a sticky section bar with per-section status dots and scroll highlighting, and one glass panel per settings group with a "set" count, inset fields, and Test/Save in a footer.
- `PRODUCT.md` records the product context for design work; `docs/design/HANDOFF.md` documents the glass tokens.

## v1.0.19: X (Twitter), Phase 1 (read-only: mentions and metrics)

X is a third channel, for FeetBit's own brand account. Phase 1 only reads; replies come in phase 2. Plan: `docs/X_AGENT_PLAN.md`.

- **Read-only by construction.** The agent authenticates with the app-only bearer token (Config & keys → X), which X accepts for reads and refuses for any write. There is no posting code in `src/x/`.
- **Connect by username** on the new **X (Twitter)** page. No login needed while read-only.
- **Mentions every 15 minutes** (`x.poll`) into their own inbox (`x_mentions`), with a `since_id` cursor so each mention is read once. The first poll backfills one page; later polls page through up to 100 new mentions. Mentions stay out of the conversation pipeline for now, because its send path is Instagram-only.
- **Daily metrics** (`x.metrics`, 07:40 Kampala): followers, and views/likes/replies/reposts/saves for every post from the last 7 days, one row per post per day.
- **Costs and caps.** X bills per item read. Every read is recorded in the cost ledger (`provider = 'x'`) with its item counts. New controls: `x_enabled`, `x_daily_read_cap` (500 items) and `daily_x_api_budget_usd` ($0.50). When a cap is reached the poll skips and says why on the X page instead of failing every 15 minutes.
- **Errors.** 429 waits until X's `x-rate-limit-reset`; depleted credits (402) fail once with a "top up at console.x.com" message; a revoked token fails as an auth error. 19-digit ids are stored as text.

## v1.0.18: TikTok, Phase 1 (connect, adapt, publish photo posts)

TikTok is a second platform next to Instagram. Setup guide for the operator: `docs/TIKTOK_SETUP.md` (developer app, Login Kit + Direct Post, salesgen.com media domain, legal pages, Business accounts, audit).

- **Log in with TikTok** per influencer (Persona & soul → TikTok):
  - The login state is signed and expires after 15 minutes.
  - Tokens are stored encrypted. The 24h access token renews automatically (hourly `tiktok.refresh`, and just before posting); the refresh token lasts a year.
  - The card shows the account, followers, the privacy options TikTok offers it, audit status, Check connection, Switch account, and Disconnect (deletes the tokens).
- **Also post to TikTok** on any Instagram post or story:
  - Photos are re-framed to 1080×1920 without cropping (fitted over a soft blurred fill; story frames pass straight through).
  - The caption is rewritten the TikTok way: a hook line, 3–5 hashtags, and a title of up to 90 characters. It's safety-checked.
  - The TikTok version waits in Reviews with its own **TikTok settings**: who can view, comments, "promotes her own business", and the AI label (always on).
  - Only one TikTok version per post; the two pages link to each other.
- **Publishing** (photo posts via the Content Posting API, Direct Post):
  - TikTok downloads the photos from `<TIKTOK_MEDIA_BASE_URL>/tiktok-media/<post>/<n>-<hash>.jpg`, served straight by the web service with no redirects. Only TikTok frames are served there.
  - The creator's current options are queried before every post, as TikTok requires.
  - **Until the app is audited, every post is Only me (private).** After the audit, the chosen privacy is used if the account allows it.
  - `is_aigc` is always true, with automatic music.
  - Duplicate-proof: the publish ID is saved before waiting, so a retry checks status instead of posting again. A failed publish can be retried cleanly.
  - TikTok's 19-digit post IDs are read without rounding (JavaScript can't hold them as numbers).
- **Disconnection handling** matches Instagram's:
  - A login TikTok ends is marked **disconnected** once, with one alert.
  - Posts are held, a banner shows on every page, and logging in again brings held posts back to Reviews.
- **Platform plumbing:**
  - `posts.platform` (instagram | tiktok) and `source_post_id`.
  - TikTok posts never block Instagram planning.
  - Posts gets a **TikTok** tab; review cards say "TikTok post".
- **Public legal pages** at `/legal/terms` and `/legal/privacy`, with the company name and contact from Config.
- **Controls:** TikTok on/off, default privacy, allow comments.
- Tests: 313.

## v1.0.17: Handle Meta ending an account's session (code 190)

**Incident, 2026-09-28/29:** Meta ended the sessions of all four accounts at the same moment (code 190: "the user changed their password or Facebook has changed the session for security reasons"). With every influencer in autonomous mode:
- posts were still planned and photographed (spending credits), then failed to publish
- the hourly profile check failed silently for about 9 hours
- nothing alerted the operator

**Now**
- The first code 190 from any Instagram call marks the account **disconnected**, via a hook in the client, so every call path is covered. The account records the error and when it happened.
  - A single alert goes out: an event plus Telegram if configured, never repeated.
- **While disconnected:**
  - No calls go to Meta with the dead token.
  - The feed and story planners stop (their gate says why), so no credits are spent on posts that can't go out.
  - Profile sync, snapshots and token refresh skip quietly.
  - Publishing holds posts instead of failing them repeatedly.
- **It's shown everywhere:**
  - a red banner on every console page for that influencer, with a Reconnect link
  - the Instagram card: status, when, and Meta's message
  - a "disconnected" label on the influencer card
  - the Standard's "Instagram connected" check fails
- **Reconnecting** (attach a new token, or Log in with Instagram) clears the flag.
  - Posts held back in the last 7 days go back to **Reviews** (tagged "held while disconnected") so you can check they still fit, then Post now or Schedule. Nothing is published automatically.
  - This includes posts that failed on a raw code 190 before this release.
- Tests: 302.

## v1.0.16: Mode switcher in the top bar; Fix/Edit on every standard check

- **The operating-mode switcher moved to the top bar.** It sits far right, next to the Day/Night toggle, in place of the plain mode label: a pill with a coloured dot and the mode's name.
  - It opens the four modes with what each means, plus a link to all controls.
  - On phones it shrinks to the dot.
  - The sidebar gear is gone.
- **Every check on the Standard page has a button.** Fix when it falls short, Edit when it passes. Each opens exactly where that information lives, for that influencer:

  | Check | Opens |
  |---|---|
  | Persona sections | persona editor |
  | Business facts | the knowledge field (new `#knowledge` anchor) |
  | Soul face | Soul |
  | Profile kit | Profile kit |
  | Instagram | the Instagram card |
  | News brief | Trends & news |

  - Hatching influencers open the matching wizard step.
  - How a failing check gets fixed (automatically / AI fills it in / needs you) now shows inline, next to its numbers.
- Fixed a leftover style from the sidebar version that pushed the mode dots out of place.

## v1.0.15: A standard the minimum closet can meet

- **The looks target is now 250**, which is what the minimum closet produces without dresses: 10 tops × 7 bottoms, plus layers. Paresh's rebuilt closet (293 looks) was held to 300, which the standard's own minimums couldn't reach. A test now keeps the two consistent.
- **The news brief refresh reloads the influencer first**, so news sources added moments earlier by the same upgrade are used. Paresh's brief was "never collected" because the refresh ran on his pre-upgrade persona.

## v1.0.14: Standard upgrades survive shape slips

- **Paresh Mardi's first upgrade failed.** He was hatched before closets existed and had 4 looks. The model sent his outfits and weekend ideas as objects instead of plain lists, so validation rejected the upgrade twice and nothing was saved.
  - The upgrade prompt now includes each requested section's exact structure, taken from the reference persona (lists cut to two items, "copy the shape, never the content").
  - Near-miss shapes are converted before validation: objects become plain strings for outfits, weekend ideas and closet lists.
- **Run reports use each check's own name**, so a fixed profile picture shows as fixed instead of "nothing to fix automatically".
- The test-only thin persona moved to `tests/helpers/personas.ts`, so no test file runs twice.

## v1.0.13: The Influencer Standard, and a one-tap operating-mode button

**Influencer Standard** (Platform → Standard)
- One master checklist every influencer is held to, however and whenever it was hatched.
  - **Wardrobe:** 300+ looks from a closet of separates (10+ tops, 7+ bottoms, 3+ layers, 3+ activewear sets; dresses optional), 6+ signature outfits, 2+ occasion outfits.
  - **Daily life:** 8+ activities over 4+ times of day, 4+ weekend activities, 5+ weekend post ideas, 4+ places.
  - **News:** 5+ labelled news searches with a region, and a news brief under 36h old.
  - **Assets:** openly AI, a soul face, a profile kit (bio + picture), Instagram connected, replies that know she's AI, and true business facts for any brand she's affiliated with.
- Every check shows the numbers against the standard and how it gets fixed:
  - **automatically:** the AI-disclosure knowledge entry, the profile kit, a fresh news brief
  - **by AI:** the persona sections that fall short
  - **by you:** the face, the Instagram login, business facts, which are never invented
- **Bring up to standard** (one influencer, or everyone below standard) runs as a background job (`influencer.standardize`):
  - The model receives the current persona plus exactly what falls short, and returns only those sections.
  - They're merged in and validated before saving; everything else is left untouched.
  - The run is then re-checked and what still needs a person is listed.
- Fix buttons open the right page for that influencer, whatever the sidebar has selected. `/admin/switch` takes an optional `to`, limited to console pages.
- **New influencers:** right after the persona is written, any section below the standard is filled in the same hatch job, before you see it.

**Operating-mode button**
- A gear in the far-right corner of the sidebar's influencer card. A coloured dot shows the current mode.
- One tap opens the four modes (development, dry run, human approval, autonomous), each with what it means. Picking one changes it for that influencer and returns you to the same page.
- The menu closes on an outside click or Escape.

Tests: 300.

## v1.0.12: Story updates, and editing before approval

**Instagram Story updates**
- **One Story at a time.** Each is one 1080x1920 image published through the official API (`media_type=STORIES`). They're separate from feed posts and their limits.
- **Kinds:**
  - moment: a slice of her day
  - outfit: a fit check
  - shop: a product or shop shot; the store address line comes verbatim from the business knowledge, never from the model
  - trend: a reaction to a headline
  - question: followers answer by replying, which arrives as a DM she handles
- **Planned from her actual day.** Stories use today's activities and today's outfit (the same one her feed post wears), plus recent stories so she doesn't repeat.
- **House rules in code:**
  - no text on photos of her
  - at most 70 characters of plain words on other shots
  - numbers on the image must come from the business knowledge or the headlines
- **Cadence (Controls → Stories):**
  - `stories_enabled`, `stories_per_day` (3) and `min_hours_between_stories` (2.5)
  - same posting window
  - the planner checks at 09:50, 13:50, 17:50 and 20:50 local (`STORY_PLAN_CRON`) and may decide to wait
- **Same pipeline as feed posts:** production, vision QC, safety, Reviews, "Post now" and Schedule, and the duplicate-proof publisher.
  - A lost publish response is recovered from the account's live stories.
  - If Instagram refuses the per-media AI label on stories, the story goes out without it and the fallback is logged.
  - Story insights aren't collected (they expire after 24h).
- **Console:**
  - a new **Stories** page (live count against the daily cap, 9:16 grid)
  - **Create a story now** on Overview, Create and Stories, with the same animated progress page
  - Feed lists (Posts, Overview) stay feed-only
- **API limits:** the API can't add link stickers, polls, mentions or music, so the words are part of the image.

**Edit before approval** (while a post is awaiting review, in dry run, or failed QC)
- **Caption:** edit it on the post page, with a live character and hashtag counter. Saving checks Instagram's limits (2,200 characters, 30 hashtags) and the safety rules (red is refused).
- **Slides:**
  - move them left or right, or make any slide the cover (star)
  - remove one (bin); one left turns the post into a single photo
  - the pending review always shows the current slides and caption, with an "Edit" link
- **Story text:** change or remove the words on a story. The image is re-rendered from the original photo. Photos of her stay text-free, and unverified numbers are refused.
- **Delete** a draft post or story for good: it cancels any schedule, closes the review and marks the idea rejected. Anything already on Instagram is never touched.
- **Approved posts:** editing is locked; the page says to unschedule first.
- Every edit is recorded in the decision trail.
- Tests: 288.

## v1.0.11: True, complete answers to business questions

When a follower asks something the business knowledge answers ("what is the shop location?"), the reply now states the fact completely and exactly, in one natural sentence in the influencer's voice. For example: "We're at Pioneer Mall, Level 5, Shop PH-100 in Kampala 📍 come through and say hi!"

- **Wrong floor fixed.** The knowledge base said **Level 4**; the shop is on **Level 5, Shop PH-100** (confirmed 2026-09-26).
- **Reply rules no longer block business contacts.** They used to say "never repeat phone numbers or addresses", which also blocked FeetBit's own address and WhatsApp number. It now covers only the follower's personal data.
  - Replies must give the full address or contact exactly as written, publicly, and must not add details the knowledge doesn't state (no invented hours or directions).
- **Fact check before sending** (`src/conversation/facts.ts`):
  - Knowledge entries can list `must_include` phrases. A reply that cites the entry must contain every one: the full address; the WhatsApp number in any format.
  - Every number in a reply must come from the knowledge shown or from the follower's own message, so a made-up floor or phone number is caught.
  - A failing draft gets one rewrite. If it still fails, it goes to Reviews with the tag `fact_check` and is never sent automatically. Each decision records what the fact check did.
- **Safety filter.** The business WhatsApp is recognised in local format (`0789 652 909`) as well as international (`+256 789 652 909`). Other numbers are still blocked.
- More ways of asking where the shop is now find the store entry: located, find you, which floor, directions, pass by.
- Tests: 272.

## v1.0.10: Hatch persona drafts pass validation

**Fixed:** with v1.0.9 the persona job ran to completion (about 2.5 minutes, no timeout), but Kemigisha's draft was rejected twice: `daily_life.activities.5.slot: Invalid option`.
- **Cause:** the compose instructions asked for `early_morning/morning/midday/afternoon/evening/night` time slots, but the schema only accepts `morning, late_morning, lunch, afternoon, evening, night`. The model did as told, and the repair round repeated the same mistake.
- **Now:**
  - The instructions list the exact slots and lowercase weekday names, generated from the schema so the two can't drift apart again.
  - The persona parser forgives common near-misses and stores the canonical form:
    - `early_morning` → morning
    - `midday`/`noon` → lunch
    - `late_night` → night
    - `Sun`/`Sundays` → sunday
  - This also covers hand edits on the Persona step. Unknown values are still rejected with a readable path.
- Tests: 261.

## v1.0.9: Hatching no longer times out

**Fixed:** hatching failed with `llm persona.compose timed out after 90000ms` (seen hatching Kemigisha Cynthiana).
- **Cause:**
  - A full persona (life, closet, occasions, weekends and news sources) is about 4–5k tokens for the model to write, which now takes Sonnet 5 longer than the 90-second per-call limit.
  - It also ran inside the browser request, so the page hung for the whole time.
  - The 6,000-token output cap was close to truncating the larger v1.0.8 personas.
- **Now:**
  - "Compose persona" saves the brief and queues a `hatch.persona` background job (maintenance queue) at once.
  - The wizard shows "Writing <name>'s persona…" with a timer and refreshes itself.
  - When the job finishes, the page lands on the Persona step.
- **Limits:**
  - The compose call has its own 5-minute limit and a 12k-token budget.
  - Any LLM call can now set its own `timeoutMs`, which is honoured by the Anthropic and OpenAI-compatible providers.
- **Failures and retries:**
  - A failed or lost job (for example after a worker restart; treated as lost after 12 minutes) shows the reason, keeps the brief filled in, and offers a retry.
  - Double taps and older requests are ignored.
- An incomplete brief is refused before an influencer is created, and the refusal shows as an error toast.
- Tests: 258 (was 253), including a regression test for this exact case.

## v1.0.8: Closet remixing, occasion wear, weekends, trends and news

**Closet of separates** (`visual.character.closet`)
- Tops, bottoms, layers, one-pieces and activewear. Any top with any bottom (sometimes plus a layer) is a new outfit made from pieces the influencer owns: the real-life remix trick.
- Zuri goes from 16 fixed outfits to 522 possible looks.
- Rotation rules:
  - The exact look can't repeat for up to 21 days, and a single piece rests 2 days before reappearing in a new combination.
  - Picks are weighted by kind (mostly plain top + bottom, sometimes layered, a dress, or a saved outfit).
  - When a piece comes back with something new, the director is told it's a remix, as a styling angle.
- **Occasion wear** per influencer (church, Jumu'ah, Eid, kwanjula, wedding guest…). It triggers on its weekday or when the activity, topic or a calendar event mentions it.
- Zuri has Sunday church, kwanjula gomesi, wedding guest and an Eid visit. New influencers get occasions matching the faith and culture given in the Hatch brief's new "Faith and occasions" field.

**Weekends**
- Activities can be `weekends_only` or limited to specific `days` (Sunday church, Saturday market run, weekend brunch, football watch party).
- `weekend_ideas` plus an "it's the weekend" brief go to the director on Saturdays and Sundays.

**Trends and news**
- Per-influencer `trends`: Google News searches for their region, plus RSS/Atom feeds (Zuri: sneaker releases, Kampala events, Uganda fashion and music, Sneaker News, Hypebeast Footwear).
- Collected every 6 hours. Hard filter on politics, crime and tragedy, then the model keeps at most 6 items this creator would genuinely know, with a one-line note each.
- The brief goes to the director and to replies (never adding facts beyond the headline).
- New Trends & news page: brief, sources, raw headlines, Refresh now, and Add to calendar.

**Trend sources narrowed** (per request): TikTok Uganda, Instagram Kampala, X Uganda, Premier League, Champions League and a few international sources (Hypebeast Footwear, Sneaker News, BBC Entertainment & Arts). 15 sources, each labelled.
- The brief is balanced across labels: round-robin candidates, at most 2 per label, up to 8 items.
- Queries can set their own time window ("… when:7d").
- X has no free trends API for Uganda, so "X Uganda" follows Ugandan news coverage of what's trending on X.
- The hard filter now also blocks legal, crime, funeral and military stories.

**Also**
- A Wardrobe card on Persona & soul shows closet size and today's planned look, workout outfit, remix and occasion wear.
- The composer writes closets, occasions, weekend activities, weekend ideas and news sources for new influencers.

## v1.0.7: Simple, readable captions

- Captions were paragraphs narrating the photo (the rooftop, the coffee, the sky, the "rotation"), with the same tics ("Rotation check", "Some days…", "like it owes me") and a question almost every time.
- **New rules for the director:** the photo already shows the scene, so the caption never describes it. One simple thought, feeling or small joke in 1–2 short lines, under 150 characters (educational carousels: a hook plus up to 3 short tips, under 320). A question only about one post in three. It sees recent captions so it doesn't reuse their openings or phrases. Good and bad examples are included.
- **Deterministic checker:** a caption that's too long, has too many sentences, uses an overused phrase, opens the same way as a recent caption, or would be the third question in a row is sent back with specific feedback. The rejected caption is kept on the idea for audit. On the last attempt it is trimmed at a sentence boundary instead.
- **Readable layout:** one sentence per line, then a blank line, then hashtags.
- Persona rule updated: "Captions are 1-2 short lines with one simple thought".

## v1.0.6: Create a post now, live followers, full console audit

**Create a post now** (Overview, Posts, the sidebar, and automatically after a Hatch launch)
- One tap runs the real pipeline for the selected influencer: idea → photos → quality and safety checks.
- It always stops for review, ignoring the posting window and cadence, and never auto-publishes.
- A live progress page shows an animated bar, a 4-step stepper, and photos fading in as each is hosted. Progress is measured from real pipeline rows, not a timer.
- When done: caption plus Post now / Schedule / Open / Make another. On failure: a readable reason and Try again.
- A second tap while a run is active reopens that run.

**Live follower numbers**
- An hourly Instagram profile sync (followers, following, posts), plus a sync right after an account is attached and a Refresh button on influencer cards.
- Cards and the Overview KPI no longer wait for the nightly snapshot.

**Audit fixes** (each has a regression test; a new crawler test visits every page and link and submits every form)
- Hatch actions are billed and logged to the influencer being hatched, not the one selected in the sidebar.
- The "Use platform default" button sat inside another form, so it re-saved the policy instead of resetting it.
- Failures now show as error toasts (`tone=bad`), not success toasts.
- Dates use the influencer's timezone, and all-day events are no longer "past" on their own day.
- Saving Controls only pins changed values, so platform defaults keep flowing. An emptied number field no longer becomes 0.
- Scheduling a time in the past is refused instead of posting immediately.
- Malformed ids return 404 instead of a database error. Unexpected errors on console forms come back as a message, not a raw 500.
- Removed a double escape, dead routes, and an unused switcher field. Button styles are consistent.
- Mobile: fixed horizontal overflow on every page (grid min-width), compact top bar, two-column KPIs.

## v1.0.5: Post now / Schedule

- A **Publish** card on every unpublished post, plus the same buttons on post review cards:
  - **Post now** publishes immediately. From a review card, an edited caption is applied first.
  - **Schedule** takes a date and time in the influencer's timezone (DST-safe). Reschedule and **Unschedule** are included.
- These are explicit operator decisions, so they win over the posting window and dry-run mode (`posts.publish_override = 'operator'`). They never override a RED safety verdict, development mode, or a pause; a paused influencer's post goes out on resume.
- Rescheduling replaces the queued job, so a post is never published twice. Scheduled times show on the Posts grid.

## v1.0.4: Wardrobe rotation + Profile kit

**Wardrobe rotation** (fixes "same all-black fit two days running")
- Root cause: the persona listed only 4 outfits, one of which matched the face reference photo. The director kept choosing it and the image model copied the reference's clothes. Repeats were only a soft 0.12 penalty.
- `visual.character.wardrobe` is the closet: Zuri now has 16 outfits, and hatched personas get 12–16.
- One outfit is planned per local day. It is deterministic, kept all day for continuity, and never repeats one worn within the cooldown window (up to 6 days).
- Workouts get activewear.
- The director may still choose freely, but repeats and wrong-kind outfits are rotated out, and the change is logged in continuity adjustments.
- Image prompts now say the reference is for identity only and its clothing, background and light should be ignored.

**Profile kit** (Instagram's API can't edit name, bio or photo)
- A new Hatch step, Profile, comes right after the soul face is chosen. There is also a Profile kit page for existing influencers.
- The text is written from the persona:
  - a searchable Name (≤30 characters)
  - three bios (≤150 characters, each states it's an AI creator)
  - handle ideas, category, link idea, highlight names (≤15 characters) and a first-story idea
  - copy buttons and live character counts
- Profile picture: a free face-weighted crop of the soul face, or a designed headshot (one generation). It is previewed at circle and avatar sizes and can be downloaded.

## v1.0.3: Hatch an influencer (with the v1.0.1 and v1.0.2 work)

The three releases shipped as one commit because the new console underpins all of them.

**v1.0.3 Hatch wizard** (`/admin/hatch`)
1. The **brief** (name, niche, city, look, vibe…) is turned by the LLM into a complete, validated persona.
2. **Review** the persona, edit it, or re-compose it.
3. **Soul**: generate three face options through the engine or bring your own photos, then name the Soul ID (e.g. `soul_nova_v1`). Optionally train a Higgsfield Soul ID.
4. **Instagram**: attach by token (validated with `/me`; Creator/Business only; webhooks subscribed), log in with Instagram (OAuth now carries the influencer), or skip.
5. **Launch**: pick the starting mode (human approval by default), posts per day and budgets. The per-influencer schedule starts in its own timezone, with an optional first post.

**v1.0.2 Console redesign + calendar**
- A new design system: tokens, light/dark, Fira type, SVG icons, WCAG AA, reduced motion. See `docs/design/HANDOFF.md`.
- An app shell with sections, an influencer switcher and pause/resume.
- An interactive **calendar** (FullCalendar 7). You can add, drag, edit and delete events.
  - Events are world (shared) or private.
  - Each event has an importance and a "use for" setting.
  - "What happened?" outcomes become memories.
  - Upcoming events feed the director and the conversation agent.
- Every page is scoped to the selected influencer.

**v1.0.1 Config + Generation Control Center**
- **Config & keys**: one page for every service key (LLM, 7 generation providers, storage, Meta app, OpenReply, Telegram).
  - Keys are encrypted and override env. Changes apply in about 15 seconds.
  - A setup checklist shows what is missing.
  - Per-provider **Test** buttons.
- **Generation Control Center**, with five views:
  - Providers & models (health, quarantine release, enable/disable).
  - Routing policy (platform + per influencer) with a spend-free **route preview**.
  - Jobs & failures (route + attempts per request).
  - Assets.
  - **Benchmarks**: a vision-judged suite, budget-capped, whose scores feed the router.

Also:
- Shared prompts are gender-neutral, so influencers can be of any gender.
- Planning is allowed in dry-run/development before an Instagram account is attached.
- A bad cron or timezone can no longer crash the worker.
- `scripts/preview-console.sh` runs a fully offline preview.

## v1.0.0 — Multi-influencer core + Generation Engine

**Platform**
- One deployment now runs many influencers. Every table that holds
  influencer data carries `influencer_id`; every job carries its owner and runs
  inside that influencer's context (persona, knowledge, controls, Instagram
  account, budgets). Cross-influencer access is a hard error, not a warning.
- Webhooks are routed per entry to the influencer that owns the Instagram
  account; unknown accounts are dropped.
- Controls are layered: platform values (influencer 0) under per-influencer
  values. New platform-wide daily/monthly budget ceilings.
- Persona and knowledge live in the database (versioned); `config/persona.yaml`
  only seeds influencer #1 on upgrade (`PERSONA_SYNC_FROM_FILE=true` keeps
  syncing it).
- **Souls**: each influencer has a versioned identity pack (approved face
  references + provider bindings such as a Higgsfield Soul ID). Zuri was
  migrated to `soul_zuri_v1`.
- In-app **settings** (`app_settings`, AES-256-GCM): provider keys can be set
  in the console and override environment variables. LLM, storage, Telegram,
  webhook and OAuth settings are re-read without a restart.

**Generation Engine** (brief v2)
- Provider-agnostic contract, model/provider registry (DB is the source of
  truth; the code catalog seeds it), deterministic router (fixed,
  preferred+fallback, best quality, best value, fastest, capability-first,
  auto), idempotent requests, fallback on transient/provider classes only
  (never on content policy or budget), rolling health with automatic
  quarantine, durable influencer-scoped asset storage, per-attempt audit.
- Adapters: kie.ai, Higgsfield (incl. Soul ID training), fal.ai, Replicate,
  Runway, Luma (Agents API), Topview, plus an offline mock. 25 catalog models
  across image, reference/identity, edit, upscale and image/text-to-video.

**Calendar (backend)**: operator events (world or per influencer) feed the
content director and conversation context; ended events with an outcome are
recapped hourly into world memory.

**Fixes found during the upgrade**
- Webhook signature checks are awaited (they became async).
- Memory-extraction jobs carry their influencer.

Tests: 201 (router, engine fallback/idempotency/quarantine/budget, adapter
contracts for all providers, two-influencer isolation, settings, bootstrap,
calendar recaps).
