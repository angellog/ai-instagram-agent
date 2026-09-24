-- ai-instagram-agent: initial schema.
-- Conventions: bigserial ids for append-heavy tables, uuid for entities that
-- appear in URLs; every table has created_at; mutable tables have updated_at;
-- every Instagram object id is stored as text with a unique constraint where it
-- identifies a real-world object (this is what makes retries idempotent).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- persona
CREATE TABLE persona_versions (
  id           bigserial PRIMARY KEY,
  hash         text NOT NULL UNIQUE,
  name         text NOT NULL,
  source_yaml  text NOT NULL,
  parsed       jsonb NOT NULL,
  loaded_at    timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------- instagram accounts
CREATE TABLE ig_accounts (
  id                  bigserial PRIMARY KEY,
  ig_user_id          text NOT NULL UNIQUE,
  username            text,
  access_token_enc    text,            -- AES-256-GCM, see lib/crypto
  access_token_plain  text,            -- only used when ENCRYPTION_KEY is unset (dev)
  token_expires_at    timestamptz,
  token_refreshed_at  timestamptz,
  is_primary          boolean NOT NULL DEFAULT false,
  profile             jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ig_accounts_one_primary ON ig_accounts (is_primary) WHERE is_primary;

-- --------------------------------------------------------- webhook intake
CREATE TABLE webhook_events (
  id            bigserial PRIMARY KEY,
  source        text NOT NULL CHECK (source IN ('meta', 'openreply_relay', 'simulated')),
  dedup_key     text NOT NULL UNIQUE,     -- sha256 of the raw body
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'queued', 'ignored', 'failed')),
  event_count   int NOT NULL DEFAULT 0,
  error         text,
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per normalized interaction (comment, DM, reply). The unique
-- (kind, ig_object_id) is the idempotency key for the whole conversation path.
CREATE TABLE interactions (
  id              bigserial PRIMARY KEY,
  webhook_event_id bigint REFERENCES webhook_events(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('comment', 'comment_reply', 'dm', 'story_reply', 'story_mention')),
  ig_object_id    text NOT NULL,            -- comment id or message mid
  ig_account_id   text NOT NULL,            -- the persona account that received it
  sender_ig_id    text NOT NULL,
  sender_username text,
  text            text NOT NULL DEFAULT '',
  media_id        text,
  parent_comment_id text,
  occurred_at     timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'done', 'ignored', 'escalated', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ig_object_id)
);
CREATE INDEX interactions_status_idx ON interactions (status, created_at);

-- ---------------------------------------------------------------- people
CREATE TABLE ig_users (
  id                    bigserial PRIMARY KEY,
  ig_scoped_id          text NOT NULL UNIQUE,
  username              text,
  first_interaction_at  timestamptz NOT NULL DEFAULT now(),
  last_interaction_at   timestamptz NOT NULL DEFAULT now(),
  interaction_count     int NOT NULL DEFAULT 0,
  relationship_summary  text,
  known_interests       text[] NOT NULL DEFAULT '{}',
  preferences           jsonb NOT NULL DEFAULT '{}',
  trust                 text NOT NULL DEFAULT 'normal' CHECK (trust IN ('normal', 'vip', 'muted', 'blocked')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id               bigserial PRIMARY KEY,
  ig_user_id       bigint NOT NULL REFERENCES ig_users(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('dm', 'comments')),
  thread_key       text NOT NULL UNIQUE,     -- dm:<sender> | comments:<media>:<sender>
  media_id         text,
  summary          text,
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  message_count    int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id               bigserial PRIMARY KEY,
  conversation_id  bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  interaction_id   bigint REFERENCES interactions(id) ON DELETE SET NULL,
  direction        text NOT NULL CHECK (direction IN ('in', 'out')),
  channel          text NOT NULL CHECK (channel IN ('dm', 'public_reply', 'private_reply', 'comment')),
  text             text NOT NULL,
  ig_object_id     text,                     -- id Meta returned for an outbound send
  status           text NOT NULL DEFAULT 'sent' CHECK (status IN ('received', 'pending_review', 'sending', 'sent', 'dry_run', 'failed', 'rejected', 'blocked')),
  decision_id      bigint,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at DESC);
-- An interaction gets at most one outbound message per channel, even under retries.
CREATE UNIQUE INDEX messages_one_reply_per_channel ON messages (interaction_id, channel) WHERE direction = 'out';

-- ---------------------------------------------------------------- memory
CREATE TABLE memories (
  id            bigserial PRIMARY KEY,
  layer         text NOT NULL CHECK (layer IN ('identity', 'world', 'relationship')),
  ig_user_id    bigint REFERENCES ig_users(id) ON DELETE CASCADE,
  kind          text NOT NULL,                -- interest | preference | fact | question | event | theme | ...
  key           text NOT NULL,                -- normalized dedupe key
  content       text NOT NULL,
  confidence    real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  importance    real NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  source_type   text NOT NULL,                -- message | post | persona | system | operator
  source_id     text,
  expires_at    timestamptz,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'superseded', 'deleted')),
  times_used    int NOT NULL DEFAULT 0,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memories_active_key ON memories (layer, coalesce(ig_user_id, 0), kind, key) WHERE status = 'active';
