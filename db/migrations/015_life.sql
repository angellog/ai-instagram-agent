-- Life timeline (v1.0.29): what each post or story used from the influencer's
-- life (storyline beat, moment, callback). Storyline progress and moment reuse
-- are read from here, so a rejected or failed post gives its beat back.
ALTER TABLE content_ideas ADD COLUMN IF NOT EXISTS life jsonb;
CREATE INDEX IF NOT EXISTS content_ideas_life_arc ON content_ideas (influencer_id, (life->>'arc_id')) WHERE life IS NOT NULL;
