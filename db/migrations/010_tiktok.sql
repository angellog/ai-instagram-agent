-- TikTok as a second platform. An influencer can have a TikTok account next to
-- its Instagram one; a post belongs to exactly one platform, and a TikTok post
-- adapted from an Instagram post points back at it.
CREATE TABLE tiktok_accounts (
  id                  bigserial PRIMARY KEY,
  influencer_id       bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  open_id             text NOT NULL UNIQUE,
  username            text,
  display_name        text,
  avatar_url          text,
  scope               text,
  access_token_enc    text,
  refresh_token_enc   text,
  access_expires_at   timestamptz,
  refresh_expires_at  timestamptz,
  token_status        text NOT NULL DEFAULT 'ok' CHECK (token_status IN ('ok', 'invalid')),
  token_error         text,
  token_invalid_at    timestamptz,
  creator_info        jsonb NOT NULL DEFAULT '{}',
  stats               jsonb NOT NULL DEFAULT '{}',
  is_primary          boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tiktok_accounts_primary ON tiktok_accounts (influencer_id) WHERE is_primary;

ALTER TABLE posts ADD COLUMN platform text NOT NULL DEFAULT 'instagram' CHECK (platform IN ('instagram', 'tiktok'));
ALTER TABLE posts ADD COLUMN source_post_id uuid REFERENCES posts(id) ON DELETE SET NULL;
-- TikTok post settings and publish state: privacy, comments, promo, publish_id, status.
ALTER TABLE posts ADD COLUMN tiktok jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX posts_one_adaptation ON posts (source_post_id, platform) WHERE source_post_id IS NOT NULL;
CREATE INDEX posts_platform_idx ON posts (influencer_id, platform, created_at DESC);
