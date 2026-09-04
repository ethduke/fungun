# Launch image and metadata boundary

The image pipeline and a separate Fly asset service are implemented. Publication
is disabled by default and is not yet wired to the webview. Picking a file still
keeps it in the browser; it does not publish anything or send it to a model.

## Image processing

`LaunchImageProcessor` accepts bytes only, not filenames, URLs or decoder options.
PNG, JPEG, WebP and still GIF are identified from their contents. Files must be
nonempty, at most 2 MiB and at most 4096 pixels on each side. The decoder must
finish before output is accepted; plausible headers are insufficient.

Sharp is pinned to 0.35.4. A short-lived child process receives no inherited
environment, credentials or shell. It processes one image with a disabled native
cache, one native worker thread, a three-second processing limit and a six-second
parent-enforced deadline. Only one conversion per processor is admitted; there
is no pending queue. Raw decoder diagnostics are discarded. Use one shared
processor instance when wiring the service.

Synthetic PNG/JPEG/WebP/still-GIF conversion and malformed-input rejection passed
in the API image on Linux AMD64, with a non-root user, a read-only filesystem,
no network, no credentials, dropped capabilities and a 256 MiB container limit.
These were local disposable-container checks, not a Fly deployment.

The output is WebP with orientation applied and embedded metadata removed. It
must remain under 2 MiB. Animated GIF/WebP and APNG are explicitly rejected for
this first publication profile; previews remain unchanged. No silent flattening,
cropping, resizing or AI image generation occurs. The transformed image must be
shown before the user approves its publication.

The child-process boundary and V8 heap limit are not a native-code sandbox or a
hard native-memory limit. `apps/decoder/Dockerfile` now packages a separate,
Sharp-only Alpine runtime with distro Node. The build rejects non-PIE Node or an
executable stack. Startup also requires nonroot, ASLR, nonwritable source, no
asset-volume path and no recognized credential environment variables. This is
defense in depth, not proof of arbitrary-code containment. The actual Fly runtime
must pass the isolation and resource gates in [fly-assets.md](fly-assets.md).

## Metadata

`buildLongMetadata` emits canonical UTF-8 JSON containing only `name`, `symbol`,
`description` and the published `image` reference. It rejects extra fields,
control characters, unsupported tickers and overlong text. Descriptions follow
the webview's 2,000-byte UTF-8 limit. The resulting bytes receive a SHA-256 digest.

Image references are restricted to supported SHA-256 IPFS content IDs, or an
exact server-configured HTTPS origin and hash-based `/launch-assets/` path.
URI syntax validation is not proof of successful publication or availability.
The publication adapter must verify the retrieved bytes against the approved
image and metadata before returning a transaction-ready URI. No arbitrary URL
fetcher or mutable user-supplied metadata URL is provided.

Doppler recommends IPFS metadata and images. Its indexer also documents HTTPS
retrieval, but this does not establish Long's current frontend/listing behavior.
Long's own metadata display remains an integration gate. Do not copy Longbow's
allocation or category fields into ordinary Long metadata.

## Publication gates

- Fly-hosted assets are selected. Verify an isolated decoder, a dedicated durable
  volume, independent backups and recovery before enabling public publication.
- The service verifies an EOA signature over the exact processed-image and
  metadata hashes, byte count, wallet, chain, origins, nonce and five-minute expiry.
  This is local signature recovery, not a transaction or RPC request. Contract
  wallets are not yet supported by this publication-intent profile.
- Persisted quotas and write-once publication are implemented. Expensive decoding
  is capped separately from public egress and the read service's RPC budget.
- Keep original filenames, images, metadata, wallet/signature data and provider
  responses out of logs, build context and source history.
- Only then connect browser upload, approved-image preview, publication and the
  unsigned launch builder. Published responses currently have `launchReady: false`;
  storage success alone does not establish backup durability or launch readiness.

## Dedicated asset service

