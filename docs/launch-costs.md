# Launch costs and user errors

Status: calculation model and inline UI implemented; **no live quote provider**.
The app does not request an estimate, price, signature or payment yet. Both selected
chains use mainnet ETH. USD is an indicative reference value, not the currency
charged by the network. Missing values display unavailable, never zero.

## Calculation rules

- Sum every launch and required approval/setup step in integer wei.
- A native launchpad fee is already part of transaction value. Add it once;
  show any remaining transaction value separately. Unpriced token payments
  prevent a complete total.
- Robinhood: bundled estimated gas × current gas price. Its Nitro gas estimate
  already accounts for L1 posting; do not add L1 again.
- Base: estimated execution gas × effective gas price, plus verified L1 data
  and operator fees. Effective price is the lower of max fee and base + priority,
  subject to valid fee settings. Do not substitute gas limit × max fee for the
  expected charge, or call a buffered estimate a guaranteed maximum.
- Use the current Base oracle's `getOperatorFee` result. The pinned viem 2.56.0
  default path does this; avoid its deprecated `l1BlockAddress` override, which
  can misclassify the upgrade after a failed read. Avoid duplicating gas reads
  through nested convenience estimators.

Sources: [Robinhood chain identity](https://docs.robinhood.com/chain/connecting/),
[Nitro gas accounting](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas),
[Base data fees](https://docs.base.org/specifications/transactions/network-fees),
[Base operator fees](https://docs.base.org/upgrades/jovian/exec-engine),
[EIP-1559](https://eips.ethereum.org/EIPS/eip-1559). Reviewed 2026-09-04.

## Freshness and presentation

Quotes expire within 30 seconds and bind to the wallet, wallet network, selected
chain, destinations, pairings, metadata and image revision. A replacement image
immediately hides old quotes during validation. Timers only invalidate local
state; they never poll RPC. USD requires a named reference rate no older than
60 seconds and uses integer microdollars per ETH. Expired USD does not invalidate
a still-fresh ETH estimate.

The high-network-fee warning begins at **0.01 ETH** across selected launches.
This is an explicit product warning level, not a market benchmark or permission
to spend. It recommends waiting and refreshing, not blindly raising gas limits.

## Before enabling live quotes

Implement reviewed, exact unsigned builders and finalized image metadata first.
Read current launch fees and verify pinned contracts/configuration, rather than
copying historical examples or treating Long's old gas ceiling as an estimate.
Validate every O1 prerequisite and native value. Re-estimate dependent steps after
each confirmed prerequisite; do not pretend a failed prerequisite simulation
has zero cost. Query prices and fee parameters server-side with fixed upstreams,
bounded concurrency, deduplication, durable quotas and short caching. No arbitrary
client-supplied RPC method, URL, contract or calldata endpoint is allowed.

At the service boundary validate all fields and convert server timestamps to
bounded monotonic deadlines, accounting for transit delay. Keep context keys,
account data and calldata out of logs, URLs and persistent storage. The model is
not an API parser, authorization layer, balance check or signing approval.

Before any future wallet confirmation, invalidate changed plans, recheck chain,
balance and freshness, simulate exact calldata and show complete fees. No retry
may automatically repeat a transaction or paid generation request.

## Errors

Only fixed messages derived from known codes or SDK error classes are shown.
Never render raw provider messages, URLs, response bodies, revert payloads,
signatures or stacks. Rejection, insufficient ETH, changed fees, invalid gas
settings, wrong network, provider timeout and service throttling have separate
guidance. Unknown errors have operation-specific fallbacks. A launch/claim timeout
asks users to inspect wallet activity before retrying: submission can be uncertain.
Wallet codes follow [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193).

Run the synthetic regression tests with:

```sh
node --experimental-strip-types --test apps/web/lib/launch-cost.test.ts apps/web/lib/user-error.test.ts apps/web/lib/read-service.test.ts
```
