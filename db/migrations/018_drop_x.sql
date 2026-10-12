-- X moved to the standalone feetbit-x-worker (brand account, owner login).
-- The agent's X tables never held data (its bearer token was always refused).
DROP TABLE IF EXISTS x_account_metrics;
DROP TABLE IF EXISTS x_post_metrics;
DROP TABLE IF EXISTS x_mentions;
DROP TABLE IF EXISTS x_accounts;
DELETE FROM app_settings WHERE key = 'X_BEARER_TOKEN';
DELETE FROM controls WHERE key IN ('x_enabled', 'x_daily_read_cap', 'daily_x_api_budget_usd');
