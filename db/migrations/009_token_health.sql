-- Instagram token health: Meta can end a session at any time (code 190: password
-- change, security check). The account is then marked disconnected so nothing
-- keeps planning, generating or calling Meta for it until it's reconnected.
ALTER TABLE ig_accounts ADD COLUMN token_status text NOT NULL DEFAULT 'ok' CHECK (token_status IN ('ok', 'invalid'));
ALTER TABLE ig_accounts ADD COLUMN token_error text;
ALTER TABLE ig_accounts ADD COLUMN token_invalid_at timestamptz;
