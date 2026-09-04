# Grok images paid with USDG

The composer now connects the wallet to an x402 v2 image job:

`App → x402 authorization → asset backend → OpenRouter → Grok → saved coin picture`

The image is automatically selected when the draft has no picture. Replacing an
existing picture uses **Use as coin picture**. The existing **Launch artwork**
preview/publication flow accepts the generated Blob and publishes the image and
Long metadata. Published image/metadata URLs are saved against the exact draft.
The launch transaction button still requires the existing launch-cost and contract
verification work; generating or publishing artwork does not enable a token launch.

## Runtime configuration

Generation defaults to disabled. Configure the **asset service**, not the read
service or browser bundle, with these runtime values:

| Variable                      | Purpose                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `IMAGE_GENERATION=true`       | Enable new image requests after setup                                          |
| `OPENROUTER_API_KEY`          | Server-only image API credential                                               |
| `IMAGE_PAYMENT_RECIPIENT`     | One operator-controlled address receiving every image payment                  |
| `IMAGE_USDG_ADDRESS`          | Canonical USDG contract from the official Robinhood contracts registry         |
| `IMAGE_PRICE_USDG_BASE_UNITS` | Integer price, six decimals; defaults to `100000` (0.10 USDG), maximum 10 USDG |
| `X402_FACILITATOR_URL`        | HTTPS facilitator supporting v2 `exact` / `eip155:4663` / EIP-3009             |
| `X402_FACILITATOR_TOKEN`      | Optional server-only facilitator credential                                    |
| `ROBINHOOD_RPC`               | Server-only HTTPS RPC for read-only settlement reconciliation                  |
| `ASSET_DECODER_ORIGIN`        | Existing isolated image decoder                                                |

Use the existing `APP_ORIGIN`, `ASSET_STORE_ROOT`, `ASSET_PUBLIC_ORIGIN` and
single-Machine configuration. Set `ASSET_UPLOADS=true` for subsequent artwork and
metadata publication. The web runtime needs `APP_ORIGIN`, `ASSET_SERVICE_ORIGIN`,
`ASSET_PUBLIC_ORIGIN`, `ASSET_UPLOADS`, and the same public `IMAGE_USDG_ADDRESS`;
it never receives either provider credential. The web proxy rejects a quote whose
token differs from its configured payment asset.

Initialize the new ledger once on the existing asset volume:

```sh
node scripts/start-assets.mjs --initialize-image-jobs
```

The command refuses an existing ledger. Production uses `/data/image-jobs.sqlite`,
outside the existing `/data/launch-assets` directory, so asset snapshot validation
continues to work. Locally it uses a sibling `<asset-root-name>-image-jobs.sqlite`.
Use `node scripts/start-assets.mjs` to launch the configured service. Startup
refuses missing/uninitialized job storage when generation is enabled. Recovery of
completed results remains available when new generation is disabled.

[Primer's official facilitator documentation](https://docs.primer.systems/facilitator.html)
lists a public option at `https://x402.primer.systems`; its `/supported` endpoint
advertised the required Robinhood EIP-3009 route when checked on 4 September 2026.
It is an operator-selected dependency, not an implicit default. Recheck support
and service terms before activation.

## Provider and payment details

The fixed server product uses OpenRouter `POST /api/v1/images`, model
`x-ai/grok-imagine-image-2.0`, provider `xai` only, `n:1`, `aspect_ratio:"1:1"`,
`resolution:"1K"`, and `quality:"low"`. OpenRouter returns `data[0].b64_json`.
No wallet, signature, payment headers, or deployment instructions go to Grok.
The existing prompt scaffold supplies the validated coin name, ticker, and brief.
There are no automatic image-provider retries or alternate providers.

The adapter bounds the provider deadline at 180 seconds and decoded input at
2 MiB, checks raster signatures and moderation failures, then passes the image
through the isolated decoder. Only sanitized square WebP bytes are persisted as
a completed picture. Oversized/invalid outputs fail without settlement.

USDG was checked using read-only Foundry calls: Robinhood chain ID 4663, six
decimals, EIP-3009 authorization entry points, and an EIP-712 domain matching
`Global Dollar` / version `1`. Runtime addresses remain outside source control;
obtain the canonical contract from the
[official Robinhood contracts registry](https://docs.robinhood.com/chain/contracts/).
The read-only startup/quote check validates the configured chain, token bytecode,
decimals, and domain separator before payment is offered.

## Durable request lifecycle

The browser creates and saves a request ID and random recovery capability before
requesting a price. The server binds that ID to the normalized input, product,
origin, payer, price, recipient, asset and a one-use nonce. The wallet's typed-data
signature is independently recovered on the server, then verified by the
facilitator. A JSON wallet address alone never authorizes generation.

The ordering is `awaiting_payment → authorized → generating → generated →
settlement_pending → completed`. Generation is atomically claimed once. Provider
bytes are persisted before decoding; sanitized bytes are persisted before payment
settlement. The image is delivered only after payment is confirmed. Each signed
request and recovery request retains the original operation and authorization.

The backend preserves `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and
`PAYMENT-RESPONSE` through the same-origin proxy. Generation uses
`POST /api/images/grok`; uncharged recovery uses
`GET /api/images/grok/:requestId` with the saved bearer capability. Recovery is
outside generic paid middleware and does not request another signature.

An interrupted provider call is marked `unknown`, never automatically regenerated
or settled. Provider/decode failures record `not_charged`. A lost settlement
response retains the image and authorization, and is reconciled using a canonical
successful receipt containing both the matching `AuthorizationUsed` nonce event
and exact USDG `Transfer`, with at least two confirmations. A cancelled/used nonce
alone is insufficient evidence. Recovery scans are bounded to 20,000 blocks in
2,000-block chunks; older/ambiguous cases require operator review. It does not
blindly resubmit settlement after an uncertain outcome.

A well-formed x402 failure with an empty transaction is terminal and uncharged.
For an ambiguous response, the service keeps reconciling until either payment is
proved or a confirmed chain timestamp proves the authorization expired. Only then
does it close the request as uncharged; review-required cases remain preserved.

SQLite uses WAL and FULL synchronization with an exclusive process owner. The
service bounds jobs, retained image bytes, quote creation, and daily generations.
Expired unpaid quotes can be pruned; completed jobs and consumed authorizations
are retained. Keep one approved asset Machine. Back up the image ledger and its
WAL consistently in addition to the existing asset snapshot: the asset-only
backup does not contain image/payment jobs. Never replace the live ledger with a
stale snapshot or reinitialize it to resolve an uncertain payment.

## Reload behavior and validation

IndexedDB stores the coin fields, selected routes, image Blob and any published
metadata reference. Reload creates a fresh object URL from those bytes. The UI
waits for hydration before editing and reports cache failures. Published metadata
is invalidated when coin details or artwork change. A separate browser recovery
record saves the request/authorization before submission; a completed record drops
the payment proof and retains access to the server result. Do not clear browser
storage while payment status is unresolved.

Mocked integration tests cover unpaid requests, valid and invalid authorizations,
concurrent duplicates, input changes, server restart, filtered/timeout/oversized
provider responses, interrupted generation, settlement recovery and cache races.
Live paid generation and token deployment require the runtime settings above and
explicit wallet approval in the app.

Protocol references: [OpenRouter Image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation),
[x402 v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md),
[exact EVM scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md),
[EIP-3009](https://eips.ethereum.org/EIPS/eip-3009).
