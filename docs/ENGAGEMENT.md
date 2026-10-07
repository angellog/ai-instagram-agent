# Engagement: short-form, the scout, and @mentions

What each influencer does to get people talking, and where Instagram's rules
draw the line. Same for every influencer (the persona's `engagement` section,
held to the Standard).

## What Instagram allows an app to do

| Action | Allowed? | How we do it |
|---|---|---|
| Post reels, stories, posts | Yes | Talk reels and banter stories (below) |
| Reply to comments on our own posts | Yes | The conversation agent (unchanged) |
| Reply where we were **@mentioned** on someone else's post | Yes | `POST /<IG_ID>/mentions` (`media_id`, `comment_id`, `message`) |
| Read public posts for a **hashtag** | Yes, with **Facebook Login** + Instagram Public Content Access (app review) | Engagement scout |
| **Like** someone else's post | **No** (no API) | A person taps like |
| **Comment** on someone else's post (not a mention) | **No** | The scout drafts it; a person posts it |

No browser automation and no private API: those break Instagram's terms and
get accounts banned.

## Short-form that gets replies

Persona `engagement`:

```yaml
engagement:
  formats: [silly_talk, funny_question, football_banter, this_or_that, hot_take]
  football: { team: Arsenal, league: Premier League, rivals: [Tottenham, Chelsea] }   # or null
  questions: [...]      # 10+ short, funny questions followers answer
  silly_talk: [...]     # 6+ short silly takes in their voice
  scout_hashtags: [...] # 5+ community hashtags, no #
  comment_style: ...    # how they comment on other people's posts
```

- **Talk reel** (`reels/plan.ts`, kind `talk`): one 5-8 s front-camera clip of
  the influencer reacting or talking; the line is the on-screen hook; the
  caption asks people to answer. Roughly every other reel for creators with
  formats.
- **Banter story** (`content/stories.ts`, kind `banter`): a photo without the
  influencer (the TV at the watch party, two options side by side) plus a
  playful line. Question stories use the same question bank.
- **Engagement page** → "Short-form ideas for today": three questions, two
  silly takes and a club-banter idea, each one tap from Create (talk reel or
  story).
- Football news in the trends brief nudges banter on matchdays (only what the
  headline says; never invented scores).
- **Playful only**, in every prompt and behind the usual safety check: never
  romantic or sexual, never flirting with anyone, nothing about bodies or
  looks, no betting, no politics or religion; rivalry is about clubs, never
  people.

## Engagement scout

`src/engagement/scout.ts`, page **Operate → Engagement**.

1. Twice a day (`engagement.scout`, 09:15 and 15:15 UTC) for each active
   influencer: pick two of the persona's hashtags (rotating daily), read their
   recent public posts (`ig_hashtag_search`, `/{hashtag}/recent_media`).
2. Shortlist: has real words, isn't ours, isn't queued already, isn't an ad,
   giveaway or "link in bio".
3. Draft one comment each in the persona's voice: one line, about something
   specific in the post, no links, tags, hashtags, brand or selling. The model
   skips grief, politics, children and anything a stranger shouldn't comment
   on; code re-checks the house rules and the safety filter.
4. The **comment queue**: *Copy & open post* copies the comment and opens the
   post; you paste it from the influencer's account (and like it if you do),
   then tap *Posted it* (edits are saved). *Skip* drops it.

Limits: **30 different hashtags per 7 days** per searching account (Meta's
rule; every lookup is recorded in `hashtag_queries`, known hashtags cost
nothing new), and Controls → Engagement → *Scout drafts per day* (default 8).

**Without a scout token** the scheduled run is a no-op, and the queue is fed by
pasted links: one post per line, `link | what it shows or its caption`.

### Setting up hashtag search (you do this; it needs your Meta login)

1. In the Meta app, add the **Facebook Login for Business** product and the
   **Instagram Public Content Access** feature, and request it in App Review.
2. Connect an Instagram professional account to a Facebook Page.
3. Generate a long-lived token with `instagram_basic` and
   `pages_read_engagement` for that Page's Instagram account.
4. Config & keys → Instagram: paste it as **Engagement scout token**, and the
   Instagram account's ID (17841…) as **Engagement scout Instagram account ID**.

One scout account searches for every influencer; the drafts are per
influencer.

## @mentions

With Instagram Login, an @mention of the influencer on someone else's post
arrives as an ordinary `comments` webhook. Ingest (`ingest/process.ts`)
reclassifies it as kind `mention` when the text tags the influencer's handle
and the media isn't one of theirs. The agent answers on channel
`mention_reply` through `/mentions`, with the same safety check, review rules
(human approval, dry run, yellow review) and hourly comment limit as comment
replies. Controls → Engagement → *Reply to @mentions* turns it off. Story
mentions still have no reply API and are skipped. No webhook subscription
change is needed.
