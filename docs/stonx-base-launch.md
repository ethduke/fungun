# stonx on Base

The `stonx` integration targets [stonx.ai](https://stonx.ai/docs), a Doppler
multicurve launchpad on Base (8453). It is separate from Stonks Exchange.
The first supplied link was labelled with the pons docs URL but linked to stonx;
the wrapped-stock catalog identifies stonx as the intended addition.

## Supported flow

The shared composer, artwork publisher, wallet queue and durable recovery support
all 45 supplied wrapped-stock pairings. IDs bind Base and the quote-token address
using a digest; tickers and pasted USD prices cannot select a contract.
The enabled server profile must contain all 45 pairs; an incomplete catalog is
rejected at startup. The bundled catalog supplies labels while it loads.
Preparation always rechecks the chosen contract.

Each launch uses one billion tokens with 18 decimals, immutable IPFS metadata,
no team allocation, no dev buy, no wallet cap and no approvals. All supply enters
locked Uniswap v4 liquidity. Seven contiguous bands use the current stonx
configuration: 95% between approximately $5,000 and $5 million opening valuation,
with a 5% tail extending to the maximum liquidity-safe tick. The no-op governance
and migration modules preserve the pool. The hook's $100,000 far-tick setting is
retained even though this route does not migrate.

The hook fee decays from 80% to 1% over ten seconds. The separate LP fee is 0.05%.
Both streams allocate 70% to the creator after Doppler's 5% share, equivalent to
66.5% of total fees. stonx receives 28.5%. The stonx controller can change hook
fee routing, including reinvestment and buybacks. The integration preserves its
current controller and beneficiaries; it does not claim that routing is immutable.
See [stonx fees](https://stonx.ai/docs/fees) and
[Doppler hooks](https://docs.doppler.lol/advanced-features/rehype-pools).

Launches send zero native value; ETH covers gas only. Preparation includes Base
L1 data and operator fees, checks the balance and bounds the complete budget.
The browser reconstructs every byte, rechecks pinned contracts and the wrapper's
beacon implementation, simulates the transaction, and then requests one wallet
transaction. EOA wallets are currently required by the shared recovery flow.

The server selects the newest fresh stonx index price, skipping any early
future-dated bucket, and applies stonx's bounded DEX/NAV calibration. If no
current observation is fresh, preparation fails. The quote is used to set the
curve at launch; later stock-price changes do not reprice an already signed
transaction. A preparation expires after 30 seconds locally. Airlock's create
ABI has no on-chain deadline, so users should cancel old wallet requests rather
than signing a previously prepared transaction later.

Confirmation checks Airlock's Create event, token metadata and supply, the
initializer's locked pool state and both beneficiary-share streams. For this
initializer, Airlock returns the token address as `poolOrHook`; the actual v4
pool identity is a hash of its PoolKey. This was verified by live simulation.

The Fees tab reads and claims both creator fee streams on Base; see
[stonx fee discovery and claims](stonx-fees.md). The Robinhood market feed retains
its current scope.

## Runtime setup

Set these API runtime variables (never public web-build variables):

- `STONX_BASE_WALLET_LAUNCH=true`
- `STONX_BASE_PROFILE_JSON`: the verified profile described below
- `BASE_RPC` (or legacy `BASE_RPC_URL`), `READ_UPSTREAMS=true`, `LAUNCH_ASSET_SERVICE_ORIGIN`
- `FEE_CONTRACTS_JSON.baseOracle`: the existing reviewed Base gas-oracle profile

The profile contains `chainId: 8453`, `launchpad: "stonx"`, contract pins
`launcher` (Airlock), `tokenFactory`, `tokenImplementation`, `governanceFactory`,
`poolInitializer`, `liquidityMigrator`, `dopplerHook`, `poolManager`, the
`integrator` and `protocolBeneficiary` addresses, and `quotes`.
Each contract pin contains `address` and `codeHash`. Each quote contains `id`,
`symbol` (`wt` prefix), `decimals: 18`, and `token`, `beacon`, `implementation`
contract pins. Wrapper bytecode must bind its configured beacon, whose current
implementation must match the reviewed implementation. Deployment values belong
in ignored operational files or runtime secrets.

The verified 45-pair profile is saved locally in `local/stonx-base-profile.json`,
with a read-only verification summary beside it. It is intentionally ignored by
Git under the repository's deployment-address policy. Local activation remains
off pending `LAUNCH_ASSET_SERVICE_ORIGIN` and the launch settings above.
The API uses this checkout's existing `BASE_RPC`; it takes precedence over
`BASE_RPC_URL`. No deployment or blockchain transaction was made.

## Validation

- Read-only `cast` checks at Base block 51050960 verified all 45 symbols,
  decimals and bytecodes, Airlock wiring and module states. The stock wrappers
  share one beacon; its implementation was subsequently pinned and verified.
- `cast call` simulated all 45 wrapped-stock launches successfully through
  `BASE_RPC`, using fresh index observations. Each token prediction and Airlock
  return matched. The local report is `local/stonx-all-pairs-verification.json`.
- Independent encoding matches official Doppler SDK 1.0.40 byte for byte for
  three representative price levels, including the liquidity-safe tail.
- Automated tests cover Base isolation, the 45-pair catalog, runtime validation,
  full gas accounting, stale prices, insufficient funds, receipt shares, durable
  routing, transaction substitution and wallet simulation before dispatch.
  Every pairing is tested through preparation, browser reconstruction and
  confirmation. Price tests cover early future buckets without accepting stale
  prices; runtime tests reject an incomplete catalog.

The official SDK is a development-only dependency used for cross-checks. The
runtime encoder uses viem and a small MIT-licensed math extract, avoiding an SDK
React peer dependency conflict in the web application.
