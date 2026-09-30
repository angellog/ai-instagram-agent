-- "Create a post now" can carry a few words of operator direction (a product,
-- place, occasion or mood) that the content director must build the idea around.
ALTER TABLE create_runs ADD COLUMN direction text CHECK (direction IS NULL OR length(direction) <= 300);