`asset-server.mjs` listens on port 8790. It must run in a **different Fly app** from
the RPC service and the decoder. It needs no API key, wallet key or RPC URL. Use
`node scripts/start-assets.mjs` locally: the launcher forwards only asset-specific
configuration, never arbitrary `.env` values or `NODE_OPTIONS`.

Initialize a new private directory outside Git using the explicit
`node scripts/start-assets.mjs --initialize-new-volume` command. Set
`ASSET_STORE_ROOT` to that absolute, mode-0700 directory first. Initialization
refuses an existing store; normal startup never recreates lost quota state.
Production requires the dedicated disk-backed `/data` mount, root
`/data/launch-assets`, and `ASSETS_MACHINE_ID` matching the current Fly Machine.
Do not copy another service's SQLite database or volume into this app.

Required configuration: `APP_ORIGIN`, `ASSET_PUBLIC_ORIGIN`, `ASSET_STORE_ROOT`,
and production Machine identity. Origins are pinned on first open and cannot be
silently changed. The asset origin must be HTTPS. `ASSET_UPLOADS=false` keeps all
publication routes disabled; enabling them also requires a private
`ASSET_DECODER_ORIGIN` shaped as `http://<decoder-app>.internal:8791`.

The HTTP contract is deliberately narrow:

- `POST /v1/asset-prepare`: exact `chainId` (4663), `wallet`, `draft`
  (`name`, `ticker`, `description`) and canonical `imageBase64`. Decodes in the
  isolated worker and returns processed bytes and an expiring approval message.
  Preparation keeps image bytes in memory, not on disk.
- `POST /v1/asset-publish`: the same **processed** image and normalized draft,
  plus challenge `id` and the wallet's `signature`. Browser approval must follow
  the processed preview. Neither route accepts filenames, URLs or decoder options.
- Both POST routes require the exact configured Origin, JSON content type and
  `x-fungun-intent` matching `asset-prepare` or `asset-publish`. These headers are
  CSRF checks, not authentication or protection against non-browser clients.
- `GET`/`HEAD /launch-assets/<sha256>.webp|json`: committed objects only, checked
  against their content address, with immutable caching, ETag and safe MIME types.
  No directory listing or generic filesystem handler exists.

Only one preparation and one publication can execute concurrently. Ingress is
capped at 8 active requests, 30/minute per socket IP and 300/minute globally;
forwarded IP headers cannot buy extra quota. Behind a proxy, callers may share
that socket-IP allowance. Images are at most 2 MiB; JSON and streamed output are
bounded. Preparation is capped at 6/minute and 60/day globally. Publication is
limited to 30/day globally and 3/day per verified wallet. Public GET egress is
charged in 128 KiB units with a 256 MiB/hour origin allowance. These are initial
small-beta caps, not a guarantee against denial of service. Wallets are cheap to
generate; real public admission needs a reviewed abuse policy.

The lifetime reservation ceiling is 256 MiB with at least 256 MiB disk headroom.
Reservations cover both files before any write and survive failures/restarts.
New files use exclusive temporary files, fsync and no-overwrite hard links;
reused objects are verified and synced. Only a completed SQLite record permits
public reads. Exact successful retries return the same URLs without another
charge. Interrupted reservations remain charged and blocked; do not reset the
database, delete orphan files or approve another upload to work around them.
Publication attempt quotas can remain charged if later reservation checks fail.
An operator recovery/status workflow is still required before broad rollout.

Fly volumes are not automatically shared between Machines. Keep this store
single-writer and separately backed up; adding another Machine with an empty
volume is not replication. Restore tests must preserve database, objects and
pinned origins together. Publicly published content is public by design; hashes
are not access control. Private keys and signatures are never stored alongside it.

References: [Sharp security](https://sharp.pixelplumbing.com/security/),
[input limits](https://sharp.pixelplumbing.com/api-constructor/),
[output and timeout behavior](https://sharp.pixelplumbing.com/api-output/),
[Doppler metadata](https://docs.doppler.lol/resources/metadata-standards),
[Doppler indexer](https://docs.doppler.lol/indexer/overview).
