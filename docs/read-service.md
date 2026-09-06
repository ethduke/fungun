# Read-service milestone

The webview now calls a separate Node service for catalogs and explicit ticker
checks. External reads are off by default. Long reservation reads and authenticated
O1 catalogs were verified locally on 4 September 2026; Fly deployment remains
pending. No provider credentials were copied from the reference project.

## Local setup

Use Node 24.4 or newer. Run `npm run setup`, then `npm run dev`. The launcher
starts the local read service, waits for `/healthz`, starts the web app, and stops
both if either exits. `npm run dev:web` and `npm run dev:api` are retained for
isolated debugging. The webview remains at http://127.0.0.1:3000; its development
proxy forwards `/api/catalog`, `/api/ticker`, `/api/fees`, `/api/claim-prepare` and
`/api/tracked-prices` plus the three `/api/launch-*` operations to the local service
on port 8787. An unavailable local
service produces a retryable JSON 503 rather than an opaque proxy 502. The public market feed's
`GET /api/tracked-feed` route runs in the web server. SQLite runtime files live in ignored
`apps/api/local/`; never delete them to reset a spent quota.

An ignored root `.env` can hold backend runtime configuration. The local API
launcher forwards only its allowlisted settings, excluding wallet signing keys
and unrelated credentials; see [runtime secret handling](runtime-secrets.md).
Leave the committed
`.env.example` blank. `READ_UPSTREAMS=true` is the explicit opt-in to provider reads:

- `O1_API_KEY`: server-only O1 catalog access with `config:read` scope. The upstream origin is fixed in code.
- `LONG_RWA_ALLOWLIST`: comma-separated runtime token addresses verified against
  Long's supported stock/oracle configuration. Long intersects the shared O1
  catalog by address; ticker labels alone do not establish eligibility.
- `ROBINHOOD_RPC` (legacy alias: `ROBINHOOD_RPC_URL`), `LONG_TICKER_REGISTRY_ADDRESS`,
  `LONG_TICKER_REGISTRY_CODE_HASH`: server-only RPC configuration and independently
  verified deployed Long registry identity. Do not copy addresses into source/tests.
- `APP_ORIGIN`: exact web origin; defaults to the local URL above.
- `READ_SERVICE_PORT`: local API listening port, default 8787. Local ports must be
  integers from 1024 to 65535; production keeps port 8787.
- `READ_SERVICE_ORIGIN`: deployed web server's canonical HTTPS API destination;
  local development does not use it. For an isolated worktree, choose a different
  web port, set `APP_ORIGIN` to that exact loopback HTTP origin, and choose a distinct
  `READ_SERVICE_PORT`. Keep the shared `BUDGET_DB_PATH` when the worktrees use the
  same providers so quotas persist.
- `LONG_WALLET_LAUNCH`, `LONG_LAUNCH_PROFILE_JSON`, `LONG_LAUNCH_GUARDS_JSON`,
  `LAUNCH_ASSET_SERVICE_ORIGIN`: API-only ordinary Long wallet-launch settings.
  The launch path stays disabled unless the switch is exactly `true`, provider reads
  are enabled and all profile, guard, asset-service and RPC checks pass. See
  [Long wallet launch](long-wallet-launch.md).
- `O1_WALLET_LAUNCH`, `O1_LAUNCH_PROFILE_JSON`, `O1_LAUNCH_TOKENS_JSON`,
  `LONG_EXTRA_QUOTES_JSON`: API-only O1 wallet-launch settings. O1 also requires
  `O1_API_KEY`, the RPC, and the validated Long profile, guard and asset-origin
  settings above. Its switch is independent: O1 can validate those shared pins
  while `LONG_WALLET_LAUNCH=false`, and doing so does not enable Long. The token
  list supplies reviewed Robinhood RWA addresses; extra quote records are optional
  and only a reviewed USDG entry is selected by O1.

