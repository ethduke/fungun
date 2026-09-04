CREATE TABLE asset_challenges_v2 (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  image_hash TEXT NOT NULL,
  metadata_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'reserved', 'published', 'expired'))
);
INSERT INTO asset_challenges_v2 SELECT * FROM asset_challenges;
DROP TABLE asset_challenges;
ALTER TABLE asset_challenges_v2 RENAME TO asset_challenges;
CREATE INDEX idx_asset_challenges_expiry ON asset_challenges(state, expires);
UPDATE settings SET value = '2' WHERE name = 'asset-schema';
