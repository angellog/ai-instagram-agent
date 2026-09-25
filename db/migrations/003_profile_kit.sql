-- Profile kit: copy-paste Instagram profile text and profile pictures made from
-- the soul (Instagram's API cannot edit bio, name or profile photo).
ALTER TABLE influencers ADD COLUMN profile_kit jsonb NOT NULL DEFAULT '{}';