Run `npm run runtime:status` to list missing variable names and disabled features
without printing their values. It performs no network calls or file writes.
`needs_live_verification` means configuration is present, not that credentials,
contract identities, API scopes or balances have been verified. A zero exit code
only means the report was produced; it is not a deployment or execution gate.
An empty optional `FEE_CONTRACTS_JSON` is treated as no configured fee contracts.
The `tracked_prices` row requires both `READ_UPSTREAMS=true` and a configured
`ROBINHOOD_RPC`; its endpoint returns 503 while either requirement is unavailable,
never a successful empty-price response.
The `o1_wallet_launch` row reports the dedicated O1 settings and the shared Long
pins without printing any value. It treats the RWA token list as a readiness
requirement; an optional `LONG_EXTRA_QUOTES_JSON` entry is not required for native
or stock-paired launches.

## Local verification completed

The reviewed LongLauncher source identity was matched to its verified, nonproxy
deployment. Four read-only `cast` operations checked chain ID, captured a block,
matched runtime bytecode to the reviewed pin, and decoded a reservation lookup at
that same block. The web-to-backend ticker path then passed an HTTP smoke check.
Only local catalog/ticker reads were opted in. The user-configured O1 key passed
the authenticated Robinhood catalog check. The running web-to-API path then
returned 194 Robinhood and 10 Base RWA pairings. These are observed counts, not
fixed expected counts or launch approval. An earlier Base request was throttled;
no immediate retry was sent and a later explicit check succeeded.
Wallet claims, Long wallet launch and payments remained disabled in the observed
runtime; this catalog verification did not exercise them. Registry identities and
the RPC endpoint stay in the ignored local environment, never this document. This
proves a reservation read works, not global uniqueness or launch readiness.

With the local webview and API running, `npm run verify:catalog:local -- 4663`
checks Robinhood; use `8453` for Base. Each explicit command makes one local HTTP
request through the real web proxy, validates the browser response shape, and
prints only statuses and pair counts. It does not read `.env`, print pair data,
retry, bypass the API's cache/quota, or change feature switches. A ready O1 catalog
can pass while Long remains unavailable. Throttling returns a retry delay and a
nonzero exit code; wait before requesting another check. These checks do not
verify fees, ticker uniqueness, contract execution or wallet claims.

Before enabling Long checks, verify chain ID, target code hash, ABI and whether
the target is a proxy using read-only `cast` against the configured RPC. The current
pin assumes a directly deployed registry; proxy implementation verification is
not implemented, so do not configure an upgradeable proxy. Configuration is not
proof of correctness. The UI never turns a reservation result into launch approval.

## Read contract

The browser sends same-origin JSON POSTs with `x-fungun-intent` equal to the operation:

- `/api/catalog`: `{ "chainId": 4663 }` or chain 8453. Backend route: `/v1/catalog`.
- `/api/ticker`: `{ "chainId": 4663, "ticker": "MOON", "pads": ["long", "o1"] }`.
  Backend route: `/v1/ticker`. Unsupported chains/pads, extra fields and malformed
  tickers are rejected. O1-only tickers keep their case; Long requires uppercase A–Z.
- `/api/launch-prepare`, `/api/launch-reserve` and `/api/launch-status`: exact,
  operation-specific ordinary Long requests described in
  [Long wallet launch](long-wallet-launch.md). They accept no RPC method, URL,
  signature, calldata or signing-key override.

The catalog/ticker routes above are bounded anonymous reads, not authenticated financial operations. Origin
and intent headers deter browser cross-site requests; direct clients can forge them.
No arbitrary URL, address, method, calldata, cookie, signature or forwarding-header
parameter is accepted. Wallet addresses, images and prompts are not sent by these reads.

Catalog results contain opaque pair IDs and symbols, not operational addresses.
The O1 request includes chain, suite and quote sections in one call. The parser
checks the requested chain, a block-tagged snapshot, active Base asset capability,
and each selectable RWA's creation-enabled suite. Paused or unsupported creation
is unavailable, not an empty successful catalog. These are provider-reported read
checks, not independent contract verification or launch authorization.
Missing configuration or upstream failure means unavailable, never an empty success.
An actual valid empty catalog is represented separately. The complete 194-entry
Robinhood snapshot replaces preview samples and remains browsable when reads are
unavailable or expired. Its saved date is shown in the menu; it cannot stand in
for fresh eligibility. Opening an expired menu checks again without a refresh
button or background retries. See [the full pair list](o1-pairings.md).

