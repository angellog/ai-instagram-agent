-- Instagram Story updates: a story is a post with media_type STORY (one 1080x1920
-- image, no caption) planned by its own story planner. Create-now runs can make
-- either a feed post or a story.
ALTER TABLE posts DROP CONSTRAINT posts_media_type_check;
ALTER TABLE posts ADD CONSTRAINT posts_media_type_check CHECK (media_type IN ('IMAGE', 'CAROUSEL', 'STORY'));

ALTER TABLE content_ideas DROP CONSTRAINT content_ideas_format_check;
ALTER TABLE content_ideas ADD CONSTRAINT content_ideas_format_check CHECK (format IN ('single', 'carousel', 'story'));

ALTER TABLE create_runs ADD COLUMN kind text NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'story'));

CREATE INDEX posts_story_idx ON posts (influencer_id, created_at DESC) WHERE media_type = 'STORY';
