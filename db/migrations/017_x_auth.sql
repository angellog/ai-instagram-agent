-- When X rejects the bearer token, remember which token (a short fingerprint,
-- never the token) so polling stops until a different one is saved, instead
-- of failing every 15 minutes.
ALTER TABLE x_accounts ADD COLUMN auth_failed_token text;
ALTER TABLE x_accounts ADD COLUMN auth_error text;
