-- Reels and the business content library.
--  * A reel is a post with media_type REEL: one vertical video (post_assets.media_kind = 'video').
--  * library_items hold media a business uploads for its influencer: post it at a set time
--    ("scheduled") or let the influencer's content director pick the moment ("ai").

ALTER TABLE posts DROP CONSTRAINT posts_media_type_check;
ALTER TABLE posts ADD CONSTRAINT posts_media_type_check CHECK (media_type IN ('IMAGE', 'CAROUSEL', 'STORY', 'REEL'));

ALTER TABLE content_ideas DROP CONSTRAINT content_ideas_format_check;
ALTER TABLE content_ideas ADD CONSTRAINT content_ideas_format_check CHECK (format IN ('single', 'carousel', 'story', 'reel'));

ALTER TABLE create_runs DROP CONSTRAINT IF EXISTS create_runs_kind_check;
ALTER TABLE create_runs ADD CONSTRAINT create_runs_kind_check CHECK (kind IN ('post', 'story', 'reel'));

ALTER TABLE post_assets ADD COLUMN media_kind text NOT NULL DEFAULT 'image' CHECK (media_kind IN ('image', 'video'));
ALTER TABLE post_assets ADD COLUMN duration_s numeric;

CREATE TABLE library_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id  bigint NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  -- What it is and anything the caption must say (or must not).
  notes          text NOT NULL DEFAULT '' CHECK (length(notes) <= 1500),
  kind           text NOT NULL CHECK (kind IN ('image', 'video')),
  -- [{url, mime, width, height, duration_s, bytes}] in upload order.
  files          jsonb NOT NULL DEFAULT '[]',
  mode           text NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'scheduled')),
  scheduled_for  timestamptz,
  -- How it goes out: feed (single/carousel), story, or reel (videos).
  target         text NOT NULL DEFAULT 'auto' CHECK (target IN ('auto', 'feed', 'story', 'reel')),
  -- Screen recordings and b-roll that AI reels may cut into (not posted on their own).
  reel_material  boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'planned', 'posted', 'failed', 'archived')),
  post_id        uuid REFERENCES posts(id) ON DELETE SET NULL,
  last_error     text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (mode <> 'scheduled' OR scheduled_for IS NOT NULL)
);
CREATE INDEX library_items_influencer_idx ON library_items (influencer_id, status, created_at DESC);

ALTER TABLE posts ADD COLUMN library_item_id uuid REFERENCES library_items(id) ON DELETE SET NULL;

ALTER TABLE posts DROP CONSTRAINT posts_origin_check;
ALTER TABLE posts ADD CONSTRAINT posts_origin_check CHECK (origin IN ('scheduled', 'operator', 'library'));

-- Reels animate a photo into a short clip. Policies predate video, so nobody chose to
-- exclude it: allow image→video by default (Controls → Reels and the routing policy can turn it off).
ALTER TABLE generation_policies ALTER COLUMN allowed_modalities SET DEFAULT '{text_to_image,image_edit,reference_image,upscale,image_to_video}';
UPDATE generation_policies SET allowed_modalities = array_append(allowed_modalities, 'image_to_video')
 WHERE NOT ('image_to_video' = ANY (allowed_modalities));
