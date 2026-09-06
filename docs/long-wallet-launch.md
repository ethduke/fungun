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

### Canonical address correction — September 5, 2026

A mined ROBOTAXI launch passed contract/event/state verification but Long's token
page showed “Fake LONG asset”. The previous encoder enforced token ordering but
omitted Long's `1e18` CREATE2 suffix. The accepted BONER reference used the same
launcher, factory/module suite, supply, hook configuration and 95/5 beneficiary
split. Its token parameters used an empty vesting-schedules array; the encoder
now matches that no-vesting representation too. The reference was compared using
`cast tx`; application acceptance/rejection was observed on Long's actual pages.
The published [integration implementation](https://www.npmjs.com/package/@framononhood/launcher-core)
independently documents the suffix requirement. It is third-party evidence, not
Long's promise to list a future token.

New preparations mine a context-bound address below the numeraire ending in
`1e18`, with a 3-million-attempt cap and the existing request deadline. Mining
yields to the event loop. The browser verifies the supplied attempt in constant
work before wallet dispatch. Unsent old quotes are refreshed. Existing mined
attempts remain recoverable using their original journaled calldata and address.
Nonconforming deployed tokens show an explicit incompatibility notice and an
explorer link, without being presented as accepted by Long. An address cannot
be changed after deployment; repairing this class of existing token requires a
new deployment or a Long-side listing exception.

The search cost varies with the context and the numeric numeraire address. A
Darwin arm64/Node 23.11 review run on September 6 sampled 12 successful searches
against the maximum numeraire: median 566 ms, maximum 1.65 seconds and maximum
190,629 attempts. An intentionally impractical low numeraire exhausted all three
million attempts in 18–22 seconds. Production keeps the 20-second read deadline,
one active operation in each launchpad handler, event-loop yields every 4,096 hashes,
and the fixed attempt ceiling. A timeout fails before wallet dispatch. Successful
plans are durably reused, and the in-process salt cache holds at most 64 entries.
The three-per-minute and 30-per-day launch allowance is shared across launchpads
and is debited only after the server-issued publication ticket, immutable metadata,
configured quote, current contracts, ticker and oracle have been validated. Invalid
anonymous inputs retain the broader request, asset-status and upstream limits but
cannot spend this scarce CPU admission allowance.

A read-only replay of the corrected ROBOTAXI recipe at block 55,285,630 returned
the predicted suffix-bearing address and estimated 1,968,454 gas. No transaction
was signed or broadcast. This verifies the contract recipe and address invariant;
it does not prove future Long indexing or acceptance before an actual launch.

1. Connect Rabby or MetaMask, choose Long and any listed pairing, and complete the draft.
   The UI accepts all Long pairings; the server still requires a configured quote
   and its guards before preparing a transaction.
2. Click **Launch coin** once. This authorizes publication of the displayed artwork
   and metadata. The app validates, uploads and verifies them in the background.
   No wallet message signature or separate prepare/publish button is used.
   Public copies may remain permanently; the app covers publication within its limits.
3. The server then verifies the publication receipt, reconstructs
   its canonical metadata/CID, validates contracts and prices at one explicit block,
   checks ticker/address vacancy, simulates with the wallet as sender, and estimates
   pending gas and balance. It returns no signed bytes.
4. Preparation stays active through short service cooldowns and delayed artwork checks.
   Read-only stages honor Retry-After and resume automatically. An authorized network
   switch continues the same launch. ETH/USD launch and gas estimates appear and the wallet opens automatically. The browser uses the
   same portable encoder to reconstruct every calldata byte. It rechecks account,
   chain, launcher code and pending nonce, durably reserves one attempt, and asks
   the extension to sign and submit exactly once. The user must approve in the wallet.
5. Confirmation is checked automatically, including after refresh. Transaction identity, calldata, value, nonce, chain, canonical
   receipt, 12-block confirmation depth, event and token/Airlock state are verified.
   Twelve L2 blocks are confirmation depth, not Ethereum settlement finality.

Wallet-adjusted gas limits, gas prices and EIP-1559 conversion do not change the
launch intent and do not invalidate an otherwise verified deployment. The quoted
budget remains enforced before submission; gas paid comes from the mined receipt.
Confirmed launches open a dismissible dialog with the recovery-scoped coin artwork,
name and ticker, a link to `https://app.long.xyz/tokens/<confirmed asset>`, and the
transaction receipt. The success dialog can be reopened from the launch card.

The compact review card keeps the fee total above the single launch action and
places individual fees in an expandable breakdown. A single bullet progress line
follows artwork preparation/upload, gas estimation, wallet approval and pending
confirmation. It is indeterminate, not a payment percentage. Errors show a concise status while automatic recovery continues. Only a verified
confirmed receipt shows the gun recoil and coin arrival; a submitted transaction
hash does not. Reduced-motion preferences disable both animations. Receipt polling is read-only; only a new user click can open another wallet request.

The Long launchpad payment is zero ETH for this reviewed nonpayable path. Network
gas is still charged. Robinhood's estimate includes both execution and L1 posting;
no second L1 fee is added. The wallet envelope uses 20% extra gas units, a 3-million
unit limit and a 0.05 ETH maximum gas budget. The UI warns at 0.01 ETH. Quotes expire
after 30 seconds; Coinbase ETH/USD spot is cached for 30 seconds and displayed only
within 60 seconds. USD is indicative; ETH is the actual payment currency.

## Recovery and request bounds

The existing budget database holds an additive `long_launches` table. HMAC identity
binds a wallet and metadata hash; the complete input cannot change under that record.
New version-1 rows also retain the publication CIDs, exact portable-builder inputs
and the selected quote's normalized beacon, implementation, aggregator and heartbeat
guard. Cached reuse and reservation compare that snapshot with current configuration.
Status reconstructs current-format calldata, binding, address and review fields, then
checks the saved profile and guard code plus historical beacon/aggregator links at the
canonical receipt block. Explicit version-0 rows remain receipt/event/state recoverable,
but an unsent legacy plan is rebuilt before it can be offered to a wallet.
Preparation is capped at 3/minute and 30/day, with a 4,096-record ceiling. All RPC
methods debit the existing durable provider/global budgets. Each launchpad handler
admits one active launch read, with bounded deadlines and cached publication/price
reads and receipt checks.
No arbitrary target, RPC URL, calldata, signature or gas override is accepted.

Reservation is durably saved before the wallet opens. Attempted records never
expire or get pruned automatically. Browser recovery stores only opaque ID,
binding and an optional transaction hash; it never asks the user to copy a hash.
On refresh the client checks status automatically. An unused nonce restores the
Launch coin action. A retry reruns publication, contract, oracle, simulation,
balance and fee checks while retaining the original nonce. It never silently
advances to a second nonce. Each user action sends at most one wallet request;
there is no automatic signing or transaction submission.

The additive `long_launch_attempts` journal retains up to 16 offered transaction
envelopes per intent so a delayed original response remains verifiable after a
requote changes price, calldata or gas. Legacy wallet records are retained before
requote. Concurrent tabs and uncertain submissions use the same account/chain/
nonce; at most one of those transactions can be mined on the canonical chain.
The wallet must honor the explicit nonce supplied in its transaction request.
No reset endpoint or user assertion is treated as proof of non-submission.

When a hash is missing, server reads check the original sender's latest/pending
nonce. If consumed, a bounded binary search locates its transaction in canonical
blocks (six probes per request, at most 32 in-memory searches). Historical nonce
reads must be supported by the configured RPC; unavailable reads retain recovery
and retry after the service cooldown. Reorged search anchors are discarded.
Discovered transactions undergo the same strict receipt/event/state checks as
wallet-returned hashes. A different transaction consuming that nonce fails closed.

Polling begins immediately, waits five seconds for the first three intervals,
then fifteen seconds, and after twenty checks backs off to sixty seconds.
Actual Retry-After headers take precedence. Polling stops on confirmed, failed or
retryable results, and cleanup ignores in-flight responses after unmount. All
reads still debit the existing provider/global budgets. Storage failure prevents
wallet dispatch. No manual transaction-history input or minute-long Check launch
button cooldown remains.

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

O1 has a separate API-only switch and profile: `O1_WALLET_LAUNCH`,
`O1_LAUNCH_PROFILE_JSON`, and `O1_LAUNCH_TOKENS_JSON`. Its native metadata call
also requires the existing server-only `O1_API_KEY`. The token list is an array of
reviewed `{symbol,address}` entries and is required for the configured Robinhood
RWA pairing set. `LONG_EXTRA_QUOTES_JSON` is optional; O1 selects only a reviewed
USDG record from it. No value from these settings enters the web or decoder runtime.

The O1 parser deliberately reuses the validated Long stock-token runtime hash
template and `LAUNCH_ASSET_SERVICE_ORIGIN`, so `LONG_LAUNCH_PROFILE_JSON` and
`LONG_LAUNCH_GUARDS_JSON` must also be valid. `O1_WALLET_LAUNCH=true` validates
those shared settings directly when Long is off; it leaves the Long handler
disabled unless `LONG_WALLET_LAUNCH` is independently `true`. Missing or malformed
shared settings reject startup with a fixed O1 configuration error. With the
switches off, dormant O1 settings are not parsed. `npm run runtime:status` reports
presence and switches under `o1_wallet_launch`; live RPC, contract, provider and
pair verification still occurs only in the bounded request path.

The portable encoder lives in `apps/web/lib/long-encoding`; the API imports it
through a wrapper that preserves API error handling. The web image includes no
API service source. API packaging includes only this portable encoding directory.
The integrated release also updates the existing asset service for Pinata's
canonical `/ipfs/{cid}` gateway URLs. Decoder and facilitator images need no change.
Exact legacy `/files/{cid}` browser recovery records are normalized to `/ipfs/{cid}`
without changing publication IDs, hashes, CIDs or wallet bindings. Both URLs must
match the recorded origin and CIDs; altered paths or queries remain rejected.
Recovery continues through the existing status endpoint without another signature.

`saltAttempt` is a required browser plan field for the canonical-address format. New
API journals also add a version, immutable publication CIDs and the selected guard;
these server recovery fields distinguish reconstructable rows from the explicit
legacy fallback. A new web build rejects plans from an old API, and an old web build
cannot reconstruct plans from a new API. Deploy the API and web from the same
reviewed Git revision in one
maintenance window: stop new launch preparation, confirm there is no wallet handoff
in progress, deploy both immediate-strategy single-Machine apps, verify each image
revision and health endpoint, then re-enable preparation. Do not use a rolling or
mixed-revision rollout for this format change. Existing journaled recovery must
remain served by the API throughout the window; do not reset or replace its volume.

New uploads use version-3 server-issued upload capabilities. They bind the exact
publication ID, wallet field, processed bytes, metadata and five-minute expiry.
The wallet field is unverified input in this mode, not proof of wallet ownership.
The wallet authenticates the actual deployment transaction. Origin checks do not
authenticate a caller. The existing global limits remain: six preparations per
minute, 60 per day, 30 publications per day, three per wallet field per day,
256 MiB reserved staging and 4,096 journal entries. Anonymous traffic can exhaust
these allowances, but cannot bypass the global publication budget.

An additive `ipfs_launch_admissions` table marks version-3 records. Legacy signed
records cannot be published through the capability endpoint. Their messages,
signatures and status recovery remain intact. Browser recovery persists an opaque
publication ID and hash of the original draft/image/wallet context before the
write; the upload capability stays in memory only. Lost responses use status
reads, never automatic publication retries. Artwork recovery and its source-byte
binding are stored under the normalized wallet's hash, so switching wallets cannot
attach or block on another wallet's artwork. Existing unscoped recovery is copied
only into its owner's storage, with read-back verification before any request;
the original is retained for older tabs. Returning to that wallet resumes its
saved publication. Transaction recovery follows the automatic nonce-bound flow above.
Polling continues through delayed
verification for up to 27 checks: five three-second intervals, then five-second
intervals (120 seconds of waiting). A timeout retains recovery without imposing
an extra minute-long button lock. A changed draft cannot use an earlier recovery's image.
The worker checks for due work every second, retains wakeups received during
another upload, and retries failed verification after 2, 5, 10, 30, then 60 seconds.
Provider budget cooldowns take precedence. Already verified objects are not fetched
again during another object's retry; uncertain uploads still use lookup only.
Gateway 401/403 responses surface a concise service-unavailable error immediately,
with recovery retained, rather than asking the user to wait for access to repair itself.
O1 retains its native pinning path. All listed Long, O1 and Longbow pairs are
eligible for draft selection. O1 catalog refreshes extend the saved choices and
do not lock them when missing or expired. Wallet transactions use dedicated Long
and O1 handlers with their configured server quotes. The Longbow wallet handler
is not configured by these settings.

Sources: [Robinhood network configuration](https://docs.robinhood.com/chain/connecting/),
[gas and fees](https://docs.robinhood.com/chain/gas-and-fees/),
[oracle behavior](https://docs.robinhood.com/chain/oracles-and-price-feeds/),
[Chainlink Robinhood feed directory](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json),
[Doppler deployment registry](https://github.com/whetstoneresearch/doppler/blob/main/Deployments.json),
[Sourcify verified contracts](https://sourcify.dev/).

Gateway format: [Pinata retrieving files](https://docs.pinata.cloud/gateways/retrieving-files).

The launch flow retries only preparation and errors proven to occur before wallet
dispatch. A pre-dispatch expired quote or service cooldown triggers a fresh quote
within the same user action, at most three preflight attempts. Once
`eth_sendTransaction` is invoked, rejection or a lost response never automatically
sends again. Wallet/account/draft changes or unmount cancel waiting work.
Preparation retries stop after six attempts per stage or a wait beyond the
three-minute flow deadline. Daily quota exhaustion remains an explicit error.
The shared upstream burst allowance is 180 reads/minute; the 16,000 total daily,
12,000 RPC daily, 600 O1 daily and three launch preparations/minute limits remain.
