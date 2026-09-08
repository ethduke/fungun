# Image COPY for Long and Doppler

Investigated 2026-09-07. Research only; no application or deployment changes.

Long image COPY is feasible using the existing Robinhood RPC and public IPFS gateways. A shared resolver should also cover EVM Doppler tokens exposing the standard `tokenURI()` method. Custom token factories mean this is a compatibility path, not a guarantee for every Doppler launchpad.

## Verified samples

Read `tokenURI()(string)` from the token contracts with read-only `cast call`, verified chain 4663, fetched the referenced content, and passed the image bytes through this repository's `decodeLaunchImage` (full decode and launch limits).

| Source | Sample | Metadata path | Original image | Result |
| --- | --- | --- | --- | --- |
| Long | AUTSM | `image_hash` | JPEG, 304,739 bytes, 1168 × 784 | Passed |
| Long | Artificial Inu | `image_hash` | JPEG, 79,349 bytes, 1000 × 1000 | Passed |
| Long | AGI Frog | `image_hash` | PNG, 314,758 bytes, 600 × 600 | Passed |
| Longbow | 🕯️ | `image` and `image_hash` | PNG, 25,488 bytes, 252 × 255 | Passed |
| Longbow | Liger | `image` and `image_hash` | JPEG, 19,217 bytes, 400 × 400 | Passed |
| Longbow | Chubb / CHUBBS | `tokenURI()` directly references image | JPEG, 20,096 bytes, 454 × 512 | Passed |

The first five lookups completed in approximately 0.8–1.1 seconds in this probe. This is a small selected sample, not a latency benchmark or a platform-wide success estimate.

Chubb is significant: the Longbow index reported no image, but its on-chain URI resolved directly to a valid JPEG. A resolver that assumes every token URI is JSON would miss it. Of the 564 entries in the sampled Longbow index, 23 lacked an image and 22 lacked a URI; these counts describe that snapshot only.

The Pure Markets and Zora examples in the official metadata documentation also resolved to valid JPEGs (1000 × 1000 and 355 × 355). These were documentation CID checks, not live contract verification for those platforms. The initial gateways timed out or required redirects; alternate gateways succeeded. Zora's dweb.link path redirected to its CID subdomain.

## Recommended implementation

1. Extend the image provider dispatch used by COPY. Keep O1's existing provider; add a Doppler-compatible provider keyed by supported chain and token address.
2. Read `tokenURI()` on the token, not its pool or hook. A feed's launchpad label should not be the sole eligibility check: generic pool labels can hide compatible tokens. A successful method call establishes metadata compatibility, not Doppler provenance.
3. Resolve validated IPFS references through configured gateways. Inspect the returned bytes for a supported raster image first; otherwise parse bounded JSON and resolve a valid `image`, falling back to `image_hash`.
4. Fetch with byte and time limits, then reuse the launch image decoder and existing COPY response/blob flow. Preserve cancellation when another token is copied or the user uploads/removes an image. Keep the feed's name/ticker; do not overwrite them from external metadata.
5. Cache token-address-to-URI lookups briefly and immutable CID content longer. Both legacy DERC20 and current DopplerERC20V1 allow the owner to update `tokenURI`.
6. Keep text COPY usable when metadata is missing, unavailable, oversized, animated, or otherwise unsupported. Reuse the existing 2 MiB and 4096-pixel-side limits.

A normal uncached lookup requires one RPC read and two HTTP fetches; a direct-image URI needs one of each. No transaction, wallet signature, gas, or new API key is required for the tested Long path. Apply existing upstream budgets and request deduplication.

For an initial implementation, IPFS covers all tested samples. Arbitrary HTTPS metadata support needs a separate host/network policy; do not broaden the O1 allowlist to arbitrary URLs. Gateway fallback and redirects should be limited to explicitly approved gateway destinations. In particular, a blanket redirect prohibition misses dweb.link's CID-subdomain behavior, while unrestricted redirects are unsuitable for a server fetcher.

The official indexer supports `image` and `image_hash` for IPFS metadata in the inspected helper. Its published supported-chain table did not list Robinhood at investigation time, so the proposed Long path should use the existing RPC instead of depending on hosted indexer coverage. This investigation covers EVM token contracts, not Solana.

## Sources and evidence

- [Doppler metadata standard and Pure Markets / Zora examples](https://docs.doppler.lol/reference/metadata-standards)
- [Doppler indexer overview](https://docs.doppler.lol/reference/overview)
- [DopplerERC20V1 source at inspected commit](https://github.com/whetstoneresearch/doppler/blob/5754c7ee01f1bdbd6f07c62be721e1223b725ecd/src/tokens/DopplerERC20V1.sol): public `tokenURI` and owner-authorized `updateTokenURI`.
- [Legacy DERC20 source at inspected commit](https://github.com/whetstoneresearch/doppler/blob/5754c7ee01f1bdbd6f07c62be721e1223b725ecd/legacy/src/tokens/DERC20.sol)
- [Official indexer token metadata helper at inspected commit](https://github.com/whetstoneresearch/doppler-indexer/blob/6b53213666dde1783e4eedc1cb383a88a57cdf85/src/indexer/shared/entities/token.ts)
- Local evidence, including exact sample addresses, URIs, gateway outcomes, and decoder results: `local/doppler-image-copy/results.json` and `local/doppler-image-copy/fallback-results.json` (ignored research artifacts).

The raw primary probe records Chubb's initial JSON parse failure. The fallback probe verifies its direct-image decode and successful alternate-gateway retrieval of the documentation examples.
