# Inflow-row price changes

The `>10ETH INFL:` row retains its ten-token FIFO and GMGN links. A token starts
with just its ticker. The first observed pool quote after admission becomes its
fixed baseline. On the next price observation at least two minutes later, the
row adds `(current - baseline) / baseline * 100`, rounded to one decimal place.
Each later observation compares with that original baseline. Prices themselves
are not displayed. Hover text includes baseline and latest observation times.

Prices are measured in the pool's paired asset, not USD or realized trade P&L.
The pool, token orientation, manager and quote asset remain pinned. Raw atomic
unit scales cancel in the percentage ratio, avoiding token-decimals RPC reads.
The verified reader currently supports V4 pools; other versions keep their links
without a percentage. Failed, zero, invalid or older observations cannot become
zero-percent returns. A retained percentage is muted and marked when an update
fails. A quote cached before admission is rejected as an entry baseline; the row
waits for a fresh observation instead. Reloading clears the FIFO and baselines.

## Read path and request budget

The existing public inflow feed still makes no RPC calls. The separate same-origin
`POST /api/tracked-prices` forwards to the guarded Node read service at
`POST /v1/tracked-prices`. It accepts only `{ pools: [{ pool, token, version }] }`,
with one to ten unique V4 tuples. It uses the existing `READ_UPSTREAMS=true`
opt-in and server-only `ROBINHOOD_RPC` from the ignored environment. Start or
restart `npm run dev:api` after updating the server.

The browser checks price deadlines on existing feed snapshots, without another
timer. New entries request a baseline; existing entries are due at least 120
seconds after the preceding completed attempt. Hidden/offscreen/offline feeds
pause price work. Abort and failure paths preserve deadlines; provider
`Retry-After` is honored. Missing V3 support never triggers a speculative lookup.

The server admits only nonstable tuples observed over 10 ETH-equivalent in the
fixed public monitor. A 256-entry, 24-hour allowlist supports retained FIFO tokens
without trusting arbitrary client pool IDs. Discovery uses a shared four-second
feed cache and the daily official production registry; ordinary price refreshes
reuse the admission cache and do not fetch the public monitor again.

The server confirms chain ID and code at the registry's Robinhood PoolManager.
An exact-address Initialize query uses only the requested pool IDs as indexed
topics. Unique nonremoved events must reproduce the PoolKey hash and contain the
tracked token. Metadata is cached for 24 hours, with a 30-minute failure cooldown.
There is no log-range splitting, pagination or automatic scan retry.

One `extsload(bytes32[])` call reads all due V4 pools together. Per-pool timestamps
and two-minute caches are shared across viewers, including reordered and
overlapping lists. Cold setup uses two RPC methods for chain/code verification,
one filtered metadata method, and one state-read method; a warm ten-pool refresh
uses one RPC method. This is contract batching, not ten calls wrapped in one HTTP
request. All reads debit the existing durable global/RPC quotas; no budget or
provider limit was increased. Waiters and total work time are bounded, and later
stages stop when no requesting viewer remains or the deadline is near.

No browser credential, cookie or arbitrary URL/calldata/contract target reaches
the RPC provider. RPC URLs and raw provider errors are never returned or logged.

## Verified references

- [O1 production registry](https://docs.o1.exchange/launchpad/reference/production-deployments.json):
  `chains[chainId === 4663].uniswapV4.poolManager` and canonical stable assets.
- [Uniswap StateLibrary](https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol):
  `_pools` storage slot 6, pool state-slot hashing and packed slot0 layout.
- [PoolManager interface](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol)
  and [PoolId](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolId.sol):
  Initialize metadata and PoolKey hashing.

A bounded four-command read-only probe confirmed the chain, deployed manager,
exact Initialize lookup and sparse state read. No transactions were submitted.
Tests use synthetic addresses and provider responses, never live credentials or
captured chain data.
