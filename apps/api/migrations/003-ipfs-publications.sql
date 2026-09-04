CREATE TABLE ipfs_publications (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, draft TEXT NOT NULL,
  profile TEXT NOT NULL, schema_name TEXT NOT NULL,
  image_cid TEXT NOT NULL, metadata_cid TEXT NOT NULL,
  image_hash TEXT NOT NULL, metadata_hash TEXT NOT NULL,
  image_size INTEGER NOT NULL, metadata_size INTEGER NOT NULL,
  created INTEGER NOT NULL, expires INTEGER NOT NULL, approved INTEGER,
  state TEXT NOT NULL CHECK(state IN ('pending','reserved','published','expired')),
  next_check INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE UNIQUE INDEX idx_ipfs_active_owner ON ipfs_publications(owner)
  WHERE state IN ('pending','reserved');
CREATE INDEX idx_ipfs_work ON ipfs_publications(state,next_check);
CREATE TABLE ipfs_objects (
  publication_id TEXT NOT NULL REFERENCES ipfs_publications(id),
  kind TEXT NOT NULL CHECK(kind IN ('image','metadata')),
  state TEXT NOT NULL CHECK(state IN ('staging','ready','sending','pinned','verified')),
  provider_id TEXT, verified_at INTEGER,
  PRIMARY KEY(publication_id,kind)
);
INSERT INTO settings VALUES ('ipfs-schema','1');
INSERT INTO settings VALUES ('ipfs-app-origin','');
INSERT INTO settings VALUES ('ipfs-gateway','');
PRAGMA optimize;