Long checks only its reservation registry, not global ticker uniqueness. Code and
`eth_call` are read at the same explicit block; the chain is checked and runtime
bytecode must match the configured hash. O1 has no verified availability adapter.
All results are advisory and can change before a transaction.

## Cost and abuse bounds

- The public market feed is independent of the RPC service: it makes zero calls
  to `ROBINHOOD_RPC`, including when copying a token into the launch form. Its
  web route caches each successful snapshot for four seconds and coalesces
  concurrent refreshes per server process/Worker isolate. There is no background
  server polling. An already-started refresh may finish after its viewers leave;
  it has an eight-second timeout and is registered with the Worker request lifetime.
  Failed refreshes share a four-to-sixty-second exponential cooldown, honoring
  longer upstream `Retry-After` values up to five minutes. Browser requests wait
  four seconds after completion, pause while hidden/offscreen/offline/disconnected,
  and retain retry deadlines across pauses. These bounds are not a distributed
  quota across isolates and do not control the public source's internal RPC usage.
- O1 labels use a separate fixed public contract-suite registry, shared and cached
  for 24 hours per process/Worker isolate. Reads start only with a feed refresh,
  have a two-second timeout and a 64 KiB body limit, and failures wait five minutes
  before retrying. Previously recognized historical hooks remain available during
  outages. Registry failure never prevents the market feed from loading. No RPC
  enrichment, per-token requests or runtime addresses are added to source control.
- Stablecoin exclusions use the official production asset snapshot through the
  same daily-cache, coalescing, timeout, size-limit and failure-cooldown policy.
  The last valid address set survives registry outages. Without an initial valid
  set, feed reads pause for five minutes rather than serving unfiltered rows.
  This adds one daily public HTTP registry read per active isolate, with zero RPC
  calls; it does not change tracking performed inside the external feed service.
- One shared catalog per chain, cached five minutes, with concurrent reads coalesced.
  Each live RWA catalog attempt consumes 20 durable O1 units, including failures;
  the existing 600-unit daily O1 cap permits at most 30 uncached catalogs if no
  other O1 operations consume units. No budget was raised for this change.
  Provider 429 responses preserve bounded `Retry-After` delays in the shared cache
  and pause all new requests to that provider before another quota debit.
- Ticker responses cached 15 seconds; no automatic polling/retries. Failed reads back
  off at least 15 seconds. Chain checks cache five minutes; block reads five seconds;
  code checks are cached by block. A cold Long check needs four RPC methods; another
  ticker at the same cached block needs only its `eth_call`.
- Browser freshness uses response-relative, monotonic time, not synchronized clocks.
  Edits discard mismatched results; explicit rechecks clear old successes. Expiration
  only updates labels; it never automatically sends another request.
- Every upstream attempt is debited before the request, even on timeout/failure.
  SQLite transactions persist caps across restarts and prevent clock rollback refill.
- Hard caps: 180 upstream units/minute, 16,000/day total, 600/day O1 and 12,000/day RPC.
  Each fee RPC method is charged, including batched methods; O1 fee pages cost three units.
  Four concurrent upstream requests total, two per provider; eight pending cache keys,
  256 cache entries; no unbounded work queue.
- API caps: 300 requests/minute globally, 30/minute per socket IP and six ticker
  checks/minute per socket IP. Sixteen active requests, 64 sockets, 2 KiB general
  bodies, 4 KiB launch bodies,
  8 KiB headers; six-second upstream timeouts and capped response bodies.
- Client identifiers are HMACs with daily rotation, not raw IPs; expired counters are
  removed. No request/body/provider-error logs. Errors return fixed codes and 429
  includes `Retry-After`. Global quotas remain authoritative if clients rotate IPs.

