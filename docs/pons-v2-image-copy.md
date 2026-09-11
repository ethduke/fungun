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

- Root IPFS image CIDs through the approved gateways.
- Image URLs on any public HTTPS host, including query strings and extensionless
  paths. Catbox, Axiom, Twitter and other hosts use the same downloader; neither
  token addresses nor hostnames are allowlisted.
- Up to three HTTPS redirects, with a fresh public-address check at every hop.

The browser sends only the token address, chain and provider. The server obtains
`tokenLogo` from the contract, rejects credentials and nonstandard ports, checks
all DNS answers, and pins the connection to a verified public IP. HTTP Host and
TLS certificate verification retain the original hostname. Private, loopback,
link-local, reserved, mapped/transition IPv6 and internal-network targets are
blocked, including after redirects. Requests send no cookies or credentials.

The shared resolver retains admission/budgets, an 18-second overall deadline,
a four-second limit per HTTPS hop including DNS, 2 MiB image input, and 4096
pixels per side. The isolated decoder rejects invalid/animated images and
returns WebP. Content must decode as a raster image, regardless of extension
or Content-Type. HTTPS content and token lookups expire after one minute;
immutable IPFS content retains its longer cache. Repeated pending clicks share
one lookup. Hosts that require authentication, block downloads, or serve
unsupported/oversized artwork can still fail with the existing red message.

Pons logos point directly to images, not a second metadata JSON document.
No new credential or launch toggle is needed. `READ_UPSTREAMS` and the configured
Robinhood RPC are still required. This expands Pons URL handling; it does not
add new UniV4 metadata formats.

The downloader uses Node's [HTTPS request options](https://nodejs.org/docs/latest-v24.x/api/https.html#httpsrequesturl-options-callback)
with a pinned lookup and normal TLS verification.

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

## Restoration (11 September 2026)

The deployed web proxy returned `404 not_found` for `/api/token-image`. The
active workspace had also removed the API operation, feed imageSource, and
page image-loading/cancellation hooks. Restore the shared resolver and both
image routes, and preserve the current workspace's other launch and feed changes.

Pons-v2 continues to resolve `getTokenInfo().tokenLogo`; no new UniV4 metadata
formats or image hosts are introduced. The provider, browser client, and proxy
integration tests cover Pons IPFS/CDN images and existing O1/Doppler behavior.
The frontend must be deployed together with the API for the live route to work.

## Catbox logo fix

A reported token exposed `https://files.catbox.moe/c45xq8.png` through
`getTokenInfo().tokenLogo`. The file returned HTTP 200 and decoded successfully
(155,203-byte PNG, 1254 × 1254), but the previous host allowlist rejected it.
The initial Catbox fix accepted only the exact HTTPS file host and six-character
raster file paths. Existing byte, dimension, timeout, animation, and redirect checks
remain in force. That host-specific fix is superseded by the general public-HTTPS downloader above.

## General URL regression checks

`public-image.test.mjs` checks unknown hosts, query URLs, extensionless paths,
IPv4/IPv6 targets, mixed DNS responses, pinned lookups, rebinding, relative and
cross-host redirects, loops, byte limits, aborts and admission release.
Pons fixtures cover metadata selection and raster decoding separately from
network validation. Live decoder checks cover Catbox, Axiom and Twitter logos.
