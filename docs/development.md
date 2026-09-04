# Webview milestone

## Run locally

Use Node 24.4 or newer for the combined webview and backend.

```sh
npm run setup
npm run dev
```

Open http://127.0.0.1:3000 in a browser. Use a browser with Rabby or MetaMask
installed to test wallet connection; embedded browsers may have no injected wallet.
Run `npm run dev:api` in a second terminal for the read service. See
[read-service setup and limits](read-service.md); external reads default to disabled.

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
  pending uploads so another token's image cannot carry over. The current public
  source supplies no token image or metadata URL; artwork must be uploaded separately.
- Upload/drop a PNG, JPEG, WebP or GIF, preview and remove it. Files stay in memory.
- Enter name, ticker and optional description; review per-launchpad validation.
- Ticker edits auto-fill the coin name unless a custom name has been entered.
- Choose one chain: Robinhood (default) offers Long and O1; Base offers O1.
- Select launchpads and pairings. Changing chains clears incompatible selections.
- Load per-chain Long/O1 catalogs when the backend is configured; otherwise samples
  remain labeled. Refresh is explicit; no periodic background calls.
- Check Long ticker reservations on click; O1 availability remains unverified.
- The inline launch section updates coin details, destinations and draft validation as you edit.
- Image checks show an inline loading state; O1's metadata-update toggle stays in the launch section.
- Open the Grok/x402 flow preview; no image generation or payment occurs.
  The [server-side memecoin prompt scaffold](image-generation.md) prepares one square
  image with ticker/name context; it is not connected to paid generation yet.
- Explicitly connect/disconnect a discovered EIP-6963 wallet using wagmi/viem.
- Open FEE from the header: one payout-coin table, no console tabs.
- FEE follows the connected account or a manually entered address after a 500 ms debounce.

Fee reads and wallet claims are implemented behind runtime configuration; see
[fee setup and coverage](fee-claims.md). Missing integrations show unknown balances,
never fabricated zero balances. Lookup addresses are sent to the fee backend and
providers, not stored in browser storage or added to the browser URL. Wallet connection stays mounted
when navigating between Launch and FEE; disconnecting clears the automatic address.
The launch draft and uploaded image also survive navigation in layout-owned memory;
refreshing or closing the page clears them. Nothing is persisted to disk.

O1 fee positions are shared escrow balances by payout
asset, not per-token lifetime revenue. Long's reader covers locked-LP fees only;
custom-hook payouts remain unknown. Group by chain and asset identity, with a
launchpad breakdown, never by ticker alone. Claims must verify the connected
beneficiary, chain, fresh amount and target contract before wallet simulation
and explicit user approval. Verified Long manager source confirms that direct
`collectFees` pays the caller's beneficiary share. Its simulation return values
are pool-wide, not the caller's payout; confirmed payouts require `Release` events.

## Deliberately disabled

No server signing, launch transactions, paid generation, live launch quotes, block
subscriptions, arbitrary RPC proxy, or server upload endpoint is implemented.
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
npm run typecheck
npm run build
npm run check:tracked
npm run check:history
```

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
