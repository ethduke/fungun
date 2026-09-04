# Fee reads and wallet claims

The Fees page loads fees only for the connected wallet. While disconnected, it
shows “Connect your wallet to show fees.” and makes no fee lookups. It never polls.
Refresh is explicit; each page is cached for 45 seconds with concurrent work
coalesced. Missing configuration and failed reads mean **unknown**, not zero.
The page groups payout balances into one card per launchpad, with one Claim all
action per card. Check more reads one bounded page. Previously found positions
remain visible after a failed continuation. Switching accounts or disconnecting
discards old work and clears displayed fees.

## Coverage

- Long and Longbow / Robinhood: discover locked pools from a reviewed manager's beneficiary
  events, including transferred fee rights, or page through up to 256 configured
  pools. Each page verifies at most two pools. Separate hook payouts remain
  unsupported. Both pool currencies are paid by one claim. Longbow has its own
  reviewed profile and card; the same pool must not appear under both launchpads.
  A shared manager cannot provide launchpad attribution for an unfiltered event scan.
- O1 / Robinhood and Base: resumable wallet-index pages with eight positions per
  page, including historical indexed positions. Every position in an approved
  escrow profile receives a live `owed` read; there is no four-position live cap.
  Identical escrow/recipient/currency positions are deduplicated, never summed.
  Unapproved or incompatible escrows remain indexed and cannot be claimed here.
- O1 claims support reviewed current and legacy escrow profiles on both chains. Base
  additionally needs a pinned gas oracle. The webview still has Base paused.
- Fees are displayed by payout currency and source. O1 escrow balances are shared
  across launches; they cannot be labeled as fees owed by an individual launched coin.
  Owning an ERC-20 balance does not itself confer creator or beneficiary fees.

Each launchpad's Claim all queues its eligible discovered positions and prepares
the first claim. Each transaction requires wallet confirmation. A matching receipt
payout prepares the next claim. Rejected, reverted or uncertain requests stop the queue. Confirmed
positions stay excluded until Refresh; changing networks retains the queue,
while switching accounts or disconnecting clears it. Claim all never promises
coverage of undiscovered pages, unsupported protocols or separate hook payouts.

## Private runtime configuration

Keep all values in an ignored local `.env` or Fly runtime secrets. Never paste
keys into chat, browser variables, tracked files, command arguments or tests.
The committed `.env.example` must stay blank. Fee reads use `READ_FEES=true`;
claim preparation additionally requires `WALLET_CLAIMS=true`. These switches are
independent of catalog/ticker `READ_UPSTREAMS`.

Run `npm run runtime:status` from the running worktree to identify missing
settings and disabled switches without printing their values. The Fees page
distinguishes a disabled fee service, missing provider setup and missing contract
setup from wallet connection. Positions with disabled claims explain whether
claims need enabling, contract verification, Base gas estimation configuration,
or a positive fee balance. Restart the API after changing runtime settings, then
use Refresh in the connected wallet's Fees page.

Use server-only `O1_API_KEY`, `ROBINHOOD_RPC` (or its existing alias), and
`BASE_RPC_URL`. Set `RPC_BATCH_REQUESTS=false` for a provider that rejects or
stalls JSON-RPC batches. This sends the same bounded read methods individually,
with the same quota accounting and no request retries. The default retains batch
requests. `FEE_CONTRACTS_JSON` has this shape; the placeholders below are
intentionally invalid and cannot enable claims:

```json
{
  "o1": [{ "chainId": 4663, "escrow": "<verified-escrow>", "codeHash": "<runtime-hash>", "version": "current" }],
  "long": {
    "manager": "<verified-initializer>",
    "managerCodeHash": "<runtime-hash>",
    "hook": "<verified-Long-hook>",
    "hookCodeHash": "<runtime-hash>",
    "pools": [{
      "asset": "<launch-token>",
      "currency0": { "address": "<lower-currency-address>", "symbol": "<symbol>", "decimals": 18 },
      "currency1": { "address": "<higher-currency-address>", "symbol": "<symbol>", "decimals": 6 },
      "fee": 3000,
      "tickSpacing": 60
    }]
  },
  "baseOracle": {
    "address": "<gas-price-oracle-proxy>",
    "codeHash": "<proxy-runtime-hash>",
    "implementation": "<verified-implementation>",
    "implementationCodeHash": "<implementation-runtime-hash>"
  }
}
```

