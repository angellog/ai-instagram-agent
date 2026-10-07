# 3-upgrade build (started 2026-10-08)

Loop: every 30 min (session cron 64a9db80), until all three are complete, tested,
documented in CHANGELOG and committed. No push/deploy until Angelo says "deploy".
Standardised for all 5 influencers per the blueprint rule in CLAUDE.md.

## 1. Liquid glass everywhere + no overflow (/impeccable) — DONE
- [x] Audit every page at 1280px and 375px, light and dark: overflow list
- [x] Glass material on all panels/cards that float or group settings (dense data on solid insets)
- [x] Fix every overflow (tables, long words, chips, headers, forms)
- [x] Reduced-transparency + no-backdrop-filter fallbacks hold everywhere
- [x] Detector + screenshots checked; tests green

## 2. IRL content skills: a timeline that feels lived — DONE
- [x] Life arcs (multi-week storylines) per influencer: schema + template + Standard check
- [x] Moment library: specific, local, sensory, imperfect moments; callbacks to earlier posts
- [x] Director uses arcs + callbacks; anti-generic checks on ideas and captions
- [x] Tests; docs

## 3. Short-form engagement + engagement scout — DONE
- [x] Short-form formats: silly talk, funny questions, football banter (persona-aware, playful only)
- [x] Engagement scout: official hashtag search, persona-voice comment drafts, one-tap manual queue
- [x] Auto-reply to @mentions where the API allows; never unofficial automation
- [x] Standard check + template; tests; docs

## Log
- 2026-10-08: plan written; loop scheduled.
- 2026-10-08: Upgrade 1 done. 30 routes at 375/1280 both themes, no page overflow; detector 0 warnings (3 fixed); fact-check unit fix; 394 tests green; committed.
- 2026-10-08: Upgrade 2 done. life schema + Standard (3 checks, AI fix) + template + hatch + Interview; director/stories/chats use it; Timeline page; 408 tests green. After deploy: Bring all up to standard (others get life via AI fix).
- 2026-10-08: Upgrade 3 done. engagement schema + 2 Standard checks + template/hatch/Interview; talk reels, banter stories, Engagement page, compliant scout (hashtag search needs a Facebook Login token the operator adds; pasted links work now), @mention replies via /mentions; 422 tests green; detector 0 warnings. All 3 upgrades complete; loop stopped. Not pushed: waiting for "deploy".
