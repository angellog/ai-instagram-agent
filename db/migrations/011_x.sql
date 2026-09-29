-- X (Twitter) as a third channel. Phase 1 is read-only: an app-only bearer
-- token reads the account's mentions and its own posts' public metrics. It
-- cannot post, so nothing here feeds the conversation pipeline yet (that path
-- still sends through Instagram); mentions land in their own inbox table.
-- X ids are 64-bit snowflakes and are always stored as text.
CREATE TABLE x_accounts (
  id                 bigserial PRIMARY KEY,
  influencer_id      bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  x_user_id          text NOT NULL UNIQUE,
  username           text NOT NULL,
  display_name       text,
  avatar_url         text,
  stats              jsonb NOT NULL DEFAULT '{}',
  mentions_since_id  text,
  last_polled_at     timestamptz,
  last_poll_note     text,
  is_primary         boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX x_accounts_primary ON x_accounts (influencer_id) WHERE is_primary;

CREATE TABLE x_mentions (
  id                    bigserial PRIMARY KEY,
  influencer_id         bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  x_account_id          bigint NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
  tweet_id              text NOT NULL UNIQUE,
  conversation_id       text,
  in_reply_to_tweet_id  text,
  author_id             text NOT NULL,
  author_username       text,
  author_name           text,
  text                  text NOT NULL,
  lang                  text,
  posted_at             timestamptz NOT NULL,
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'ignored'))
);
CREATE INDEX x_mentions_inbox ON x_mentions (influencer_id, posted_at DESC);

-- One row per post per day it was measured, so a post's curve can be drawn.
CREATE TABLE x_post_metrics (
  tweet_id       text NOT NULL,
  day            date NOT NULL,
  influencer_id  bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  x_account_id   bigint NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
  text           text,
  posted_at      timestamptz NOT NULL,
  impressions    integer,
  likes          integer,
  replies        integer,
  reposts        integer,
  quotes         integer,
  bookmarks      integer,
  collected_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tweet_id, day)
);
CREATE INDEX x_post_metrics_account ON x_post_metrics (x_account_id, day DESC);

CREATE TABLE x_account_metrics (
  x_account_id   bigint NOT NULL REFERENCES x_accounts(id) ON DELETE CASCADE,
  day            date NOT NULL,
  followers      integer,
  following      integer,
  posts          integer,
  collected_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (x_account_id, day)
);
