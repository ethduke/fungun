# Offline asset backups

This tool exports a consistent SQLite database and its content files. It does not
configure cloud storage, encrypt files, schedule backups or activate restored
stores. Uploads remain disabled until deployment and recovery checks pass.

## Runbook

Configure only these fields in the ignored local environment, or supply them to
the dedicated snapshot process on the asset Machine:

| Variable | Meaning |
| --- | --- |
| `ASSET_STORE_ROOT` | Existing private asset store |
| `ASSET_BACKUP_ROOT` | New export directory, or existing export for verification |
| `ASSET_BACKUP_SHA256` | Manifest digest recorded independently when exporting |
| `ASSET_RESTORE_ROOT` | New directory for a quarantined restore |

Use absolute, symlink-free paths outside repositories. Existing parent directories
must be private (0700). The tool creates 0700 directories and 0600 files. Production
also requires the pinned asset Machine identity and dedicated asset volume.
No wallet keys, RPC URLs or provider credentials enter the snapshot child process.

1. Run `npm run assets:snapshot -- backup` for a read-only check. Stop the asset
   service and keep it stopped throughout export; a database lock alone cannot
   freeze filesystem writes.
2. Run `npm run assets:snapshot -- backup --execute --service-stopped`. The target
   must not exist. Record the returned `manifestSha256` independently, then set
   `ASSET_BACKUP_SHA256` for subsequent commands.
3. Run `npm run assets:snapshot -- verify`. Transfer the complete directory through
   an encrypted channel to private, independently durable storage and verify there
   too. The digest must come from the independent record, not from the copy being
   verified.
4. Run `npm run assets:snapshot -- restore` to check a new restore target, then
   `npm run assets:snapshot -- restore --execute --service-stopped` to copy it.
   This never overwrites the live volume. Inspect the restored state offline.

Inside the asset image, use `node src/asset-snapshot-cli.mjs` with the same arguments
instead of the npm wrapper. Do not expose these commands as HTTP endpoints.

## Interrupted publication

When both approved final files were written but publication was not committed,
run `npm run assets:snapshot -- recover-complete` to inspect eligible reservations.
It requires a verified backup whose complete logical database state and object
inventory still match the source. Keep the service stopped between backup and
recovery. Then use `recover-complete --execute --service-stopped` to finalize only
eligible reservations. No wallet is signed and no RPC request or transaction is made.

Recovery verifies the exact approved image/metadata hashes, sizes, WebP header and
canonical metadata, syncs the files and directory, then atomically registers the
objects and marks the reserved approval published. It does not reset counters,
release reserved bytes, alter owners, regenerate missing bytes or promote pending
or expired approvals. A reservation that expired after its original publication
started can still finish; it already crossed the signed-and-charged boundary.

Missing, corrupt or temporary-only bundles stay locked and charged. Unsafe links,
FIFOs, conflicting registered objects and stale backups refuse the operation.
After a successful change the old backup is intentionally stale; take a fresh
backup before another recovery attempt. A new attempt finds no already-completed
work to repeat. The browser can resolve a recovered publication through its
existing read-only status check. Storage receipts still say `launchReady: false`.

## Safety boundaries

- Exports include quota counters, owner-HMAC material, reservations, pinned origins
  and committed WAL data. Treat the entire backup as confidential. It contains no
  wallet signature records, but it is not safe for a public bucket or Git.
- Committed files must match their database sizes, hashes and canonical metadata.
  Bounded partial/temporary regular files are preserved as evidence, not published.
  Missing committed files, links, FIFOs, unknown names and oversize stores fail closed.
- Database size is capped at 16 MiB, source WAL at 32 MiB, objects at 12,288 files /
  256 MiB, and manifests at 3 MiB. Operations retain at least 256 MiB target headroom.
  Limits are checked before expensive scans. Exhaustion requires operator review,
  never silently dropping data or resetting quotas.
- An incomplete export has no completion manifest. Leave it isolated for inspection;
  reruns require a different new directory. No automatic cleanup or overwrite occurs.
- Every exported database is quarantined before it receives the runtime filename.
  Runtime startup, expiry, migration, recovery and re-export all reject quarantined stores.
  There is deliberately no unlock flag. Reconciliation with all post-backup
  publications/counters and a reviewed activation procedure are still required.
- Production rejects same-filesystem exports. A different filesystem alone does
  not prove an independent failure domain. Choose encrypted offsite retention and
  perform a restore drill before tokens depend on these URLs. Fly snapshots may
  supplement this workflow; they do not configure independent exports for us.

Sources: [SQLite online backup](https://www.sqlite.org/backup.html),
[Node SQLite backup](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options),
[Fly volume snapshots](https://fly.io/docs/volumes/snapshots/).
