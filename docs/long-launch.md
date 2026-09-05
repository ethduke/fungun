# Unsigned Long launch boundary

The wallet preparation, simulation and receipt layer is now implemented; see
[Long wallet launch](long-wallet-launch.md) for live evidence and rollout details.

`apps/api/src/long-launch.mjs` implements an offline ordinary-Long transaction
builder for Robinhood Chain. It does not read configuration files, contact a
provider, publish metadata, sign, broadcast or enable the Launch button.
Every returned plan is marked `requires_verification`.

## Fixed launch profile

- The deployment profile is injected from reviewed server configuration; no
  operational addresses, code hashes, wallet keys or captured calldata are
  committed. The profile identifies the launcher, Airlock, token factory and its
  init-code hash, governance factory, pool initializer, liquidity migrator, hook,
  integrator, protocol beneficiary and eligible token/oracle pairs.
- Only the reviewed Robinhood RWA profile is supported: 18-decimal quote tokens
  and 8-decimal oracle answers. Unknown chains, pairs, extra fields and incomplete
  identities fail closed. A valid configuration shape is not contract verification.
- The token has one billion units at 18 decimals, all for sale. There is no
  creator/team vesting allocation, mutable metadata controller or balance limit.
  Long's canonical `1e18` address suffix is required. Longbow's separate allocation
  recipe is not included.
- Nested token-factory parameters, the pool tuple and hook data match the
  reference adapter's distinct ABI encodings. The pool uses the connected wallet
  as its creator beneficiary. This module does not add or change fee-claim coverage.
- Native transaction value is zero for this nonpayable profile. That is not a
  live gas estimate, a free-launch claim or permission to skip contract checks.

CREATE2 salt selection binds the complete reviewed profile, creator, public token
details, pair, metadata URI, curve tick and intent ID. It ensures the predicted
token sorts below the quote token and ends in `1e18`, stopping after 3,000,000
candidates or the preparation deadline. The API yields every 4,096 candidates;
the browser checks the supplied attempt and CREATE2 address without repeating
the search. Repeating
the same context produces the same plan. This is not durable replay protection;
it does not prove the address is vacant or reserve the ticker. The suffix is a
Long compatibility requirement, not proof of authenticity or guaranteed listing.

`assertUnsignedLongTransaction` reconstructs the expected bytes and rejects any
wallet, chain, target, native-value, calldata or extra-field substitution. The
offline transaction intentionally has no nonce, gas fields or authorizations.
A future live-preparation layer must validate its own bounded gas/nonce envelope
separately without weakening these calldata checks.

## Required before live preparation

1. Re-verify the exact current contract sources and runtime hashes, nonproxy
   assumption, launcher pause state, Airlock/token-factory links, reservation
   duration and enabled module roles at one explicit block.
2. Resolve the selected pair server-side. Verify its token/oracle identities,
   decimals and a fresh positive oracle observation before deriving the curve.
   The reference's positive `latestAnswer` check alone is not a freshness check.
3. Publish only approved image/metadata bytes using the gated
   [asset pipeline](launch-assets.md), then verify retrieval and binding. URI
   syntax alone is not proof that the image or metadata exists or matches.
4. Verify wallet-bound intent, ticker state and predicted-address vacancy. Perform
   exact `create` simulation with that wallet as `from`, not a multicall sender.
5. Estimate gas and check wallet balance. Robinhood's Nitro estimate already
   includes L1 posting. Apply bounded quote expiry and an independently fresh
   ETH/USD reference; never show missing costs as zero.
6. Only after all checks pass, offer explicit wallet approval. Recheck changed
   context, deduplicate submissions durably and verify the receipt and launched
   contract state. A timeout is uncertain, not permission to submit again.

All provider calls must reuse the existing durable budget and request coalescing.
Batching reduces HTTP overhead, not provider-accounted RPC methods. Do not expose
arbitrary calldata, contract, URL, salt-mining or simulation endpoints.

Local ABI regression tests use generated synthetic addresses and no RPCs.
Live simulation, Long frontend/listing compatibility and end-to-end wallet testing
remain release gates. No transaction has been sent by this milestone.
