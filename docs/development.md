# Webview milestone

## Run locally

Use Node 24.4 or newer for the combined webview and backend.

```sh
npm run setup
npm run dev
```

Open http://127.0.0.1:3000 in a browser. Use a browser with Rabby or MetaMask
installed to test wallet connection; embedded browsers may have no injected wallet.
The development launcher waits for the read service before starting the web app
and stops both services together. `npm run dev:web` and `npm run dev:api` remain
available for isolated debugging. See [read-service setup and limits](read-service.md);
external reads default to disabled.

## Working controls

- The top market feed shows the source's Robinhood ETH and SHARES pairs together,
  fetched through same-origin `GET /api/tracked-feed` four seconds after each
  completed request while visible and online. Polling pauses when the tab is hidden,
  the feed is offscreen, the browser is offline, or the component disconnects.
  It uses the public `https://rh-monitor.fly.dev/api` source without credentials
  and makes no calls to `ROBINHOOD_RPC`. A four-second server cache and shared
  in-flight request serve all viewers in each process/Worker isolate. Failures back
  off from four to sixty seconds and honor longer `Retry-After` delays, capped at
  five minutes. Visibility changes preserve the next retry deadline.
  Each lane preserves source order and scrolls through all returned
  pairs. Reconnecting retains the last successful rows; an empty successful
  response clears them. Cached responses retain the original receipt time; it is
  not a per-token valuation timestamp.
- Popularity groups count similarly named distinct contracts in this selected
  feed, deduplicated by chain and token and ranked by count then inflow. They
  refresh on every response. Other chains are excluded from this tracker.
