-- Operator "Post now" / "Schedule" decisions publish even while the influencer
-- runs in dry_run (an explicit human choice beats the mode). Recorded per post.
ALTER TABLE posts ADD COLUMN publish_override text CHECK (publish_override IN ('operator'));
