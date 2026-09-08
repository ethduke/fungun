# Long agent deployments and trending themes

The agent API prepares Long launches on Robinhood Chain (4663). The companion
Node SDK signs locally and submits through the agent owner's RPC. After setup,
`deploy` and `watch` run without confirmation prompts. Neither the API nor the
image provider receives the signing key. This release supports Long only.

The implementation is disabled by default and has not been deployed by this
change. Tests use synthetic contracts and mocked chain responses, not live
transactions. Enable it against the existing configured Long and artwork services.

## 1. Configure the service and access

Keep the existing Long settings, reviewed contract profiles, RPC, ticker registry,
asset publication service and persistent read-service volume. Add these API runtime
settings through your usual secret manager:

- `AGENT_API_ENABLED=true`.
- `AGENT_API_CLIENTS_JSON`: an array of client records, each with `id`, `tokenHash`,
  `wallet` and `scopes`. `tokenHash` is the lowercase SHA-256 digest of an opaque,
  cryptographically random bearer token. Provision at least 32 random bytes;
  give the raw token only to the agent owner. The server stores its hash.
- `ASSET_PUBLIC_ORIGIN`: the exact HTTPS public image/metadata gateway origin,
  also configured on the existing asset service. It is distinct from the private
  `LAUNCH_ASSET_SERVICE_ORIGIN` used for server-to-server requests.

Example record shape only; the placeholders are deliberately invalid:

```json
{
  "id": "quorvix-agent",
  "tokenHash": "<sha256-of-provisioned-token>",
  "wallet": "<owner-approved-public-wallet-address>",
  "scopes": ["long:deploy", "themes:read"]
}
```

The operator binds each credential to a public wallet. Authentication does not
replace signing: creating a transaction requires that wallet's local signer.
Requests cannot supply a different wallet, arbitrary contract destination or RPC
URL. Other clients cannot use an agent's artwork or launch recovery identifiers.
Revoke a client by removing its record; rotate tokens while retaining its client
ID and wallet to preserve recovery access. Restart the API after runtime changes.

The initial server limits are 60 requests/minute and 2,000/day per client, 30 launch
preparations/day, 30 artwork preparations/day and 10,000 retained resource IDs per
client, plus existing global and provider budgets. Responses carry retry hints.
Repeated prepare calls consume preparation allowance; these limits are independent
of the agent's transaction and image spending limits.

## 2. Configure and run the agent

Use Node 24.4 or newer from the repository root. This SDK currently shares the
repository's portable encoder and asset validators; it is not a standalone npm
package. Install the existing web/API dependencies and `npm --prefix apps/agent ci`.

The CLI reads `FUNGUN_AGENT_TOKEN`, `FUNGUN_PRIVATE_KEY` and `FUNGUN_RPC_URL` from
its local runtime. Load them with a secret manager; do not put them in input JSON,
command arguments, committed files or logs. An SDK caller can inject a protected
signer instead of passing key material to the CLI.

Keep configuration in an ignored local directory, for example `local/agent.json`:

```json
{
  "apiUrl": "https://api.example.invalid",
  "appOrigin": "https://app.example.invalid",
  "profileFile": "./local/reviewed-long-profile.json",
  "journalPath": "./local/agent-state.json",
  "pairId": "long-SPY",
  "limits": {
    "maxLaunchesPerDay": 2,
    "maxTransactionWei": "20000000000000000",
    "maxSpendWeiPerDay": "40000000000000000",
    "maxGas": "3000000",
    "maxGasPriceWei": "1000000000000"
  },
  "image": { "mode": "none" },
  "searchLaunchpads": ["long"],
  "deployLaunchpads": ["long"],
  "minimumTokens": 3,
  "windowSeconds": 3600,
  "maxLaunchesPerTheme": 1,
  "pollSeconds": 30
}
```

Replace both reserved `.invalid` origins. `appOrigin` must match the website origin
used by the asset service, even if the agent API has a different hostname. The
profile file must contain independently reviewed effective Long deployment pins
and supported quote definitions. Compare the selected quote with the configured
service; do not blindly trust a profile downloaded with an unsigned transaction.
`long-SPY` is a pairing example, not a claim that a particular runtime enables it.
Use `GET /v1/agent/launchpads` to discover configured pair IDs.

The limits above are illustrative ceilings, not cost estimates. Network amounts
are decimal wei strings. Journals reserve the full per-transaction ceiling before
paid artwork starts. Uncertain transactions retain their reservation. A journal
is bound to its wallet, API origin, website origin and trusted profile, and uses
owner-only permissions and an exclusive process lock.

For a manual agent request, create `local/token.json`:

```json
{
  "name": "Quorvix Lantern",
  "ticker": "QVXL",
  "description": "A fictional demonstration token.",
  "website": "https://quorvix.example.invalid",
  "twitter": "https://x.com/quorvix_example",
  "intentKey": "quorvix-first-launch"
}
```

