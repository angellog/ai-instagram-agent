-- Engagement (v1.0.29): replies to @mentions on other accounts' posts, and the
-- engagement scout's queue of drafted comments for a person to post by hand.

-- An @mention of the influencer in someone else's comment or caption.
ALTER TABLE interactions DROP CONSTRAINT IF EXISTS interactions_kind_check;
ALTER TABLE interactions ADD CONSTRAINT interactions_kind_check
  CHECK (kind IN ('comment', 'comment_reply', 'dm', 'story_reply', 'story_mention', 'mention'));

-- Answered through Instagram's /mentions edge (the only way an app may comment on another account's media).
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('dm', 'public_reply', 'private_reply', 'comment', 'mention_reply'));

-- Drafted comments for other people's posts. Apps can't like or comment on
-- other accounts' posts, so a person opens the post and posts the comment.
CREATE TABLE IF NOT EXISTS engagement_drafts (
  id             bigserial PRIMARY KEY,
  influencer_id  bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('hashtag', 'link')),
  hashtag        text,
  ig_media_id    text,
  permalink      text NOT NULL,
  author         text,
  caption        text NOT NULL DEFAULT '',
  comment        text NOT NULL,
  why            text,
  status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done', 'skipped')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  acted_at       timestamptz,
  acted_by       text,
  UNIQUE (influencer_id, permalink)
);
CREATE INDEX IF NOT EXISTS engagement_drafts_queue ON engagement_drafts (influencer_id, status, created_at DESC);

-- Meta allows 30 unique hashtags per 7 days per searching account: every lookup is recorded.
CREATE TABLE IF NOT EXISTS hashtag_queries (
  id            bigserial PRIMARY KEY,
  scout_user_id text NOT NULL,
  hashtag       text NOT NULL,
  hashtag_id    text,
  influencer_id bigint REFERENCES influencers(id) ON DELETE SET NULL,
  queried_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hashtag_queries_window ON hashtag_queries (scout_user_id, queried_at DESC);