For Longbow, add a separate `longbow` section with the same locked-pool schema as
`long`, using independently identified Longbow default-route pools. Shared
manager/hook code pins must agree, and pools cannot be duplicated across profiles.
Other Longbow routes are not enabled by a default-route profile.

Omit unconfigured sections. Native currency uses the runtime zero address, ETH/18;
wrapped ETH is distinct. Verify actual pool fee, spacing and token decimals—example
numbers are not deployment configuration. Pool IDs are computed from the full key.
O1 supports up to 32 reviewed profiles, unique by chain and escrow address.
Use chain ID 8453 for a Base profile; the same address on another chain needs its
own profile and code hash. Merely appearing in the wallet index never approves a target.

The O1 profile `version` defaults to `current`, which uses `claimFor(recipient,currency)`
and verifies a `Claimed` event containing the recipient, currency, destination and
amount. An independently reviewed historical escrow requires explicit
`"version": "legacy"`; its adapter uses `claim(recipient,currency)` and the legacy
`Claimed` event containing the recipient, currency and amount. Both adapters bind
the recipient to the connected wallet and require the escrow's reviewed runtime
hash. The version is retained in fee positions and claim quotes; mismatched
versions are rejected, with no automatic method fallback.

For Long event discovery, replace `pools` with `discovery` containing `fromBlock`
(the independently verified manager deployment block) and optional `blockRange`
(default 2,000, maximum 10,000). Both are integers. All pages use one frozen
snapshot block and retain an opaque continuation. Historical scans can require
thousands of pages and exceed daily quota; do not interpret an unfinished scan
as a wallet-wide result. A configured-pool list is always labeled partial.

Before enabling claims, the operator must independently verify source/ABI, chain,
runtime hashes, immutable hook/PoolManager wiring and deployment provenance using
read-only `cast` and the official deployment links. Only directly deployed,
non-upgradeable Long managers/hooks and reviewed O1 escrow versions are supported. Do not
pin a proxy as an immutable contract. Hashing arbitrary RPC bytecode is not a review.
The Base gas oracle is the one supported proxy: both its EIP-1967 implementation
slot and implementation runtime hash are checked. Pin checks, balances, Long fee
checkpoints/collection simulation and oracle reads use one explicit block.

## Claim boundary

Same-origin JSON POSTs use `x-fungun-intent` matching their operation:

- `/api/fees` → `/v1/fees`: `address`, `chainId`, `padId`, optional opaque `cursor`.
- `/api/claim-prepare` → `/v1/claim-prepare`: `address`, `positionId` only.

The second endpoint prepares but never sends a transaction. Opaque handles bind
wallet, chain, profile and position; they expire after thirty minutes to permit
longer scans and claim queues. These handles are identities, not executable quotes.
Page cursors also expire after thirty minutes, are scoped to address/chain/source,
and never expose the provider cursor or accept a caller-supplied URL. Responses
include `nextCursor` (null at the end) and `coverage` (`wallet_index`,
`configured_pools` or `beneficiary_events`). The service
rechecks contract identity, positive fees and Long beneficiary shares, simulates
the exact call, estimates gas and checks pending ETH balance. No arbitrary target,
calldata, method, URL, approval, recipient override or server signer is accepted.
The service retains at most 4,096 position handles and 512 cursors in memory.
An O1 scan stops after 512 pages with an explicit limit error; exceeding a limit
never upgrades coverage to complete. Restarting the service invalidates all handles.

Long and Longbow call only `collectFees(poolId)` directly from the beneficiary wallet. O1
uses `claimFor(owner,currency)` for current escrows or `claim(owner,currency)` for
explicitly configured legacy escrows, each paying that owner. All claims have zero
native value and no token approval. Review shows gas in ETH, including Base L1/operator
fees, with a 20% gas-limit buffer and a high-gas warning at 0.01 ETH. Gas USD uses
a live Coinbase ETH/USD reference, cached for up to sixty seconds. See
[gas USD estimates](fee-usd.md) for freshness and quota details. Missing prices
do not block claims. Buffers are not price caps.
The wallet can change fees; the user must review its final transaction.

