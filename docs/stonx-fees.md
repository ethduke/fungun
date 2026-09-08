# stonx creator fees on Base

The Fees tab includes stonx's trading-fee and LP-fee balances. Each stream is a
separate position and wallet transaction. Claim all prepares them in sequence;
each transaction still needs the connected beneficiary wallet's confirmation.
Balances are in the actual payout tokens, not estimated from trading volume.

## Discovery and amounts

The public stonx Ponder index is used only to discover pools for the reviewed
integrator. Its current hook-beneficiary table was empty for this deployment,
so a beneficiary-only query would incorrectly omit trading fees. The adapter
scans pool pages and reads the wallet's current shares from both contracts.
This also finds a trading share transferred independently of its LP share.

Each page checks at most 24 candidate pools, combines both share reads through a pinned
Multicall3 deployment, and resolves at most two matching pools. The scan keeps
one block snapshot and verifies deployment code once for that snapshot,
keeping routine lookups within the shared read budget. Remaining work stays behind an
opaque wallet-bound cursor. The client completes the scan automatically and
retains already discovered balances if a continuation fails. Overlapping pages
replace positions instead of adding their balances twice. Account changes stop
further pages. Newly launched pools can be absent until the index catches up.

Airlock's asset data, integrator, initializer, locked state, Doppler hook,
numeraire, PoolKey and pool ID are checked on-chain. Claims bind the pool's
actual fee and tick spacing, including existing dynamic-fee pools; they do not
assume the parameters of a newly created fixed-fee pool. The integration covers the
reviewed deployment and all 45 configured stock quotes. Other integrators are
excluded; unsupported or unverifiable state is never turned into a zero balance.

The LP initializer and trading hook both implement Doppler FeesManager:

`claimable = (cumulated + newlyCollected - lastCheckpoint) * currentShares / 1e18`

`newlyCollected` comes from a read-only simulation of `collectFees(bytes32)`.
Its return values are newly harvested pool fees, not the beneficiary payout.
Each cumulative/checkpoint read and simulation uses the same block. The two
streams are independent; do not reuse one stream's shares or checkpoints for
the other. The current stonx trading route pays wrapped-stock tokens; LP fees
can pay both the launched token and wrapped-stock token.

## Claims

Preparation repeats contract and pool checks, reads current shares and amounts,
verifies the wrapped-stock beacon implementation and Base gas-oracle proxy,
then simulates the exact zero-value `collectFees(bytes32)` transaction from the
beneficiary. Gas includes execution, L1 data and operator fees. Quotes expire
after twenty seconds and reject insufficient ETH.

The browser binds the quote to the chosen stream, pool, token, wallet, chain
and deployment; rechecks contract bytecodes and the wrapper implementation;
and simulates before opening the wallet. Confirmation requires the matching
`Release` event and matching ERC-20 transfers from the fee contract to the
beneficiary. Only received amounts are reported. No approval or fee-rights
transfer is part of this flow.

## Runtime and verification

Fees use `STONX_BASE_PROFILE_JSON` independently of launch activation; they do
not require an asset-publishing service. Set `READ_FEES=true`,
`WALLET_CLAIMS=true`, `BASE_RPC` (legacy `BASE_RPC_URL` also works), and the
reviewed `FEE_CONTRACTS_JSON.baseOracle` proxy/implementation pins.
`STONX_FEE_MULTICALL_JSON` contains the reviewed Multicall3 `address` and
`codeHash` used for discovery only; all amounts and claims are verified directly
against the fee contracts.

The local environment contains the verified stonx profile and Base oracle pins,
merged with its existing fee profiles. Deployment addresses remain in ignored
operational files. No blockchain transaction was submitted during development.

Read-only `cast` calls through `BASE_RPC` verified both streams on an existing
stonx pool and successfully simulated both claims. The sampled wallet had zero
pending fees at verification. The canonical Base gas oracle reported version
1.6.0; proxy/implementation bytecodes and both fee methods were checked.
Evidence is saved in `local/stonx-fees-verification.json` and
`local/stonx-base-oracle.json`. The reviewed Multicall3 pin is
`local/stonx-fee-multicall.json`; its share results match independent cast reads.

The local webview proxy completed all six index pages for the sampled wallet
and returned both verified fee streams. This check is recorded in
`local/stonx-webview-fees-verification.json`. An existing dynamic-fee pool was
also verified with read-only cast calls in
`local/stonx-fees-dynamic-verification.json`.

Tests cover independent streams, transferred rights, cumulative accounting,
pagination, wallet binding, changed deployments, insufficient gas, wrapper
upgrades, calldata substitution and transfer-backed receipt confirmation.

## Sources

- [stonx fees](https://stonx.ai/docs/fees), plus the production app's fee panel
  and public GraphQL schema, inspected 8 September 2026.
- [Doppler FeesManager](https://github.com/whetstoneresearch/doppler/blob/main/src/base/FeesManager.sol).
- [RehypeDopplerHookInitializer](https://github.com/whetstoneresearch/doppler/blob/main/src/dopplerHooks/RehypeDopplerHookInitializer.sol).
- Doppler SDK 1.0.40: RehypeDopplerHookInitializer.claimFees/getPendingFees and
  multicurvePendingFees. Its stateful multicall preview was cross-checked
  against separate fixed-block reads plus newly collected fees.
