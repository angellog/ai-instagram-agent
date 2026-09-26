-- Trends and news awareness: raw headlines per influencer and the filtered brief the agents read.
CREATE TABLE trend_items (
  id            bigserial PRIMARY KEY,
  influencer_id bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  source        text NOT NULL,
  title         text NOT NULL,
  link          text NOT NULL,
  published_at  timestamptz,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (influencer_id, link)
);
CREATE INDEX trend_items_influencer_idx ON trend_items (influencer_id, coalesce(published_at, fetched_at) DESC);

CREATE TABLE trend_briefs (
  id            bigserial PRIMARY KEY,
  influencer_id bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  items         jsonb NOT NULL DEFAULT '[]',   -- [{title, link, note, use}]
  skipped       int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trend_briefs_influencer_idx ON trend_briefs (influencer_id, created_at DESC);
