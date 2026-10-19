PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS chains (
  chain_id INTEGER PRIMARY KEY, name TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS blocks (
  chain_id INTEGER NOT NULL REFERENCES chains, hash TEXT NOT NULL,
  height INTEGER NOT NULL CHECK(height >= 0), parent_hash TEXT,
  timestamp INTEGER, expected_events INTEGER CHECK(expected_events >= 0),
  PRIMARY KEY(chain_id, hash), UNIQUE(chain_id, height, hash)
) STRICT;
CREATE TABLE IF NOT EXISTS canonical_blocks (
  chain_id INTEGER NOT NULL, height INTEGER NOT NULL, block_hash TEXT NOT NULL,
  PRIMARY KEY(chain_id, height), UNIQUE(chain_id, block_hash),
  FOREIGN KEY(chain_id, height, block_hash) REFERENCES blocks(chain_id, height, hash)
) STRICT;
CREATE TABLE IF NOT EXISTS tokens (
  chain_id INTEGER NOT NULL REFERENCES chains, address TEXT NOT NULL,
  symbol TEXT NOT NULL, decimals INTEGER NOT NULL CHECK(decimals BETWEEN 0 AND 36),
  PRIMARY KEY(chain_id, address)
) STRICT;
CREATE TABLE IF NOT EXISTS transactions (
  chain_id INTEGER NOT NULL, block_hash TEXT NOT NULL, tx_hash TEXT NOT NULL,
  tx_index INTEGER NOT NULL CHECK(tx_index >= 0), PRIMARY KEY(chain_id, block_hash, tx_hash),
  UNIQUE(chain_id, block_hash, tx_index),
  FOREIGN KEY(chain_id, block_hash) REFERENCES blocks(chain_id, hash)
) STRICT;
CREATE TABLE IF NOT EXISTS event_logs (
  chain_id INTEGER NOT NULL, block_hash TEXT NOT NULL, log_index INTEGER NOT NULL CHECK(log_index >= 0),
  tx_hash TEXT NOT NULL, token_address TEXT NOT NULL,
  PRIMARY KEY(chain_id, block_hash, log_index),
  FOREIGN KEY(chain_id, block_hash, tx_hash) REFERENCES transactions(chain_id, block_hash, tx_hash),
  FOREIGN KEY(chain_id, token_address) REFERENCES tokens(chain_id, address)
) STRICT;
CREATE TABLE IF NOT EXISTS transfers (
  chain_id INTEGER NOT NULL, block_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
  sender TEXT NOT NULL, recipient TEXT NOT NULL, amount_raw TEXT NOT NULL,
  CHECK(length(amount_raw) > 0 AND amount_raw NOT GLOB '*[^0-9]*'),
  PRIMARY KEY(chain_id, block_hash, log_index),
  FOREIGN KEY(chain_id, block_hash, log_index) REFERENCES event_logs(chain_id, block_hash, log_index)
) STRICT;
CREATE TABLE IF NOT EXISTS checkpoints (
  chain_id INTEGER PRIMARY KEY REFERENCES chains, start_height INTEGER NOT NULL,
  last_height INTEGER NOT NULL, anchor_hash TEXT NOT NULL,
  CHECK(start_height >= 1 AND last_height >= start_height - 1)
) STRICT;
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY, chain_id INTEGER NOT NULL REFERENCES chains,
  started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
  target_height INTEGER, blocks_written INTEGER NOT NULL DEFAULT 0,
  duplicates_ignored INTEGER NOT NULL DEFAULT 0, error_code TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS recoveries (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES ingestion_runs,
  chain_id INTEGER NOT NULL REFERENCES chains, reason TEXT NOT NULL,
  ancestor_height INTEGER NOT NULL, old_tip INTEGER NOT NULL, reverted_blocks INTEGER NOT NULL
) STRICT;
CREATE VIEW IF NOT EXISTS canonical_transfers AS
  SELECT c.chain_id, c.height, c.block_hash, e.log_index, e.token_address,
         t.sender, t.recipient, t.amount_raw
  FROM canonical_blocks c JOIN event_logs e USING(chain_id, block_hash)
  JOIN transfers t USING(chain_id, block_hash, log_index);
CREATE INDEX IF NOT EXISTS block_height ON blocks(chain_id, height);

-- Event-only observations do not invent timestamps or parents for unsampled blocks.
CREATE TABLE event_hours (
 chain_id INTEGER NOT NULL,block_hash TEXT NOT NULL,log_index INTEGER NOT NULL,hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
 PRIMARY KEY(chain_id,block_hash,log_index),FOREIGN KEY(chain_id,block_hash,log_index) REFERENCES event_logs
) STRICT;
CREATE TABLE live_batches (
 id INTEGER PRIMARY KEY,first_height INTEGER NOT NULL,last_height INTEGER NOT NULL,last_hash TEXT NOT NULL,
 verified_at TEXT NOT NULL,event_count INTEGER NOT NULL,query_duplicates INTEGER NOT NULL,recovered_omissions INTEGER NOT NULL,
 capture_digest TEXT NOT NULL,hour INTEGER NOT NULL,sampled_blocks INTEGER NOT NULL,UNIQUE(first_height,last_height)
) STRICT;
CREATE TABLE live_checks (id INTEGER PRIMARY KEY,checked_at TEXT NOT NULL,status TEXT NOT NULL,checkpoint INTEGER NOT NULL,code TEXT) STRICT;
CREATE TABLE snapshot_metadata (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL) STRICT;
