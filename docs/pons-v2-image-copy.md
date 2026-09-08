# Pons v2 image COPY

Pons v2 tokens expose their artwork through `getTokenInfo()` on the token
contract. The second return value, `tokenLogo`, is an image URI. This differs
from the Doppler `tokenURI()` metadata path. The API now supports
`{ chainId: 4663, address, provider: "pons-v2" }` on `/api/token-image` and its
backend `/v1/token-image` route.

COPY recognizes the feed's `pons-v2` label, plus case/spacing variants such as
`Pons V2`. It fills the name and ticker immediately and loads the image through
the existing asynchronous draft flow. Later COPY, upload, removal or generation
invalidates pending image requests. Unsupported artwork leaves text COPY usable.

## Supported artwork

- Root IPFS image CIDs, using the existing approved gateways and CID validation.
- Static raster files at `https://axiomtrading-v2.axiom-cdn.io/<filename>`.
- Profile images at `https://pbs.twimg.com/profile_images/<id>/<filename>`.

HTTPS paths are strictly validated; credentials, custom ports, query strings,
fragments, path traversal and arbitrary hosts are rejected. HTTPS redirects are
not followed. Pons logos must decode directly as supported images; they do not
follow a second JSON metadata document. Other HTTPS hosts are not supported yet.
The O1 and Doppler providers retain their existing URL policies.

The shared resolver enforces upstream admission/budgets, an 18-second overall
deadline, four seconds per HTTP attempt, 2 MiB image input, and a maximum of
4096 pixels per side. The isolated launch decoder rejects invalid/animated
images and returns validated WebP. Token lookups and HTTPS content have a
one-minute cache; immutable IPFS results retain the one-hour cache. Identical
pending lookups are deduplicated. No new credential or launch toggle is needed;
`READ_UPSTREAMS` and the configured Robinhood RPC are required.

## Investigation and verification

Read-only `cast call` checks on chain 4663 verified the following two tokens from
the actual COPY feed. Both were registered in the locally reviewed Pons v2
factory. Their `tokenURI()` reads failed, while `getTokenInfo()` returned artwork.

| Token | On-chain logo host | Original format / bytes | Dimensions | Validated COPY bytes |
| --- | --- | --- | --- | --- |
| NVIDIA Compute | Axiom image CDN | WebP / 7,860 | 246 × 238 | WebP / 9,812 |
| The Mutual Fun | Twitter profile CDN | JPEG / 20,729 | 400 × 400 | WebP / 11,932 |

The implemented provider completed these reads and decodes in approximately
0.80 and 0.37 seconds respectively. This small sample is not a latency benchmark
or a claim of complete Pons coverage. Older Pons tokens were investigated
separately; the feature's automatic dispatch targets the v2 feed label.

Automated checks cover both CDN hosts, IPFS, malformed/oversized images, unsafe
URLs and redirects, expiry, disabled reads, unsupported chains, source identity,
client cancellation, and the real browser-proxy-to-API path with mocked upstream
responses. The full suite passed 791 tests, plus type checking, lint and the
standalone production build. No transaction was sent.

Source: [Pons v2 token metadata reference](https://docs.ponsfamily.com/v2).
Exact live addresses, original logo URLs and factory-check results are kept in
ignored `local/pons-image-copy/v2-research.json` and `smoke-results.json`.
