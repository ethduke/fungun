# O1 COPY image experiment

Branch: `test/o1-copy-image`, based on committed revision `485cd96`.

COPY on a recognized O1, O1 RWA or O1 migrated row on Robinhood now fills name
and ticker immediately, then loads its artwork into the image field. The image
is saved as a Blob in the existing IndexedDB draft cache. Other launchpads keep
their existing behavior. Source identity does not change the launch destination.

The read service needs its existing `READ_UPSTREAMS=true` and server-only
`O1_API_KEY`. No additional credential is needed. The new operation is
`POST /api/o1-token-image` with `{ chainId: 4663, address }`; development proxies
it and production forwards it to the read service's matching `/v1/` operation.
Both web and API changes must be run together.

The server calls O1's token detail API, checks exact chain/address, and downloads
the image from O1's verified public Pinata gateway. This experiment intentionally
accepts only `sapphire-negative-junglefowl-959.mypinata.cloud` IPFS paths without
redirects, query strings or credentials. Gateway changes or other image hosts
produce “Image unavailable—upload one.” Requests accept no arbitrary URL.

Successful images are cached for five minutes with eight retained entries and
shared in-flight reads. Failures are cached briefly. Both external requests use
the existing read budget; the image fetch does not receive the API key. Image
responses are limited to 2 MiB and checked for supported raster signatures, then
decoded in the browser with the existing 4096 × 4096 limit. Oversized artwork
is not automatically resized.

To test, run this branch's normal local development setup with those read-service
settings, then press COPY on an O1 row. Confirm the image appears and survives a
reload. While loading, COPY another row or upload a file; the first request must
not overwrite the newer draft. A non-O1 row still copies text and clears the
previous image. Missing artwork must leave the copied text usable.

Focused automated checks:

```sh
node --experimental-strip-types --test apps/api/src/o1-token-image.test.mjs scripts/copied-token-image.test.mjs scripts/o1-copy-integration.test.mjs scripts/tracked-feed.test.mjs apps/web/lib/read-proxy.test.ts apps/api/src/service.test.mjs
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

The HTTP integration checks need permission to bind localhost. No deployment,
token launch, upload to IPFS, or blockchain transaction is part of this test.

Verified on 6 September 2026: all 33 focused tests, web type checking, web lint,
changed API module lint, and the Fly production build passed. A live O1 token
lookup downloaded a 1,167,458-byte PNG; the existing launch decoder accepted it
at 1254 × 1254 pixels. Interactive browser verification remains a manual test.
