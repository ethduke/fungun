# Managed IPFS launch assets

Selected architecture: managed public IPFS for coin artwork and metadata; Fly for
the application and a small private database. This replaces the planned Fly-volume
asset destination for new launches, not the existing records or their recovery
rules. B2 asset backups and immutable backup retention are not prerequisites for
this IPFS path. Private operational records still need a backup/recovery procedure.

## Launchpad boundaries

- Long / Robinhood: a read-only check of an existing token on 2026-09-04 found an
  IPFS `tokenURI`, an IPFS `image_hash`, and a rendered picture on Long's token page.
  The new isolated `long-ipfs-v1` JSON includes `name`, `symbol`, `description`,
  `image`, and `image_hash`, with both image fields pointing to the same CID.
  This is not a new-launch acceptance test or proof of every optional Long field.
- O1 / Base and Robinhood: use the official launch-preparation API. It accepts
  image bytes and pins the image plus ERC-7572 metadata itself. Store its returned
  metadata/image URIs. Its initial-launch request does not document accepting a
  caller's preuploaded metadata URI. O1 resolves IPFS through an account-restricted
  Pinata gateway: a pin in our account alone does not make an avatar visible there.

### O1 gateway compatibility fix (2026-09-06)

O1 preparation now sends the already-approved WebP bytes to the official
`POST /v1/launches/prepare` endpoint. A separate durable journal commits the exact
request binding and an idempotency key before the call, saves the returned URIs,
and reuses them across gas refreshes and process restarts. A timeout or otherwise
ambiguous call retries only the same key and payload. An exact provider `409
stale_plan` response is definitive rather than ambiguous and permits one durable
compare-and-swap rotation to a new key for the unchanged request; concurrent callers
reload the winner. No other response rotates a key. Each provider attempt debits 20
O1 units before the request, including the single permitted stale-plan retry.

The O1 document has `name`, `symbol`, `description`, `standard: ERC20`,
`launchpad: o1 Launchpad`, `launchpadUrl`, and the approved image URI. Both server
and browser independently derive its CID. The server also checks the metadata
and image bytes through O1's returned gateway before constructing a launch.
O1's returned launch transaction is not dispatched; the existing independent
builder, simulation, fee limits, wallet signing and recovery still apply.

The original shared publication remains the wallet-approved source of image
bytes, and its schema is unchanged. Keeping that publication and adding O1's
native pin is an intentional compatibility step for the existing launch flow;
it preserves other launchpads and old approvals. Only O1 uses this additional
pinning service. A future native-only upload flow must preserve those bindings.

Existing tokens need a creator-authorized contract-URI update using O1's
`metadata/document/prepare` endpoint with the same image bytes. Preparing it
publishes files and returns an unsigned transaction; it does not send a transaction.

The old Fly metadata builder is unchanged. Changing its serialization would change
hashes and invalidate existing approvals and recovery checks. No private addresses,
fees, allocations, signatures or filenames are copied into the new public JSON.

## Implemented foundation

`prepareLongIpfsAssets` takes already-validated, processed WebP bytes and normalized
coin details. It calculates both CIDs locally, without network access or disk writes,
so the future wallet approval can bind the exact output before publication.

The pinned UnixFS importer uses CIDv1, SHA-256, raw leaves, 256 KiB chunks, balanced
174-link nodes and no directory/mode/mtime metadata. This matches Pinata's `v1`
profile. These are UnixFS CIDs, not simply the SHA-256 of a multi-chunk file.
Buffers are copied before asynchronous hashing; publication must revalidate them.
The result remains `launchReady: false` and does not authorize an upload.

`PinataPublisher` is an isolated transport, disabled by default and not connected
to any HTTP route until runtime setup is explicit. It supports one bounded public file upload,
read-only lookup of an acknowledged account file ID, and exact-byte gateway
verification. Uploads recheck the expected CID and use generated hash filenames.
Gateway requests carry no JWT, cookies or user headers. Provider redirects, changed
bytes/CIDs, oversized responses and timeouts fail closed with redacted messages.
It never retries an upload, deletes a pin, queries a wallet or submits a transaction.

The separate IPFS journal records exact CIDs, hashes, byte lengths, importer/schema
versions, an HMAC owner reference and per-object progress. It stores validated bytes
in private staging only after wallet approval and before provider access. It does not
store the wallet address, approval message or signature. The worker commits a
`sending` state before each POST. A lost acknowledgment is reconciled with one
bounded account lookup by CID; absence or ambiguity never permits another upload.

Successful upload acknowledgment, current account pin record and gateway content
verification are separate evidence. An upload timeout does not prove nothing was
stored. This transport alone cannot safely resume an unknown upload or enforce
durable quotas; do not expose it until the state/approval integration below exists.

## Provider setup

Use a dedicated Pinata account/project for public launch assets. Configure a
server-only publisher JWT and its public `*.mypinata.cloud` gateway hostname.
Keep the JWT in an ignored local environment or Fly secrets, never Git, browser
configuration, wallet messages or gateway URLs. No private wallet key is required.

Important: Pinata v3's `org:files:write` scope permits both upload and deletion.
A non-admin key is not a guaranteed upload-only key. Isolate it from the web/read
API, decoder and unrelated jobs; do not grant organization or gateway-management
rights. The application must not offer delete/unpin endpoints. Independent second
pinning can later protect against a compromised publisher or a provider outage.

Keep the gateway publicly readable for account-pinned content without secret query
tokens or a farmgun-only origin restriction: launchpad indexers need access too.
There is no required custom-domain or IPFS-node setup. Pin both files without an
expiration and maintain the provider account; a textual image link inside JSON
does not itself pin the image.

## Remaining integration

1. Configure `PINATA_JWT` and `PINATA_GATEWAY` only in the allowlisted asset
   runtime. The gateway value is a hostname, not a URL. The web route receives the
   public gateway hostname only; the JWT never enters its environment or response.
2. The Long webview independently calculates both CIDs, signs intent version 2,
   displays saved per-object progress and resumes by status without another
   signature or POST. O1 remains on its native preparation and pinning flow.
3. Verify account pin records and exact gateway bytes with approved disposable
   uploads, then verify new Long display and O1 preparation before enabling launches.

Gateway availability proves content retrieval, not account pin ownership or an
indefinite storage guarantee. Public uploads may remain on other nodes even after
the account unpins them. No provider account, key, upload or deployment
has been created by this implementation.

Sources: [Long](https://app.long.xyz/),
[Doppler metadata](https://docs.doppler.lol/resources/metadata-standards),
[O1 preparation](https://docs.o1.exchange/launchpad/api/launches),
[O1 interface](https://docs.o1.exchange/launchpad/architecture/frontend-indexer),
[Pinata profiles](https://docs.pinata.cloud/files/uploading-files),
[v3 upload scope](https://docs.pinata.cloud/api-reference/endpoint/upload-a-file),
[account file lookup](https://docs.pinata.cloud/api-reference/endpoint/get-file-by-id),
[v3 delete scope](https://docs.pinata.cloud/api-reference/endpoint/delete-file-by-id),
[IPFS persistence](https://docs.ipfs.tech/concepts/persistence/).
