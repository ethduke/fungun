# Long wallet launch

Long on Robinhood mainnet (4663), initially NVDA, now has a wallet-only launch
path. The existing reference bot was read for ABI and deployment evidence only.
No bot, local signer, private key, or fee-coverage change is integrated.

## Audit evidence — September 4, 2026

Read-only `cast` checks at block 54,601,111 matched all seven reference runtime
hashes. The launcher was unpaused; Airlock and trusted-token-factory links,
24-hour reservation duration, and module roles 1–4 matched. The live stock-token
beacon implementation and Chainlink aggregator were separately resolved and
pinned. Operational identities remain in runtime configuration, outside Git.

Sourcify returned exact creation/runtime matches for the live LongLauncher.
Its verified ABI matches the unsigned encoder's create selector. `create` is
nonpayable, forwards unchanged parameters to Airlock, checks the trusted factory,
and records the caller in LaunchCreated. The first two indexed event fields are
pool/hook and asset; an older watcher note reverses those labels. Receipt checks
use the verified ABI order. Owner powers include pausing and sweeping assets held
by the router; Airlock module governance and external proxy upgrades remain trust
assumptions. Matching bytecode is not a complete economic audit of every module.
Doppler's official registry independently matches the Airlock, token factory,
NoOp governance, initializer and NoOp migrator in the reference profile.

A new unsigned call using a historical reference sender and synthetic, unpublished
metadata simulated successfully and returned the predicted CREATE2 token. The
sample estimate was 1,985,270 gas units. This proves the calldata path at that
observation, not a completed launch, asset publication or current user quote.
The reference sender was used only as `eth_call`/`eth_estimateGas` context.

The configured NVDA feed has an 86,400-second heartbeat in Chainlink's published
feed directory. Preparation rejects older observations, unfinished/future rounds,
non-positive prices, paused stock oracles, changed proxy dependencies and a stale
chain head. Prices are per token; no extra corporate-action multiplier is applied.
No canonical sequencer-uptime feed has been pinned in this release. Fresh chain
headers and feed observations are checked; they do not replace that feed.

## User flow

1. Connect Rabby or MetaMask, choose only Long and NVDA, and complete the draft.
2. Prepare and confirm public artwork. The existing free signature authenticates
   exact publication consent and the wallet's upload quota. Pinata uploads and
   verification then run in the background. Public copies may remain permanently.
3. Review launch. The server verifies the existing publication receipt, reconstructs
   its canonical metadata/CID, validates contracts and prices at one explicit block,
   checks ticker/address vacancy, simulates with the wallet as sender, and estimates
   pending gas and balance. It returns no signed bytes.
4. Review ETH/USD launch and gas costs, then click Launch coin. The browser uses the
   same portable encoder to reconstruct every calldata byte. It rechecks account,
   chain, launcher code and pending nonce, durably reserves one attempt, and asks
   the extension to sign and submit exactly once. The user must approve in the wallet.
5. Check launch. Transaction identity, calldata, value, gas envelope, canonical
   receipt, 12-block confirmation depth, event and token/Airlock state are verified.
   Twelve L2 blocks are confirmation depth, not Ethereum settlement finality.

The Long launchpad payment is zero ETH for this reviewed nonpayable path. Network
gas is still charged. Robinhood's estimate includes both execution and L1 posting;
no second L1 fee is added. The wallet envelope uses 20% extra gas units, a 3-million
unit limit and a 0.05 ETH maximum gas budget. The UI warns at 0.01 ETH. Quotes expire
after 30 seconds; Coinbase ETH/USD spot is cached for 30 seconds and displayed only
within 60 seconds. USD is indicative; ETH is the actual payment currency.

## Recovery and request bounds

The existing budget database holds an additive `long_launches` table. HMAC identity
binds a wallet and metadata hash; the complete input cannot change under that record.
Preparation is capped at 3/minute and 30/day, with a 4,096-record ceiling. All RPC
methods debit the existing durable provider/global budgets. There is one active
launch read, bounded deadlines, cached publication/price reads and receipt checks.
No arbitrary target, RPC URL, calldata, signature or gas override is accepted.

Reservation uses a conditional SQLite update before the wallet opens. Attempted
records never expire or get pruned automatically. Timeouts and cancellation keep
that attempt locked. Browser recovery stores only opaque ID, binding and an optional
transaction hash, never the wallet address, draft, signature or calldata. If the
wallet returned no hash, its history hash can be entered for read-only recovery.
A hash that does not match the stored transaction is rejected. Storage failure
prevents wallet dispatch. A lost reservation response is uncertain, not retryable.
A cancelled/uncertain attempt may require operator review; no unsafe reset endpoint
is provided. Different browser profiles still share the server reservation.

## Runtime and delivery

API-only settings: `LONG_WALLET_LAUNCH`, `LONG_LAUNCH_PROFILE_JSON`,
`LONG_LAUNCH_GUARDS_JSON`, `LAUNCH_ASSET_SERVICE_ORIGIN`. The profile uses the existing
strict unsigned-builder format. Each quote's guards contain `tokenBeacon`,
`tokenImplementation`, `oracleAggregator` (address/runtime hash) and a reviewed
`heartbeatSeconds` between 1 and 86,400. The asset origin is a pinned HTTPS origin or the existing Fly private
`http://<asset-app>.internal:8790` service.
The launch path is disabled by default. It becomes eligible for live verification only
when `LONG_WALLET_LAUNCH=true`, `READ_UPSTREAMS=true`, the other three settings are
present and valid, and the existing `ROBINHOOD_RPC` is configured. `npm run runtime:status`
reports these requirements under `long_wallet_launch` without exposing their values.
No credentials enter client
build variables; only public deployment information accompanies an unsigned plan.

The portable encoder lives in `apps/web/lib/long-encoding`; the API imports it
through a wrapper that preserves API error handling. The web image includes no
API service source. API packaging includes only this portable encoding directory.
Existing asset, decoder and facilitator images need no change.

Publication's version-2 message and server journal remain compatible with pending
approvals. Removing the signature would require another authenticated admission
mechanism. Origin headers alone are not authentication. A shorter signed protocol
would require explicit versioning and recovery migration; existing signatures are
not silently reinterpreted. O1 retains its native pinning path.

Sources: [Robinhood network configuration](https://docs.robinhood.com/chain/connecting/),
[gas and fees](https://docs.robinhood.com/chain/gas-and-fees/),
[oracle behavior](https://docs.robinhood.com/chain/oracles-and-price-feeds/),
[Chainlink Robinhood feed directory](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json),
[Doppler deployment registry](https://github.com/whetstoneresearch/doppler/blob/main/Deployments.json),
[Sourcify verified contracts](https://sourcify.dev/).
