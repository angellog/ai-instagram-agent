-- "Create a post now": operator-triggered pipeline runs with live progress.
ALTER TABLE posts ADD COLUMN origin text NOT NULL DEFAULT 'scheduled' CHECK (origin IN ('scheduled', 'operator'));

CREATE TABLE create_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  stage         text NOT NULL DEFAULT 'queued',
  post_id       uuid REFERENCES posts(id) ON DELETE SET NULL,
  outcome       text,
  message       text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX create_runs_influencer_idx ON create_runs (influencer_id, created_at DESC);
