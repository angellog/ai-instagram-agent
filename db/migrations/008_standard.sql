-- The Influencer Standard: the last "bring up to standard" run per influencer.
ALTER TABLE influencers ADD COLUMN standard_run jsonb NOT NULL DEFAULT '{}';
