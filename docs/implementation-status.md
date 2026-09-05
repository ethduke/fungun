# Implementation status

Snapshot: 2026-09-04. This separates implemented code from production readiness.
Fee reads/claims are owned by a separate task and are not assessed here.

Storage direction updated: **managed IPFS for new public assets; Fly for the app
and private records**. The historical Fly asset/recovery implementation below stays
intact but is no longer the selected destination for new uploads. See
[managed-ipfs.md](managed-ipfs.md) for current integration gates.

| Step | Status | Implemented | Remaining |
| --- | --- | --- | --- |
| 1. Live data | Partial | Server-only environment allowlists; bounded/cached read service; O1 catalogs; Long ticker checks | Complete contract/pairing verification and O1 ticker checks; fee coverage tracked separately |
| 2. Image and metadata storage | In progress | Content validation; isolated decoder; historical Fly recovery; deterministic Long IPFS CIDs; guarded Pinata transport; durable per-object journal; no-retry worker; versioned wallet approval and inline progress/recovery | Server-only provider setup; live disposable pin/retrieval and new Long display checks; private-record backups |
| 3. Launch preparation | Partial | Ordinary Long verifies a published IPFS receipt, pinned contracts and oracle freshness, then simulates and returns a bounded unsigned transaction with ETH/USD review totals | Disposable live verification with production settings; O1 builder |
| 4. Wallet execution | Partial | Ordinary Long has explicit wallet approval, durable one-attempt reservation, transaction identity and canonical receipt/state checks; it is disabled by default | Real Rabby/MetaMask tests and production enablement review; O1 execution |
| 5. Paid Grok | Partial | System prompt builder and editable ticker-populated prompt | One-time payment approval, spend limits, paid generation and output validation |
| 6. Release | Next | Automated unit/abuse checks, source safety checks and local container checks | Real Rabby/MetaMask tests; final history scan; dedicated Fly deployment; domain/DNS verification |

## Current completed submilestone

Step 2 browser integration: same-origin bounded upload proxy, processed preview,
exact wallet publication approval and read-only recovery after an uncertain
response. Generated test fixtures exercise changed-wallet/chain/content guards,
duplicate clicks, content/message substitution, rate limiting, malformed response
handling and recovery privacy. No real wallet was signed and no transaction sent.

Expired-pending recovery now has an explicit schema migration and read-only-by-
default maintenance command. Only a permanent ID/hash-bound expiry receipt
unlocks the browser; pending, reserved and unknown results remain blocked.
Tests cover signature races, expiry boundaries, clock rollback, restart,
unchanged quotas/files and bounded retained history. No real store was migrated.

Offline backup now uses SQLite's live backup API behind an explicit stopped-service
write fence, validates every committed object and preserves bounded interrupted-
write evidence. Verification requires a separately recorded manifest SHA-256.
Restore creates a new quarantined store and cannot overwrite or start as the live
service; no activation bypass exists. The tool is recovery plumbing, not an
independent backup until an encrypted destination and restore drill are configured.

Complete-write reservation recovery now validates the exact approved final files
against a fresh verified backup before an offline, atomic publication repair.
Counters, owners, hashes and reserved bytes are preserved; pending/expired approvals
and incomplete/corrupt bundles are not promoted. Tests use synthetic wallets and
interrupted local writes only. No real store was recovered or deployed.

Restore reconciliation compares the stopped original, verified backup and locked
restore without changing any state or allowing activation. Dedicated Fly identities
and an atomic, restart-safe cutover protocol are still required. B2 is recommended
for independent encrypted backups; no account, bucket or retention is configured.

Fly decoder startup accepts the exact validated platform private-IP field without
exempting credential-like variables. A separate target-host diagnostic reports
runtime hardening as booleans and always leaves network/publication readiness
unverified. Actual dedicated Machines do not exist yet; local checks are not Fly
deployment evidence. Fees and unrelated branding changes remain outside this work.

Publication stays disabled by default. Storage receipts explicitly carry
`launchReady: false`; a stored image is not proof that a token is safe to launch.
See [launch-assets.md](launch-assets.md) and [fly-assets.md](fly-assets.md).

Ordinary Long wallet execution is implemented behind four API-only settings and
remains disabled by default. Preparation reuses the private asset-status service,
checks a single fresh chain snapshot, simulates with the connected wallet and returns
unsigned bytes. A durable reservation precedes the one wallet submission; status
binds the caller's hash to the journaled transaction through terminal results and
verifies 12 confirmations, the launch event and deployed state. No live transaction
was sent for this implementation milestone. See [long-wallet-launch.md](long-wallet-launch.md).

## Next implementation boundary

Verify managed IPFS publication and the ordinary Long path with disposable production
configuration and real Rabby/MetaMask sessions before enabling it. Preserve existing
Fly records; do not activate a quarantined restore or discard old files as part of
this change. B2 asset-backup provisioning is no longer a gate for the new IPFS path.
Do not use the Telegram bot's runtime, secrets or volume for this service.