CREATE INDEX memories_user_idx ON memories (ig_user_id, status);

-- ---------------------------------------------------------- daily life
CREATE TABLE activities (
  id              bigserial PRIMARY KEY,
  day             date NOT NULL,
  slot            text NOT NULL,              -- morning | late_morning | lunch | afternoon | evening | night
  activity        text NOT NULL,
  location        text,
  description     text,
  interest_score  real,
  decision        text NOT NULL DEFAULT 'planned' CHECK (decision IN ('planned', 'post', 'skip', 'posted')),
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day, slot, activity)
);

-- ---------------------------------------------------------------- content
CREATE TABLE content_ideas (
  id                 bigserial PRIMARY KEY,
  activity_id        bigint REFERENCES activities(id) ON DELETE SET NULL,
  format             text NOT NULL CHECK (format IN ('single', 'carousel')),
  structure          text NOT NULL,           -- educational | opinion | storytelling | lifestyle_diary | listicle | sneaker_commentary | reflection | behind_the_scenes | moment
  topic              text NOT NULL,
  hook               text NOT NULL,
  angle              text,
  plan               jsonb NOT NULL DEFAULT '{}',   -- slide outline + visual concepts
  caption            text,
  visual_state       jsonb NOT NULL DEFAULT '{}',   -- outfit, location, time_of_day, composition, hairstyle
  repetition_score   real,
  repetition_detail  jsonb,
  status             text NOT NULL DEFAULT 'proposed'
                     CHECK (status IN ('proposed', 'rejected', 'accepted', 'produced', 'failed')),
  reject_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_idea_id    bigint REFERENCES content_ideas(id) ON DELETE SET NULL,
  media_type         text NOT NULL CHECK (media_type IN ('IMAGE', 'CAROUSEL')),
  caption            text NOT NULL,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'generating', 'composing', 'qc_failed', 'awaiting_review',
                                       'approved', 'publishing', 'published', 'dry_run', 'failed', 'rejected')),
  safety_level       text CHECK (safety_level IN ('green', 'yellow', 'red')),
  qc                 jsonb NOT NULL DEFAULT '{}',
  visual_state       jsonb NOT NULL DEFAULT '{}',
  scheduled_for      timestamptz,
  ig_container_id    text,
  ig_child_container_ids text[] NOT NULL DEFAULT '{}',
  ig_media_id        text UNIQUE,
  permalink          text,
  publish_attempts   int NOT NULL DEFAULT 0,
  last_error         text,
  published_at       timestamptz,
  reviewed_by        text,
  reviewed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_status_idx ON posts (status, created_at DESC);

CREATE TABLE post_assets (
  id                 bigserial PRIMARY KEY,
  post_id            uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  position           int NOT NULL,
  role               text NOT NULL DEFAULT 'slide',  -- cover | slide | single
  prompt             text,
  overlay            jsonb,                          -- text layer spec used by the composer
  generated_url      text,                           -- raw provider URL (expires)
  public_url         text,                           -- composed JPEG on durable storage
  storage_provider   text,
  width              int,
  height             int,
  sha256             text,
  qc                 jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, position)
);

CREATE TABLE generation_jobs (
  id            bigserial PRIMARY KEY,
  post_id       uuid REFERENCES posts(id) ON DELETE CASCADE,
  position      int,
  provider      text NOT NULL,
  model         text NOT NULL,
  task_id       text UNIQUE,
  key_index     int,
  prompt        text NOT NULL,
  input         jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'submitted', 'success', 'failed')),
  attempt       int NOT NULL DEFAULT 1,
  result_urls   text[] NOT NULL DEFAULT '{}',
  credits       real,
  cost_usd      numeric(12, 6),
  error         text,
  latency_ms    int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generation_jobs_post_idx ON generation_jobs (post_id, position);

