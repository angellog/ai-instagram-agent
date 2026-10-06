-- Tenant accounts. The operator (admin) onboards influencers; each influencer's
-- business gets its own logins that see only that influencer. No billing.
CREATE TABLE users (
  id                 bigserial PRIMARY KEY,
  email              text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' in email) > 1),
  name               text NOT NULL DEFAULT '',
  role               text NOT NULL CHECK (role IN ('admin', 'tenant')),
  influencer_id      bigint REFERENCES influencers(id) ON DELETE CASCADE,
  password_hash      text,
  status             text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  invite_token_hash  text,
  invite_expires_at  timestamptz,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_login_at      timestamptz,
  CHECK (role = 'admin' OR influencer_id IS NOT NULL)
);
CREATE INDEX users_influencer_idx ON users (influencer_id);

CREATE TABLE sessions (
  id            text PRIMARY KEY,            -- sha256 of the cookie token (the token itself is never stored)
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Interview: questions asked and answers given, per influencer (what's been asked, what's pending).
CREATE TABLE interview_answers (
  id             bigserial PRIMARY KEY,
  influencer_id  bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  topic          text NOT NULL,
  question       text NOT NULL,
  answer         text NOT NULL,
  applied        jsonb NOT NULL DEFAULT '{}',   -- what changed (persona sections, knowledge entries, memories)
  answered_by    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interview_answers_inf_idx ON interview_answers (influencer_id, created_at DESC);
