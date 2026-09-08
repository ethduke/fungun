# Long / Doppler image COPY

COPY immediately fills the name and ticker, clears old artwork, and loads a new
image when available. Long, Longbow and other compatible EVM tokens are supported
on Robinhood (4663) and Base (8453), including rows with generic pool labels.
Recognized Robinhood O1 tokens continue to use the O1 provider and original route.
Pons v2 rows use their dedicated [tokenLogo provider](pons-v2-image-copy.md).
A missing or unsupported image leaves text COPY usable with an upload prompt.

## Resolution

The client posts `{ chainId, address, provider: "doppler" }` to `/api/token-image`.
The web proxy forwards to `/v1/token-image`, with the existing origin/intent checks
and request budgets. The generic route also accepts `provider: "o1"` on Robinhood;
`/api/o1-token-image` remains compatible with already-open O1 clients.

The API verifies the configured RPC chain (cached for five minutes), reads
`tokenURI()` on the token contract, and fetches its IPFS content. Supported raster
bytes are decoded directly. JSON uses `image`, falling back to `image_hash` when
invalid or unavailable. Nested metadata is not followed. Source identity remains
chain plus address, and external metadata cannot change the copied name/ticker.

Only root CIDv0/CIDv1 IPFS references with SHA-256 and raw/DAG-PB codecs are accepted.
HTTP URLs, IPNS, CID paths, SVG and video are not supported. The fixed gateways are
ipfs.io, gateway.pinata.cloud and the CID subdomain of ipfs.dweb.link. Redirects can
only reach another canonical gateway URL for the same CID; each URL is attempted
at most once per fetch. All attempts consume existing read budgets/admission.

Metadata has a 128 KiB limit; images have a 2 MiB input limit. Both limits apply to
streamed bodies regardless of headers. The existing isolated launch decoder
rejects invalid, animated or oversized images (maximum 4096 pixels per side) and
returns validated WebP. Each gateway attempt has a four-second timeout; the whole
resolver has an 18-second deadline. No API key is needed for the Doppler path.

Eight token results are cached for one minute because owners can update tokenURI.
Eight resolved immutable CID results are cached for one hour. Pending identical
requests are deduplicated. New COPY, upload, removal and generation invalidate
prior client requests; successful image Blobs use the existing persisted draft.

## Verification

`apps/api/src/token-image.test.mjs` exercises metadata formats, direct images,
CIDv0, unsafe URLs/redirects, gateway fallback, stream limits, real raster decode,
animated/dimension rejection, cache refresh, chain selection and upstream budgets.
`scripts/doppler-copy-integration.test.mjs` crosses the real web proxy and HTTP API
handler through a mocked RPC/gateway, including image processing and input checks.
Existing O1 integration and client identity/cancellation tests remain in place.

The initial investigation and live samples are documented in
[doppler-long-image-copy-investigation.md](doppler-long-image-copy-investigation.md).

The implemented resolver also passed read-only live checks for AUTSM, Artificial
Inu, AGI Frog and Chubb on 2026-09-07. All four returned validated WebP artwork;
observed request times were 0.26–1.12 seconds. Base routing is covered by automated
tests; these live smoke checks were on Robinhood.
