# O1 launches on Base

The composer enables Base (8453) for O1. Selecting Base deselects Long/Longbow
and resets O1 to ETH; its RWA menu uses the Base catalog. Wallet switching,
funding messages, transaction checks, recovery journals and explorer links use
the selected chain. Robinhood launches retain their existing configuration.

## Runtime configuration

The API requires `READ_UPSTREAMS=true`, `O1_API_KEY`, `BASE_RPC_URL`,
`LAUNCH_ASSET_SERVICE_ORIGIN`, `O1_BASE_WALLET_LAUNCH=true`,
`O1_BASE_LAUNCH_PROFILE_JSON`, and `FEE_CONTRACTS_JSON.baseOracle`.
Base does not require a Long launch profile or `O1_WALLET_LAUNCH=true`.
All values stay server-side. Enabling the composer alone does not enable the
backend; deploy the API and web changes together with these runtime settings.

`O1_BASE_LAUNCH_PROFILE_JSON` has these exact fields:

- `chainId: 8453`, `launchpad: "o1"`.
- `launcher`, `launchTokenValidator`, `hook`, `feeEscrow`,
  `announcementRegistry`: each contains an `address` and reviewed `codeHash`.
- `quotes`: ETH is `{ "id": "native", "token": null, "decimals": 18 }`.
  Registered stock entries use the Base catalog's `rwa-…` ID, `decimals`, and
  `token: { "address": "…" }`. B20 assets are protocol precompiles and have no
  ERC20 runtime bytecode to pin. Never copy Robinhood quote addresses or IDs.

Pin the Base GasPriceOracle proxy address/code hash and its implementation
address/code hash in `FEE_CONTRACTS_JSON.baseOracle`. Merge this field into the
existing fee configuration, preserving all existing fee/claim profiles.
Obtain deployment identities from the official production registry and compare
the configuration API with read-only contract state before changing pins.
No deployment addresses, credentials or wallet-specific examples belong here.

## Verification and behavior

Base's current O1 factory creates B20 assets. Preparation verifies the factory
wiring, B20 activation, registered quote, code pins and unused predicted address.
It independently mines the required `01` suffix and cross-checks that address
with the B20 factory precompile, then simulates the exact payable `createLaunch`.

Fees include the on-chain creation fee, buffered execution gas, buffered L1
data fee for the serialized transaction and the operator fee. Before calldata
exists, the UI says fees are calculated at launch. The wallet checks its Base
balance against the complete budget before reservation and signing.

Artwork reuses the existing chain-independent publication service and its legacy
off-chain request schema. O1's native metadata preparation receives `chain_id:
8453`. No Robinhood signing or token approval is needed for a Base launch.
Receipt verification checks the confirmed transaction, launch event, token
metadata, supply, creator fee recipient and the B20 validator's role checks.
Reported paid gas includes Base's L1 and operator fees.

Tests cover both ETH and stock launches, wallet reconstruction and network
changes, fee omission/tampering, B20 activation and address checks, creator
rights, selected-chain metadata, runtime isolation and restart recovery.
Read-only Base simulations also verified ETH and AAPL creation at block
`0x309e666`, including matching predicted asset/pool returns and oracle fees.
They used a synthetic account balance override; no transaction was broadcast.
These checks are not a new contract audit or proof of a submitted launch.

## Sources

- [O1 direct integration](https://docs.o1.exchange/launchpad/integration/direct)
- [Production contracts](https://docs.o1.exchange/launchpad/reference/production-contracts)
- [Production deployments](https://docs.o1.exchange/launchpad/reference/production-deployments.json)
- [Contract suites](https://docs.o1.exchange/launchpad/reference/launch-contract-suites.json)
