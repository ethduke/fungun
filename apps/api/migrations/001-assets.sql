CREATE TABLE asset_challenges (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  image_hash TEXT NOT NULL,
  metadata_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'reserved', 'published'))
);
CREATE INDEX idx_asset_challenges_expiry ON asset_challenges(state, expires);
CREATE TABLE asset_objects (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL CHECK(bytes > 0));
