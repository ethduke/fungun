# O1 Robinhood fee coverage

Reviewed on September 7, 2026. The running fee configuration contained only the
current escrow and the historical stock-paired v4 escrow. Standard launches from
the three earlier suites therefore remained indexed-only, even after all wallet
index pages had been read.

The API now includes all five published Robinhood escrows as reviewed defaults.
Explicit runtime profiles override a default by chain and address. Unknown escrows
remain ineligible; appearing in the wallet index never approves a contract.

## Deployment and source evidence

Deployment addresses and corresponding hooks come from the official
[O1 production registry](https://docs.o1.exchange/launchpad/reference/production-contracts).
The legacy implementation was reviewed from
[Sourcify's exact-match v3 source](https://sourcify.dev/server/v2/contract/4663/0x32f7a9A05bD62487D085Ad494e14Ec42543e19d2?fields=all).
It uses Solidity 0.8.26, optimizer 200, via-IR, Cancun. FeeEscrow.sol SHA-256:
`cf58434f7ea4f3c41b819c09bb293cf44346f6af3d33499b9f90bbaf740ebaf8`.

At Robinhood block 56,999,212, read-only `cast chain-id`, `cast code`, and `cast call`
checks established the following:

| Suite | Escrow | Immutable hook |
| --- | --- | --- |
| v1 | `0xf5681c4c0dc0c2e32c9d127b3cc0fc992b584553` | `0xe960e6c80c74cfdf03c91e7af4e1f5f53f096a44` |
| v2 | `0x00d5701a92794c3744428b62646e7bc4e77a0a9a` | `0xca4b035a5dbfa2a00fc5dcb08fd1c5a22d0eaa44` |
| v3 | `0x32f7a9a05bd62487d085ad494e14ec42543e19d2` | `0x441f773b3bb1ed4c6457d0528624112e43c02acc` |

All three deployed runtimes are 1,864 bytes and exactly match the verified v3
recompiled runtime after substituting only its compiler-declared immutable slots:
PoolManager at byte offsets 124, 255, 1522; hook at 632, 1031 (32 bytes each).
The metadata bytes also match; no instructions or metadata were stripped.
The v1 address had no direct Sourcify record, so its evidence is this exact
comparison with the reviewed implementation, not a claim of direct verification.
All three PoolManager getters return `0x8366a39cc670b4001a1121b8f6a443a643e40951`.
The exact runtime hashes are pinned in `apps/api/src/o1-fee-profiles.mjs`.

The existing reviewed v4 and current pins were independently rechecked with
`cast code` at block 56,997,421 and still match the runtime configuration.
Their prior review is recorded in [fee claims](fee-claims.md).

## Claim semantics

The historical implementation exposes `owed(recipient,currency)` and
`claim(recipient,currency)`. Only the immutable hook can credit balances.
Claims zero the recorded balance before calling the immutable PoolManager,
use a reentrancy guard, and always pay the specified recipient. The callback
accepts only the PoolManager, burns escrow-owned ERC-6909 claims, then takes
the corresponding currency to that recipient. `claimTo` can redirect only
the caller's own fees; the app does not use it. No upgrade, owner sweep, or
arbitrary execution path is present in the reviewed escrow.

The existing legacy adapter matches its three-field `Claimed` event. Current
escrows keep `claimFor` and the event that includes a destination. Preparation
still verifies the exact runtime, reads the live amount and simulates the claim.
No transaction was submitted during verification.