Preflight results are coalesced for ten seconds and expire after twenty seconds.
Starting a claim requests the selected wallet network automatically, before gas
review. Unsupported networks can be added from the pinned chain metadata. The
wallet can require its own network approval. Queue and review share one panel.
Only an explicit Confirm in wallet click can invoke one `eth_sendTransaction`;
that click refreshes an expired quote before sending. The current account and
chain are rechecked. There are no write retries, namespace fallbacks or signature
transmission to the backend.
Wallet rejection clears the request; ambiguous writes block further claims.
After checking wallet activity, the user can acknowledge uncertainty, wait thirty
seconds and prepare again. This acknowledgment never resends a transaction.

Check receipt is manual, at most once per ten seconds through the connected wallet.
After a verified receipt, the next claim is prepared automatically and still
requires its own wallet confirmation. Successful status alone does not prove a payout:
Long and Longbow require a matching `Release`
event, O1 a matching version-specific `Claimed` event with owner/currency and, for
current escrows, the owner's destination. Actual receipt
amounts may differ from the estimate. One inclusion is not guaranteed finality.
The session guard survives navigation, but not reloads or separate tabs. Always
check wallet activity before retrying after a reload, replacement or dropped response.

## Privacy and quotas

Wallet addresses reach the backend and the relevant provider; public transaction
data necessarily reaches the chain. Do not enable request-body, URL or wallet
telemetry. No addresses, signatures or claim records are stored in SQLite or browser
storage. Server handles and browser transaction state are bounded, volatile memory.

Every RPC method in a batch consumes durable quota. O1 fee discovery reserves three
units per page. The shared short burst cap is 60 units/minute so one bounded load
and claim review can complete; daily caps remain 2,000 total, 600 O1 and 1,400 RPC.
The existing single-Machine Fly storage requirement and request/concurrency limits
still apply. Limits can return 429 mid-read; partial failures must not become zero.

## Verification sources

- [O1 production contracts](https://docs.o1.exchange/launchpad/reference/production-contracts): current Base and Robinhood Fee Escrow deployment provenance; follow the chain's verified-source link before configuring a profile.
- [O1 functions](https://docs.o1.exchange/launchpad/reference/events-functions) and [claim API](https://docs.o1.exchange/launchpad/api/claims-and-creator-actions): owner-bound payout semantics; historical suites differ.
- [O1 schema](https://docs.o1.exchange/launchpad-api-openapi.yaml): currency metadata is optional and must be matched by address, never ticker.
- [Doppler FeesManager](https://github.com/whetstoneresearch/doppler/blob/bda077cf/src/base/FeesManager.sol): `collectFees` releases the caller's share; return values are pool-wide newly collected fees, not that caller's payout.
- [Doppler deployments](https://github.com/whetstoneresearch/doppler/blob/main/Deployments.md): confirm Long's Robinhood initializer against the reviewed source reference.
- [OP fee estimates](https://docs.optimism.io/app-developers/guides/transactions/estimates): execution, L1 data and operator components.

Tests use generated synthetic addresses and mocked RPC/wallet transports. Local
verification on September 4, 2026 matched current and historical O1 deployed runtime
code to verified source counterparts with documented immutable substitutions, and
matched Long manager/hook code to official deployment inputs. The private local
runtime was configured with those reviewed profiles and the wallet's two known Long
pools. All four discovered positions returned positive live balances and passed
exact-call simulation, gas estimation and pending gas-balance checks through the
local claim preparation endpoint. No transaction was sent and nothing was deployed.

Long's current hosted index rejected server-side access, so this local setup checks
the two independently verified pools and retains partial coverage. Additional Long
fee rights require configured pools or completion of the beneficiary-event scan;
the app must not claim automatic wallet-wide Long discovery from this setup. Private
wallet captures, runtime pins and RPC credentials are excluded from this repository.
