-- v1.0.0: multi-influencer platform + provider-agnostic Generation Engine,
-- souls (identity packs), calendar, and the in-app settings store.
--
-- Upgrade-in-place: the existing single-influencer install becomes influencer
-- #1. Every existing row is backfilled to it, so nothing is lost. Persona and
-- knowledge text are filled in by the app on first boot (bootstrap.ts) from
-- config/*.yaml, because SQL cannot read files.

-- ---------------------------------------------------------------- influencers
CREATE TABLE influencers (
  id              bigserial PRIMARY KEY,
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'hatching' CHECK (status IN ('hatching', 'active', 'paused', 'archived')),
  persona_yaml    text NOT NULL DEFAULT '',
  knowledge_yaml  text NOT NULL DEFAULT '',
  avatar_url      text,
  hatch_state     jsonb NOT NULL DEFAULT '{}',   -- wizard progress for status = hatching
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  hatched_at      timestamptz
);
INSERT INTO influencers (id, slug, name, status, hatched_at) VALUES (1, 'default', 'Default', 'active', now());
SELECT setval('influencers_id_seq', 1);

-- ---------------------------------------------------------------- souls
-- A soul is an influencer's identity pack: approved references plus optional
-- provider-side character bindings (e.g. a Higgsfield Soul ID). Versioned so a
-- new face never silently rewrites history.
CREATE TABLE souls (
  id                 bigserial PRIMARY KEY,
  influencer_id      bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  soul_id            text NOT NULL UNIQUE CHECK (soul_id ~ '^soul_[a-z0-9_-]{2,60}$'),
  version            int NOT NULL DEFAULT 1,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'retired')),
  description        text,
  provider_bindings  jsonb NOT NULL DEFAULT '{}',   -- {"higgsfield": {"soul_id": "...", "model": "soul_cinematic"}}
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX souls_one_active ON souls (influencer_id) WHERE status = 'active';

CREATE TABLE visual_references (
  id             bigserial PRIMARY KEY,
  influencer_id  bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  soul_id        bigint REFERENCES souls(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('identity', 'style', 'wardrobe', 'environment', 'candidate')),
  url            text NOT NULL,
  storage_key    text,
  is_primary     boolean NOT NULL DEFAULT false,
  label          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visual_references_owner_idx ON visual_references (influencer_id, kind);

-- ---------------------------------------------------------------- scope existing tables
ALTER TABLE ig_accounts ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE ig_accounts ALTER COLUMN influencer_id DROP DEFAULT;
DROP INDEX ig_accounts_one_primary;
CREATE UNIQUE INDEX ig_accounts_one_primary ON ig_accounts (influencer_id) WHERE is_primary;

ALTER TABLE webhook_events ADD COLUMN influencer_ids bigint[] NOT NULL DEFAULT '{}';

ALTER TABLE interactions ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE interactions ALTER COLUMN influencer_id DROP DEFAULT;
CREATE INDEX interactions_influencer_idx ON interactions (influencer_id, created_at DESC);

ALTER TABLE ig_users ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE ig_users ALTER COLUMN influencer_id DROP DEFAULT;
ALTER TABLE ig_users DROP CONSTRAINT ig_users_ig_scoped_id_key;
CREATE UNIQUE INDEX ig_users_influencer_scoped ON ig_users (influencer_id, ig_scoped_id);

ALTER TABLE conversations ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE conversations ALTER COLUMN influencer_id DROP DEFAULT;
ALTER TABLE conversations DROP CONSTRAINT conversations_thread_key_key;
CREATE UNIQUE INDEX conversations_influencer_thread ON conversations (influencer_id, thread_key);

ALTER TABLE messages ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE messages ALTER COLUMN influencer_id DROP DEFAULT;
CREATE INDEX messages_influencer_out_idx ON messages (influencer_id, direction, created_at DESC);

ALTER TABLE memories ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE memories ALTER COLUMN influencer_id DROP DEFAULT;
DROP INDEX memories_active_key;
CREATE UNIQUE INDEX memories_active_key ON memories (influencer_id, layer, coalesce(ig_user_id, 0), kind, key) WHERE status = 'active';

ALTER TABLE activities ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE activities ALTER COLUMN influencer_id DROP DEFAULT;
ALTER TABLE activities DROP CONSTRAINT activities_day_slot_activity_key;
CREATE UNIQUE INDEX activities_influencer_day ON activities (influencer_id, day, slot, activity);

ALTER TABLE content_ideas ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE content_ideas ALTER COLUMN influencer_id DROP DEFAULT;
CREATE INDEX content_ideas_influencer_idx ON content_ideas (influencer_id, created_at DESC);

ALTER TABLE posts ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE posts ALTER COLUMN influencer_id DROP DEFAULT;
CREATE INDEX posts_influencer_idx ON posts (influencer_id, status, created_at DESC);

ALTER TABLE engagement_metrics ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE engagement_metrics ALTER COLUMN influencer_id DROP DEFAULT;

ALTER TABLE account_metrics ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE account_metrics ALTER COLUMN influencer_id DROP DEFAULT;
ALTER TABLE account_metrics DROP CONSTRAINT account_metrics_day_key;
CREATE UNIQUE INDEX account_metrics_influencer_day ON account_metrics (influencer_id, day);

ALTER TABLE learnings ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE learnings ALTER COLUMN influencer_id DROP DEFAULT;
ALTER TABLE learnings DROP CONSTRAINT learnings_pkey;
ALTER TABLE learnings ADD PRIMARY KEY (influencer_id, dimension, value);

ALTER TABLE agent_decisions ADD COLUMN influencer_id bigint REFERENCES influencers(id) ON DELETE CASCADE;
UPDATE agent_decisions SET influencer_id = 1;
CREATE INDEX agent_decisions_influencer_idx ON agent_decisions (influencer_id, created_at DESC);

ALTER TABLE safety_reviews ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE safety_reviews ALTER COLUMN influencer_id DROP DEFAULT;

ALTER TABLE system_events ADD COLUMN influencer_id bigint REFERENCES influencers(id) ON DELETE SET NULL;
ALTER TABLE job_runs ADD COLUMN influencer_id bigint REFERENCES influencers(id) ON DELETE SET NULL;

ALTER TABLE cost_ledger ADD COLUMN influencer_id bigint REFERENCES influencers(id) ON DELETE SET NULL;
UPDATE cost_ledger SET influencer_id = 1;
CREATE INDEX cost_ledger_influencer_idx ON cost_ledger (influencer_id, occurred_at DESC);

ALTER TABLE persona_versions ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1 REFERENCES influencers(id) ON DELETE CASCADE;
ALTER TABLE persona_versions ALTER COLUMN influencer_id DROP DEFAULT;
ALTER TABLE persona_versions DROP CONSTRAINT persona_versions_hash_key;
CREATE UNIQUE INDEX persona_versions_influencer_hash ON persona_versions (influencer_id, hash);

-- Controls: influencer_id 0 = platform-wide values (global ceilings).
ALTER TABLE controls ADD COLUMN influencer_id bigint NOT NULL DEFAULT 1;
ALTER TABLE controls ALTER COLUMN influencer_id DROP DEFAULT;
ALTER TABLE controls DROP CONSTRAINT controls_pkey;
ALTER TABLE controls ADD PRIMARY KEY (influencer_id, key);

-- ---------------------------------------------------------------- assets
CREATE TABLE assets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id          bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
  url                    text NOT NULL,
  storage_provider       text,
  storage_key            text,
  mime_type              text,
  width                  int,
  height                 int,
  duration_seconds       real,
  sha256                 text,
  provider               text,
  model                  text,
  generation_request_id  uuid,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_influencer_idx ON assets (influencer_id, created_at DESC);
ALTER TABLE post_assets ADD COLUMN asset_id uuid REFERENCES assets(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- generation engine
CREATE TABLE generation_providers (
  id                 text PRIMARY KEY,           -- kie | higgsfield | fal | replicate | runway | luma | topview | mock
  display_name       text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  health_status      text NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unavailable')),
  quarantined_until  timestamptz,
  last_success_at    timestamptz,
  last_error         text,
  last_error_at      timestamptz,
  last_verified_at   timestamptz,
  verified           boolean NOT NULL DEFAULT false,  -- a real paid call has succeeded at least once
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE generation_models (
  id                 bigserial PRIMARY KEY,
  provider_id        text NOT NULL REFERENCES generation_providers(id) ON DELETE CASCADE,
  model_id           text NOT NULL,
  display_name       text NOT NULL,
  capabilities       text[] NOT NULL,           -- text_to_image | image_edit | reference_image | upscale | image_to_video | text_to_video | soul
  supported_ratios   text[] NOT NULL DEFAULT '{}',
  resolution_options text[] NOT NULL DEFAULT '{}',
  max_duration       real,
  reference_limit    int NOT NULL DEFAULT 0,
  identity_score     real NOT NULL DEFAULT 0.5 CHECK (identity_score BETWEEN 0 AND 1),
  quality_score      real NOT NULL DEFAULT 0.5 CHECK (quality_score BETWEEN 0 AND 1),
  speed_score        real NOT NULL DEFAULT 0.5 CHECK (speed_score BETWEEN 0 AND 1),
  cost_estimate_usd  numeric(10, 4) NOT NULL DEFAULT 0,
  cost_unit          text NOT NULL DEFAULT 'image' CHECK (cost_unit IN ('image', 'second', 'request')),
  enabled            boolean NOT NULL DEFAULT true,
  health_status      text NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unavailable')),
  quarantined_until  timestamptz,
  deprecated         boolean NOT NULL DEFAULT false,
  version            text,
  catalog_version    int NOT NULL DEFAULT 1,
  scores_source      text NOT NULL DEFAULT 'catalog' CHECK (scores_source IN ('catalog', 'benchmark', 'operator')),
  last_verified_at   timestamptz,
  config             jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_id)
);

-- influencer_id 0 = platform default policy.
CREATE TABLE generation_policies (
  influencer_id        bigint PRIMARY KEY,
  mode                 text NOT NULL DEFAULT 'preferred_fallback'
                       CHECK (mode IN ('fixed', 'preferred_fallback', 'best_quality', 'best_value', 'fastest', 'capability_first', 'auto')),
  preferred_model_id   bigint REFERENCES generation_models(id) ON DELETE SET NULL,
  fallback_model_ids   bigint[] NOT NULL DEFAULT '{}',
  allowed_modalities   text[] NOT NULL DEFAULT '{text_to_image,image_edit,reference_image,upscale}',
  quality_tier         text NOT NULL DEFAULT 'high' CHECK (quality_tier IN ('draft', 'standard', 'high', 'max')),
  max_cost_per_job_usd numeric(10, 4) NOT NULL DEFAULT 0.5,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO generation_policies (influencer_id) VALUES (0);

CREATE TABLE generation_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id     bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  idempotency_key   text NOT NULL UNIQUE,
  post_id           uuid REFERENCES posts(id) ON DELETE SET NULL,
  purpose           text NOT NULL DEFAULT 'post',   -- post | soul | benchmark | manual
  modality          text NOT NULL,
  request           jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  provider_id       text,
  model_id          text,
  asset_ids         uuid[] NOT NULL DEFAULT '{}',
  cost_usd          numeric(12, 6) NOT NULL DEFAULT 0,
  attempts          int NOT NULL DEFAULT 0,
  route             jsonb NOT NULL DEFAULT '{}',    -- router decision: mode, candidates, reasons
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
CREATE INDEX generation_requests_influencer_idx ON generation_requests (influencer_id, created_at DESC);

-- The v0 per-slide table becomes the per-attempt audit table.
ALTER TABLE generation_jobs RENAME TO generation_attempts;
ALTER TABLE generation_attempts RENAME COLUMN task_id TO provider_request_id;
ALTER TABLE generation_attempts ADD COLUMN request_id uuid REFERENCES generation_requests(id) ON DELETE CASCADE;
ALTER TABLE generation_attempts ADD COLUMN influencer_id bigint REFERENCES influencers(id) ON DELETE CASCADE;
UPDATE generation_attempts SET influencer_id = 1;
ALTER TABLE generation_attempts ADD COLUMN error_class text;   -- validation | auth | rate_limit | timeout | provider | content_policy | budget
ALTER TABLE generation_attempts DROP CONSTRAINT IF EXISTS generation_jobs_status_check;
ALTER TABLE generation_attempts ADD CONSTRAINT generation_attempts_status_check CHECK (status IN ('queued', 'submitted', 'success', 'failed', 'cancelled'));
CREATE INDEX generation_attempts_provider_idx ON generation_attempts (provider, created_at DESC);
CREATE INDEX generation_attempts_model_idx ON generation_attempts (model, created_at DESC);
CREATE INDEX generation_attempts_request_idx ON generation_attempts (request_id);

CREATE TABLE benchmark_runs (
  id              bigserial PRIMARY KEY,
  influencer_id   bigint REFERENCES influencers(id) ON DELETE CASCADE,
  model_row_id    bigint NOT NULL REFERENCES generation_models(id) ON DELETE CASCADE,
  suite           text NOT NULL,
  case_id         text NOT NULL,
  prompt          text NOT NULL,
  asset_url       text,
  scores          jsonb NOT NULL DEFAULT '{}',   -- {identity, photorealism, adherence, overall}
  cost_usd        numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms      int,
  status          text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('succeeded', 'failed')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX benchmark_runs_model_idx ON benchmark_runs (model_row_id, created_at DESC);

-- ---------------------------------------------------------------- calendar
-- Operator-curated current affairs and life events. influencer_id NULL = a
-- world event every influencer knows about.
CREATE TABLE calendar_events (
  id              bigserial PRIMARY KEY,
  influencer_id   bigint REFERENCES influencers(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description     text,
  kind            text NOT NULL DEFAULT 'world' CHECK (kind IN ('world', 'personal', 'business', 'holiday', 'launch', 'sport', 'culture')),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz,
  all_day         boolean NOT NULL DEFAULT true,
  location        text,
  importance      int NOT NULL DEFAULT 2 CHECK (importance BETWEEN 1 AND 3),
  use_for         text NOT NULL DEFAULT 'both' CHECK (use_for IN ('content', 'conversation', 'both', 'context')),
  outcome         text,                 -- what actually happened (filled after the fact)
  recapped_at     timestamptz,          -- when it was written into world memory
  created_by      text NOT NULL DEFAULT 'operator',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX calendar_events_time_idx ON calendar_events (starts_at);
CREATE INDEX calendar_events_influencer_idx ON calendar_events (influencer_id, starts_at);

-- ---------------------------------------------------------------- settings
-- In-app configuration (Config page). Secrets are AES-256-GCM encrypted with
-- ENCRYPTION_KEY; a value here overrides the environment variable of the same name.
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value_enc   text,
  value_plain text,
  is_secret   boolean NOT NULL DEFAULT true,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
