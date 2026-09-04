# Read-service milestone

The webview now calls a separate Node service for catalogs and explicit ticker
checks. External reads are off by default. No credentials were copied from the
reference project, and no live provider/contract verification or Fly deployment
was performed for this milestone.

## Local setup

Use Node 24.4 or newer. Run `npm run setup`, then `npm run dev` and
`npm run dev:api` in separate terminals. The webview remains at
http://127.0.0.1:3000; its development proxy forwards `/api/catalog` and
`/api/ticker` to the local read service on port 8787. The public market feed's
`GET /api/tracked-feed` route runs in the web server. SQLite runtime files live in ignored
`apps/api/local/`; never delete them to reset a spent quota.

An ignored root `.env` can hold backend runtime configuration. Leave the committed
`.env.example` blank. `READ_UPSTREAMS=true` is the explicit opt-in to provider reads:

- `O1_API_KEY`: server-only O1 catalog access. The upstream origin is fixed in code.
- `LONG_RWA_ALLOWLIST`: comma-separated runtime token addresses verified against
  Long's supported stock/oracle configuration. Long intersects the shared O1
  catalog by address; ticker labels alone do not establish eligibility.
- `ROBINHOOD_RPC` (legacy alias: `ROBINHOOD_RPC_URL`), `LONG_TICKER_REGISTRY_ADDRESS`,
  `LONG_TICKER_REGISTRY_CODE_HASH`: server-only RPC configuration and independently
  verified deployed Long registry identity. Do not copy addresses into source/tests.
- `APP_ORIGIN`: exact web origin; defaults to the local URL above.

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

These are bounded anonymous reads, not authenticated financial operations. Origin
and intent headers deter browser cross-site requests; direct clients can forge them.
No arbitrary URL, address, method, calldata, cookie, signature or forwarding-header
parameter is accepted. Wallet addresses, images and prompts are not sent by these reads.

Catalog results contain opaque pair IDs and symbols, not operational addresses.
Missing configuration or upstream failure means unavailable, never an empty success.
An actual valid empty catalog is represented separately. Preview sample pairs remain
labeled and cannot stand in for a fetched live pair.

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
- One shared catalog per chain, cached five minutes, with concurrent reads coalesced.
- Ticker responses cached 15 seconds; no automatic polling/retries. Failed reads back
  off at least 15 seconds. Chain checks cache five minutes; block reads five seconds;
  code checks are cached by block. A cold Long check needs four RPC methods; another
  ticker at the same cached block needs only its `eth_call`.
- Browser freshness uses response-relative, monotonic time, not synchronized clocks.
  Edits discard mismatched results; explicit rechecks clear old successes. Expiration
  only updates labels; it never automatically sends another request.
- Every upstream attempt is debited before the request, even on timeout/failure.
  SQLite transactions persist caps across restarts and prevent clock rollback refill.
- Hard caps: 30 upstream attempts/minute, 2,000/day total, 600/day O1 and 1,400/day RPC.
  Four concurrent upstream requests total, two per provider; eight pending cache keys,
  256 cache entries; no unbounded work queue.
- API caps: 300 requests/minute globally, 30/minute per socket IP and six ticker
  checks/minute per socket IP. Sixteen active requests, 64 sockets, 2 KiB bodies,
  8 KiB headers; six-second upstream timeouts and capped response bodies.
- Client identifiers are HMACs with daily rotation, not raw IPs; expired counters are
  removed. No request/body/provider-error logs. Errors return fixed codes and 429
  includes `Retry-After`. Global quotas remain authoritative if clients rotate IPs.

Forwarded IP headers are ignored. Behind the web proxy, users share a conservative
socket-IP bucket. This deliberately limits initial throughput; trusted ingress and
fair per-user limits are a separate production step, not an excuse to loosen caps.

## Fly preparation (not deployed)

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

Live adapter verification with operator-supplied runtime configuration; verified
fee readers and claim builders; noncustodial launch transaction preparation,
simulation and explicit wallet approval; image storage; separately authorized
x402 payment/generation jobs. There is no transaction endpoint or signing path.