-- ------------------------------------------------------------- analytics
CREATE TABLE engagement_metrics (
  id                 bigserial PRIMARY KEY,
  post_id            uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  ig_media_id        text NOT NULL,
  checkpoint         text NOT NULL,          -- 1h | 24h | 72h | 7d | manual
  reach              int,
  views              int,
  likes              int,
  comments           int,
  saves              int,
  shares             int,
  profile_visits     int,
  follows            int,
  total_interactions int,
  score              real,
  raw                jsonb NOT NULL DEFAULT '{}',
  collected_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, checkpoint)
);

CREATE TABLE account_metrics (
  id            bigserial PRIMARY KEY,
  day           date NOT NULL UNIQUE,
  followers     int,
  reach         int,
  profile_views int,
  accounts_engaged int,
  raw           jsonb NOT NULL DEFAULT '{}',
  collected_at  timestamptz NOT NULL DEFAULT now()
);

-- What the engagement loop has learned: running mean score per dimension value.
CREATE TABLE learnings (
  dimension     text NOT NULL,     -- format | structure | activity | slot | location
  value         text NOT NULL,
  samples       int NOT NULL DEFAULT 0,
  mean_score    real NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dimension, value)
);

-- ------------------------------------------------------- audit & safety
CREATE TABLE agent_decisions (
  id             bigserial PRIMARY KEY,
  agent          text NOT NULL,             -- conversation_agent | content_director | safety | ...
  subject_type   text NOT NULL,             -- interaction | content_idea | post | activity
  subject_id     text NOT NULL,
  intent         text,
  action         text NOT NULL,
  confidence     real,
  safety_level   text CHECK (safety_level IN ('green', 'yellow', 'red')),
  context_used   text[] NOT NULL DEFAULT '{}',
  reason         text,                       -- concise operational reason, never chain-of-thought
  output         jsonb NOT NULL DEFAULT '{}',
  latency_ms     int,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_decisions_subject_idx ON agent_decisions (subject_type, subject_id);
CREATE INDEX agent_decisions_created_idx ON agent_decisions (created_at DESC);

CREATE TABLE safety_reviews (
  id             bigserial PRIMARY KEY,
  subject_type   text NOT NULL CHECK (subject_type IN ('reply', 'post')),
  subject_id     text NOT NULL,
  level          text NOT NULL CHECK (level IN ('green', 'yellow', 'red')),
  categories     text[] NOT NULL DEFAULT '{}',
  reason         text,
  proposed       jsonb NOT NULL DEFAULT '{}',   -- what would be sent / published
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  reviewer       text,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id)
);
CREATE INDEX safety_reviews_pending_idx ON safety_reviews (status, created_at) WHERE status = 'pending';

CREATE TABLE system_events (
  id          bigserial PRIMARY KEY,
  level       text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  source      text NOT NULL,
  message     text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_events_created_idx ON system_events (created_at DESC);

CREATE TABLE job_runs (
  id           bigserial PRIMARY KEY,
  queue        text NOT NULL,
  job_name     text NOT NULL,
  job_id       text NOT NULL,
  status       text NOT NULL CHECK (status IN ('completed', 'failed', 'retrying')),
  attempt      int NOT NULL,
  duration_ms  int,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_runs_created_idx ON job_runs (created_at DESC);

-- ------------------------------------------------------------------ costs
CREATE TABLE cost_ledger (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  category     text NOT NULL CHECK (category IN ('llm', 'image', 'storage', 'api', 'compute')),
  provider     text NOT NULL,
  model        text,
  operation    text NOT NULL,              -- conversation | memory | plan | caption | image | image_retry | safety | ...
  units        jsonb NOT NULL DEFAULT '{}', -- {input_tokens, output_tokens} | {credits} | {bytes}
  cost_usd     numeric(12, 6) NOT NULL DEFAULT 0,
  ref_type     text,
  ref_id       text
);
CREATE INDEX cost_ledger_time_idx ON cost_ledger (occurred_at DESC);
CREATE INDEX cost_ledger_ref_idx ON cost_ledger (ref_type, ref_id);

-- ------------------------------------------------------------- controls
CREATE TABLE controls (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