- Launchpad labels are compact: Long, O1, O1 RWA, UniV3 and UniV4. Exact O1
  hook matches come from the official current and historical
  [suite registry](https://docs.o1.exchange/launchpad/reference/launch-contract-suites.json),
  cached server-side for 24 hours with shared reads, a two-second timeout and
  a five-minute failure cooldown. Existing historical matches survive registry
  outages. This adds no RPC calls or per-token lookups. Pool version labels come
  from the feed; unidentified hooks retain an explanatory tooltip. O1 Mig.
  requires an explicit upstream migration label. An older suite or a quote token
  such as USDG does not establish migration or launchpad provenance.
- Canonical stablecoins are excluded when they occupy the tracked-token side,
  including stable/stable and USDG/stock rows. Nonstable launch tokens merely
  quoted in a stablecoin remain eligible under the feed's quote-kind filters.
  Address matching uses the official production asset snapshot, cached daily;
  token names and tickers cannot trigger exclusions. Filtering precedes cards,
  counts and popularity. Currently the Robinhood registry lists canonical USDG.
- Below popular tokens, a single row links up to ten tickers to GMGN after their
  reported total inflow exceeds 10 ETH-equivalent. It uses the existing filtered
  snapshots with no additional requests. Tokens enter once per contract in the
  current view, oldest on the left; a new arrival evicts the oldest beyond ten.
  Repeated snapshots, duplicate pools and metadata updates do not change arrival
  order. The largest reported pool total is used, without adding pools together.
  Entries survive feed gaps until evicted; reloading starts a new queue, and the
  first snapshot uses feed order rather than claiming historical crossing times.
- COPY transfers the selected token's name and ticker into the launch form and
  jumps to the coin details immediately. It clears old artwork and invalidates
  pending uploads so another token's image cannot carry over. On this test branch,
  recognized Robinhood O1 rows also fetch artwork through O1's API after COPY.
  Other launchpads still need a separate image. See [the O1 experiment](o1-copy-image-test.md).
- Upload/drop a PNG, JPEG, WebP or GIF, preview and remove it. Picture bytes are cached in IndexedDB with the draft.
- Enter name, ticker and optional description; review per-launchpad validation.
- Ticker edits auto-fill the coin name unless a custom name has been entered.
- Robinhood offers Long, O1 and Longbow. Base offers O1 with ETH and its live
  registered stock pairings, plus Stonks Exchange with 13 reviewed stock pairs. Changing chains resets incompatible pairings and
  separates pending-launch recovery. Base launch configuration is documented in
  [O1 Base launch setup](o1-base-launch.md) and [Stonks Base setup](stonks-base-launch.md).
  Stonks creator-fee reads and claims are supported; O1 Base fee lookups remain paused.
- Select launchpads and pairings; Longbow starts unselected.
- Long uses a static list of 64 market tickers supplied on 4 September 2026.
  Longbow uses its 194-entry dropdown registry snapshot from 2 September,
  checked on 4 September, with SKYHY corrected to the verified symbol SKHY.
  Only ticker choices are bundled; runtime addresses stay out of source control.
  O1 offers ETH and a complete saved 194-entry Robinhood RWA catalog, verified
  4 September 2026. Live results replace the saved list; opening an expired
  menu checks availability again. No refresh button or periodic background calls.
- Long and Longbow check their shared ticker reservation registry after a typing
  pause, on focus, or on Enter. Selecting both uses one read. O1 says any ticker
  is allowed and makes no reservation request. Longbow's separate fee adapter
  supports reviewed locked pools on Robinhood.
- Longbow's fee row shows the default LongLauncher route's 95% creator / 5%
  Doppler LP-fee split. Its details distinguish separate hook fees, the 1% launch
  supply allocation, and alternate routes. Sources: [default launch route](https://longbow.gg/launch?route=long)
  and [published fee constants](https://longbow.gg/ref_constants.js), checked 4 September 2026.
- The inline launch section updates coin details, destinations and draft validation as you edit.
- Image checks show an inline loading state; O1's metadata-update toggle stays in the launch section.
- Review a Grok/x402 USDG quote, authorize one image in the wallet, and recover its saved result. Requires [image runtime setup](image-generation.md).
  The [server-side memecoin prompt scaffold](image-generation.md) prepares one square
  image with ticker/name context through the configured paid generation flow.
- Explicitly connect/disconnect a discovered EIP-6963 wallet using wagmi/viem.
- Open FEES from the header: one balance card and Claim all action per launchpad.
- FEE shows fees only for the connected wallet; while disconnected, it shows “Connect your wallet to show fees.” without making fee lookups.

Fee reads and wallet claims are implemented behind runtime configuration; see
[fee setup and coverage](fee-claims.md). Missing integrations show unknown balances,
never fabricated zero balances. Lookup addresses are sent to the fee backend and
providers, not stored in browser storage or added to the browser URL. Wallet connection stays mounted
when navigating between Launch and FEE; switching accounts or disconnecting clears displayed fees.
The launch draft and image survive navigation and reloads through IndexedDB.
Published metadata is bound to the exact draft; payment recovery is stored separately.

O1 fee positions are shared escrow balances by payout
asset, not per-token lifetime revenue. O1 wallet-index pages are resumable, and
every approved current escrow position can receive a live balance check. Long's
reader discovers beneficiary event history or pages through configured pools;
it covers locked-LP fees only;
custom-hook payouts remain unknown. Group by chain and asset identity, with a
launchpad breakdown, never by ticker alone. Claims must verify the connected
beneficiary, chain, fresh amount and target contract before wallet simulation
and explicit user approval. Verified Long manager source confirms that direct
`collectFees` pays the caller's beneficiary share. Its simulation return values
are pool-wide, not the caller's payout; confirmed payouts require `Release` events.

## Deliberately disabled

No server signing, launch transactions, live launch quotes, block subscriptions,
or arbitrary RPC proxy is implemented. Asset publication and USDG/x402 image jobs
are available behind their runtime configuration flags.
Configured fee adapters can read balances and prepare explicitly approved wallet
claims; the browser never automatically signs, submits or retries a claim.
The read service implements guarded catalogs and Long reservation checks, off
until runtime credentials and verified contract identity are configured.
WalletConnect QR support requires a later opt-in relay configuration. No wallet
state is persisted by the app; wallet integration is loaded only after a click.
The extension itself may make network requests after the user connects.

Long supports Robinhood Chain and RWA pairing, uppercase tickers, and permanent
metadata. O1 supports Robinhood Chain or Base, standard or RWA pairing, and optional
metadata updates. Both share a 50-character name, 11-character ticker, 2,000-byte
description and 2 MiB image limit. No initial-buy control is modeled.

The reference adapters use fixed creator identities and server signing. Neither
is copied. Their transaction builders must be generalized and verified before
execution is enabled. Shared branding does not imply a shared token contract.

## Checks

```sh
npm test
npm run test:mocked
npm run typecheck
npm run build
npm run check:tracked
npm run check:history
```

### Pull-request CI and required checks

`.github/workflows/webview-checks.yml` uses GitHub-hosted Linux runners. The
`webview` check installs locked dependencies, runs the existing synthetic launch,
wallet and payment suites in a read-only container with no external network,
then runs the complete application/facilitator suites, TypeScript, lint, the
Worker preview build and dependency audits. `npm run test:mocked` also runs those
focused suites locally, without container isolation. HTTP fixtures use loopback;
RPC, asset providers and x402 settlement use mocks. Signing fixtures use synthetic
accounts only. Local captures and environment files are never needed for CI.

The separate `production-build` check builds the existing web and API Dockerfiles
without publishing or deploying. The web Dockerfile runs `build:fly`, validating
the standalone Node target independently of the Worker preview build. Its final
image starts with no external network and must serve `/healthz`, `/`, `/fees` and
`/llms.txt`; `scripts/smoke-production-web.mjs` checks actual HTTP responses.
No workflow secrets or real wallet/provider credentials are required. Superseded
runs for the same PR or branch are cancelled.

To require these checks before merging:

1. Push the workflow changes and let them run on a PR so GitHub can discover the
   check names.
2. In the repository's **Settings → Rules → Rulesets**, create a **New branch
   ruleset**, target the **default branch**, and set enforcement to **Active**.
3. Enable **Require a pull request before merging** and **Require status checks
   to pass**, adding `webview`, `production-build` and `repository-safety` from
   GitHub Actions. These are job names, not workflow or step names.
4. Enable **Require branches to be up to date before merging** and leave the
   bypass list empty to enforce the checks for administrators too.
5. Save the rule and verify that a deliberately failing test blocks a PR merge.

An existing branch protection rule can require the same three checks instead.
Rulesets for private repositories require GitHub Pro, Team or Enterprise; public
repositories support them on GitHub Free. See the official [ruleset setup](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).
This step does not configure a merge queue or change GitHub repository settings.

The optional browser WebMCP surface can read a redacted draft or stage a name and
ticker. It cannot trigger ticker checks, connect wallets, transmit images, sign,
pay, or launch. Setting identity does not initiate an upstream request.
It has not been exercised in a WebMCP-enabled browser. Real wallet-extension
interaction and visual/browser-click QA remain for the user's review.

Lint covers owned application code. Generated UI primitives are left unchanged
and excluded from lint; TypeScript still checks them.

## Fly backend: implemented read boundary and remaining work

The guarded read service and Fly packaging are implemented in `apps/api`;
[read-service notes](read-service.md) describe exact current limits and setup.
The constraints below also apply to later fee, launch and paid-image adapters.

Serve narrowly scoped application endpoints, never arbitrary RPC methods,
addresses, calldata, upstream URLs, or user-supplied forwarding headers.

- Load catalogs server-side with shared TTL caches, request coalescing and a
  bounded refresh cadence. Validate identifiers against protocol/chain allowlists.
- Check normalized tickers only on explicit intent; cache per pad/chain/ticker,
  deduplicate concurrent checks, and revalidate once before a wallet review.
- Batch approved read calls where supported. Avoid balance/block polling; use
  bounded receipt checks only for transactions the current session initiated.
- Enforce durable per-session/IP and global limits, request/body caps, concurrency
  limits, timeouts and daily upstream budgets. Return 429 with Retry-After.
- Origin restrictions are defense-in-depth, not authentication. Use one-time
  intent IDs and server-side authorization for expensive work. Enforce controls
  across all Fly instances; an in-memory limiter alone is insufficient.
- Keep provider secrets in Fly runtime secrets, never public browser variables.
  Redact authorization/payment headers and request bodies from all logs/traces.
- Bind image payment IDs to request fingerprints, reconcile uncertain settlements
  before retrying, and never charge twice for the same logical job.

No Fly app or public website has been deployed for this milestone.

For a later backend deployment, attach an API hostname using `fly certs add
api.example.com -a YOUR_APP`, install the exact DNS records from `fly certs setup`,
then verify with `fly certs check`. Do not change existing DNS until the app works.

The [FOMO purchase strip](fomo-tracking.md) tracks the configured traders against
persisted Stream contracts, including while no browser is open. It uses one
server-side WebSocket and a cached API; configure its key only in the read service.
