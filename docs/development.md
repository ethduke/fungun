# Webview milestone

## Run locally

Use Node 22.13 or newer (Node 24 recommended).

```sh
npm run setup
npm run dev
```

Open http://127.0.0.1:3000 in a browser. Use a browser with Rabby or MetaMask
installed to test wallet connection; embedded browsers may have no injected wallet.

## Working controls

- Upload/drop a PNG, JPEG, WebP or GIF, preview and remove it. Files stay in memory.
- Enter name, ticker and optional description; review per-launchpad validation.
- Ticker edits auto-fill the coin name unless a custom name has been entered.
- Choose one chain: Robinhood (default) offers Long and O1; Base offers O1.
- Select launchpads and pairings. Changing chains clears incompatible selections.
- Choose clearly labeled sample stock symbols; these are not a live RWA catalog.
- The inline launch section updates coin details, destinations and draft validation as you edit.
- Image checks show an inline loading state; O1's metadata-update toggle stays in the launch section.
- Open the Grok/x402 flow preview; no image generation or payment occurs.
- Explicitly connect/disconnect a discovered EIP-6963 wallet using wagmi/viem.
- Open FEE from the header: one payout-coin table, no console tabs.
- FEE follows the connected account or a manually entered address after a 500 ms debounce.

Fee reads and claims remain a local scaffold: missing integrations show unknown
balances, never fabricated zero balances. No address is sent to a backend,
stored in browser storage, or added to a URL. Wallet connection stays mounted
when navigating between Launch and FEE; disconnecting clears the automatic address.
The launch draft and uploaded image also survive navigation in layout-owned memory;
refreshing or closing the page clears them. Nothing is persisted to disk.

Live integration needs a guarded backend for the source readers and a separately
verified claim builder. O1 fee positions are shared escrow balances by payout
asset, not per-token lifetime revenue. Long's reader covers locked-LP fees only;
custom-hook payouts remain unknown. Group by chain and asset identity, with a
launchpad breakdown, never by ticker alone. Claims must verify the connected
beneficiary, chain, fresh amount and target contract before wallet simulation
and explicit user approval. The existing read-only `collectFees` simulation
must not be reused as a claim transaction.

## Deliberately disabled

No signing, transactions, paid generation, live quotes, ticker requests, balance
reads, block subscriptions, RPC proxy, or server upload endpoint is implemented.
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
ticker. It cannot connect wallets, transmit images, sign, pay, or launch.
It has not been exercised in a WebMCP-enabled browser. Real wallet-extension
interaction and visual/browser-click QA remain for the user's review.

Lint covers owned application code. Generated UI primitives are left unchanged
and excluded from lint; TypeScript still checks them.

## Fly backend: next milestone

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