Forwarded IP headers are ignored. Behind the web proxy, users share a conservative
socket-IP bucket. This deliberately limits initial throughput; trusted ingress and
fair per-user limits are a separate production step, not an excuse to loosen caps.

## Fly preparation (not deployed)

Use the authenticated Fly CLI to discover the organization, existing apps and
regions before requesting configuration from the operator. Inspection found an
existing bot deployment with its own signing/Telegram settings and persistent
data; it must remain untouched. Create a dedicated aggregator app and volume,
not a second backend in that bot app. Existing organization/region defaults can
be reused, but production still needs the webview's exact HTTPS origin. A custom
API hostname is optional because Fly supplies an app hostname. Confirm the new
single-Machine persistent-volume deployment before provisioning; no Fly token
needs to be sent in chat.
Load API/RPC keys and reviewed contract identities through an ignored local file
or Fly secrets, never shell history, tracked files or public browser variables.

`fly.api.toml` and `apps/api/Dockerfile` package only the API; test files, credentials
and runtime databases are excluded from the image. The Node base is pinned to the
digest used by the local build; review updates before changing it. Node's SQLite
API is still experimental in the tested local runtime. The Fly template passes
CLI validation using a placeholder app name; no app was created or deployed.

Use one approved Fly Machine and one persistent `read_budget` volume mounted at
`/data`. Prepare that new volume with UID/GID 1000 ownership, then run
`node src/init-budget.mjs --initialize-new-volume` once as the container's `node`
user. This refuses to replace an existing database. Production startup checks the
mount, schema/integrity, exact database path and `READS_MACHINE_ID=FLY_MACHINE_ID`.
Set the approved machine identity and origins as runtime configuration, not tracked files.

The explicit initializer also checks the mount before creating any file. Both
initialization and startup require exactly one writable, disk-backed `/data`
mount with a supported filesystem and no path aliases. An ordinary container
directory, memory filesystem, read-only volume or ambiguous mount is rejected.
Confirm the provisioned volume satisfies this check before enabling the API.
If initialization fails after exclusive file creation, leave the failed state
for operator inspection; never delete it or silently retry with a fresh budget.

Do not use blue/green or extra Machines: separate Fly volumes do not share budgets.
Use an immediate single-Machine deployment (`--ha=false`) after provisioning and
validating the approved identity. A replacement Machine needs an explicitly approved
identity and the existing budget volume. Never initialize a replacement budget to
bypass an exhausted or lost one. Scaling requires a shared authoritative limiter first.
See [Fly volume documentation](https://fly.io/docs/volumes/overview/) and
[Node SQLite documentation](https://nodejs.org/api/sqlite.html).

In the deployed web server, configure server-only `READ_SERVICE_ORIGIN` to the
backend HTTPS origin and `APP_ORIGIN` to the exact web origin. The allowlisted
`/api/[operation]` route forwards to Fly without forwarding browser cookies or
headers. The local Vite proxy is development-only. Keep O1/RPC credentials on Fly,
not in the web server or public build variables.

Attach a backend hostname with `fly certs add api.example.com -a YOUR_APP`, apply
the exact DNS records from `fly certs setup`, then run `fly certs check`. Do not
modify existing DNS before the API and its storage/configuration checks pass.

## Remaining work

Fee reads and wallet-only claim preparation are implemented behind separate runtime
switches; see [fee coverage, configuration and safety](fee-claims.md). The backend never signs or sends.

Remaining work: live adapter and ordinary Long launch verification with
operator-supplied runtime configuration and real extension sessions. Image storage
and x402 image jobs now run in the separate asset service; see
[image generation](image-generation.md). The implemented Long path remains disabled
by default until those checks and an explicit production enablement review.

The O1 snapshot checks and catalog weight follow the official
[configuration schema](https://docs.o1.exchange/launchpad/public-api/reference/meta/get-api-configuration)
and [weighted limits](https://docs.o1.exchange/launchpad/api/errors-and-limits), reviewed
4 September 2026. Long's intersection is a conservative configured subset, not an
independently discovered complete Long catalog. Never substitute another launchpad's
stock list for reviewed Long token/oracle eligibility.
