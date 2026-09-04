# Fly asset rollout

Two separate app templates are ready, but no apps, volumes, public IPs, DNS records
or secrets have been created by this milestone. `ASSET_UPLOADS=false` remains the
default. Do not repurpose the Telegram bot or read-service app.

## Runtime separation

- `fly.assets.toml`: one 512 MiB Machine, port 8790, its own `launch_assets`
  volume mounted at `/data`. Only this process may write published assets.
- `fly.decoder.toml`: one 512 MiB Machine, port 8791 on private IPv6 only. No
  public service, Flycast, volume or application secrets. Its exact peer ACL uses
  the asset Machine's canonical 6PN address, never forwarding headers.
- `apps/decoder/Dockerfile`: pinned Alpine 3.24.1 base, distro Node 24.18.1-r0,
  Sharp 0.35.4 and a separate dependency lock. No API or wallet dependency tree.
  The asset-service image does not contain the native image worker or RPC code.

The decoder receives image bytes only. Wallet addresses, signatures, metadata,
provider keys and the persistent volume never enter its request or container.
An allowlisted peer is not network sandboxing. The current app-level `.internal`
destination also requires exactly one reviewed decoder Machine; inspect its image
digest and effective configuration after every replacement or scale operation.

## Local verification

Both final Linux AMD64 images build. The Fly templates validate using placeholder
app identities. The decoder's private HTTP tests cover peer spoofing, strict MIME
and method checks, chunked overflow, concurrent admission, failure recovery and
PIE/stack validation using generated fixtures only.

Run `apps/decoder/verify-runtime.mjs` mounted read-only at
`/service/verify-runtime.mjs` in the final decoder image, with no network,
read-only root filesystem, all capabilities dropped, no-new-privileges, 512 MiB
memory/swap ceiling, one CPU and 64 PIDs. It checks actual executable hardening,
ASLR, nonroot, source permissions, cgroup memory and four synthetic image formats.
The 4096-pixel case reports success or an enforced timeout separately; a timeout
does not prove successful conversion or target-host performance. No input files
or decoder output belong in Git or the Docker context.

Recorded local result: PNG, JPEG, WebP and still GIF converted successfully under
those restrictions. PIE/ASLR, nonroot, read-only source, zero capabilities and the
memory ceiling passed. The 4096-pixel input reached its enforced timeout under
AMD64 emulation on the local ARM host; it was rejected safely. Full-size target
Fly performance is not verified.

## Before enabling publication

1. Create dedicated apps and a new persistent asset volume. Initialize its private
   directory as the asset runtime UID using the explicit initializer. Supply the
   exact HTTPS web/asset origins and pin the asset Machine identity. Do not restart
   with a fresh database to repair missing storage or exhausted quotas.
2. Inspect effective Machine configuration and secret **names**, without dumping
   values. Confirm decoder command, image digest, nonroot identity, readonly source,
   memory/CPU limits and absence of volume, public/Flycast services and credentials.
   Pin `DECODER_ALLOWED_CLIENT` to the asset Machine's 6PN IP; update deliberately
   after Machine replacement. Verify another private peer is rejected.
3. Apply and verify outbound network isolation on the real decoder Machine. Prove
   outbound IPv4, IPv6, DNS and unnecessary private-network connections are blocked
   while the approved request/response still works. Do not assume an empty rule
   list means deny-all; the needed policy semantics must be verified on Fly.
4. Verify still-image conversion, maximum-size input, malformed/animated input,
   timeouts, disconnect recovery and native-memory pressure on the target host.
   Confirm failures cannot publish files or access RPC/provider configuration.
5. Configure independent backup and test a full restore before launching tokens.
   Use a consistent SQLite backup/snapshot procedure, not a live copy of the main
   database without its WAL. Preserve content objects, quota state, owner-HMAC key,
   reservations and pinned origins together. Keep backup permissions private; a
   second directory on the same volume is not an independent backup. Establish
   a maintenance window or reconciliation procedure so restored quotas cannot
   silently refund post-backup publications.
   The offline `npm run assets:snapshot -- backup` tool performs a dry run by
   default; writes additionally require `--execute --service-stopped`. It writes
   only to a new private directory and prints a manifest SHA-256 that must be
   recorded separately. `verify` requires that digest. `restore --execute
   --service-stopped` copies into another new directory that remains quarantined;
   the HTTP runtime and write maintenance refuse it. There is intentionally no
   activation command until post-backup state reconciliation is implemented.
6. Verify public HTTPS hash URLs return the approved bytes, including through the
   Long indexer/frontend. Confirm immutable cache headers and refusal to serve
   partial writes. Test storage-full and missing-volume failures.
7. Verify the implemented inline processed-image preview, explicit wallet
   publication approval and read-only recovery check against the real deployment.
   Verify offline expired-pending recovery; add reserved/partial-write recovery
   and a reviewed public-abuse admission
   policy before broad access. Neither wallet generation nor Origin checks stop
   automated upload abuse. Keep publication and launch readiness separately gated.

Backups and uploads are not automatically enabled by the templates. A same-disk
local export is useful for testing but is not independent protection. Fly volume
snapshots restore to a new volume and can supplement—not replace—an encrypted,
offsite export and periodic restore drill. See the
[SQLite backup API](https://www.sqlite.org/backup.html),
[Node backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options)
and [Fly volume snapshots](https://fly.io/docs/volumes/snapshots/). The final
backup destination and target-host checks are still outstanding. Do not release
permanent token metadata that depends on an untested single-volume recovery path.

References: [Sharp security and resource limits](https://sharp.pixelplumbing.com/security/),
[Alpine releases](https://alpinelinux.org/releases/),
[Fly network-policy scope](https://fly.io/docs/machines/guides-examples/network-policies/),
[Fly volume overview](https://fly.io/docs/volumes/overview/).