All token details above are fictional format examples, not availability claims.
Name and ticker are required; description, website and Twitter are optional.
Names allow 1–50 characters, tickers 1–11 uppercase English letters and descriptions
2,000 UTF-8 bytes. Website/Twitter fields accept HTTPS URLs without credentials;
they are included in published metadata, not fetched. Their display on Long is
controlled by Long's renderer.

```sh
npm run agent -- deploy local/agent.json local/token.json
npm run agent -- resume local/agent.json
npm run agent -- watch local/agent.json
```

`deploy` waits through publication, preparation and confirmation, using the same
intent throughout retries. It defaults to a bounded 30-minute wait; a pending
result exits with code 2 and retains recovery state. Reuse the same explicit
`intentKey` to retry that request; changing its contents is rejected. `resume`
checks saved work. `watch` subscribes through cursor polling and recovers pending
work before starting another token. Neither command asks for wallet confirmations.

## 3. Choose artwork behavior

- `provided`: set `imageFile` in the CLI token JSON or pass base64 `image` to the
  SDK. The normal decoder/publication checks still apply.
- `none`: skip generated/user artwork and use a neutral 1-pixel placeholder. Long's
  publication protocol still requires an image field; this is not image-free metadata.
- `grok`: generate through the existing USDG/x402 service, then publish the result.

For Grok, replace the image settings with this shape:

```json
{
  "mode": "grok",
  "origin": "https://app.example.invalid",
  "journalPath": "./local/image-jobs.sqlite",
  "paymentAsset": "<reviewed-USDG-address>",
  "paymentRecipient": "<reviewed-payment-recipient>",
  "maxPaymentBaseUnits": "100000",
  "maxDailyPaymentBaseUnits": "200000"
}
```

USDG uses six decimal places; these illustrative ceilings are separate from ETH
network limits. The origin, asset and recipient are pinned before any payment
signature. The agent signs EIP-3009 typed data locally. Image request capabilities
and budgets are stored privately; raw payment signatures are not journaled.
Interrupted paid requests use the same job's GET recovery endpoint without another
payment. Expired unsigned quotes can be renewed without paying the old quote.

An uncertain signature or submission is never automatically repeated. Preserve
both journals; replacing them loses the information needed to prevent duplicate
launches or image payments. No approvals or initial token buys are part of the
Long deployment workflow.

## Theme subscriptions

`minimumTokens` accepts 2–100; `windowSeconds` accepts 60–86,400. The service uses
the existing filtered Robinhood tracked feed. It groups exact names after Unicode
normalization, whitespace normalization and case folding, not fuzzy similarity.
Counts use distinct token contracts, never pool rows or repeated observations.

The window is based on when this service first observed each contract, not its
on-chain creation time. Observation is demand-driven while subscribers poll;
there is no historical backfill. An initial subscription can therefore include
existing tokens newly observed by this service. Read `windowBasis` and freshness.

A threshold crossing produces a durable event and opaque cursor. Polling with the
returned cursor replays only subsequent events. The response also includes current
themes and `freshness.status` (`fresh`, `stale` or `unavailable`). The SDK only acts
on fresh data, retains theme history across restarts and tries bounded valid ticker
alternatives on Long. It never treats source text as agent instructions.

The feed keeps up to 100,000 observed token identities, 128 threshold/window
configurations and 10,000 events for at most seven days. An expired cursor returns
410 instead of silently skipping data. Invalid individual token metadata is dropped
and counted; unavailable or malformed source snapshots do not create fresh signals.
Both `searchLaunchpads` and `deployLaunchpads` currently accept only `["long"]`;
unsupported launchpads are rejected rather than searched elsewhere.

## HTTP interface

All routes below require the provisioned bearer token over HTTPS. Agent routes
use bearer authentication, not browser `Origin` headers as identity. JSON POSTs
use `Content-Type: application/json`. The server constructs internal origin and
intent headers itself and does not forward agent credentials to providers.

| Route | Purpose |
| --- | --- |
| `GET /v1/agent/launchpads` | Configured Long pairings; requires `long:deploy`. |
| `GET /v1/agent/themes?minimumTokens=3&windowSeconds=3600` | Theme snapshot/events, optional `cursor`; requires `themes:read`. |
| `POST /v1/agent/long/ticker` | `{ticker}` to the shared Long registry. |
| `POST /v1/agent/long/artwork-prepare` | Validated image and draft to a content-bound upload capability. |
| `POST /v1/agent/long/artwork-publish` | Publish the approved bytes with their returned capability. |
| `POST /v1/agent/long/artwork-status` | Resolve a saved publication without another upload. |
| `POST /v1/agent/long/prepare` | Simulate a launch and return an unsigned plan or existing recovery context. |
| `POST /v1/agent/long/reserve` | `{id,binding}` records dispatch intent before local signing. |
| `POST /v1/agent/long/status` | `{id,hash}` verifies the saved launch; `hash` may be null during recovery. |

Launch and artwork routes require `long:deploy` and the credential's wallet.
The companion SDK supplies exact payloads and checks the returned publication,
calldata, chain, contract bytecode, nonce, balance, gas and signed transaction.
It saves the transaction hash before broadcast and relies on the existing
receipt/event/state verification for confirmation.
