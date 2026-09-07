# pons v2 wallet launches

The `pons` destination launches on Robinhood Chain (4663) through the v2
factory's three-argument `launchToken` method. `pons-native` is distinct from
O1's `native` pairing. Base and custom quote tokens are not supported by this
integration. pons can be combined with O1 and either Long or Longbow.

The connected wallet is the creator fee recipient. The initial integration
sets creator tax to zero, disables buybacks, supplies no social links or extra
snipe exemptions, and performs no opening buy. Artwork uses the existing IPFS
publication flow; logo and description go directly into the launch parameters.
There is no ticker reservation: token addresses identify launches. Fees accrue
in pons; discovery and claims in Fungun's Fees tab are not implemented for pons.

## Runtime configuration

Set these **server-only** values in the deployment environment:

- `READ_UPSTREAMS=true`
- `ROBINHOOD_RPC` (or `ROBINHOOD_RPC_URL`)
- `PONS_WALLET_LAUNCH=true`
- `LAUNCH_ASSET_SERVICE_ORIGIN` pointing at the configured asset publisher
- `PONS_LAUNCH_PROFILE_JSON` containing the reviewed profile below

Without the toggle/profile, preparation returns `pons_launch_disabled`.
Runtime status reports `pons_wallet_launch`. Existing deployments remain
unchanged until the pons settings are supplied and the API is restarted.
Do not place deployment addresses, code hashes, or provider URLs in source or
browser environment variables. A locally verified profile can be kept under
ignored `local/pons-profile.json`.

Profile structure (replace placeholders with independently reviewed values):

```json
{
  "chainId": 4663,
  "launchpad": "pons",
  "launchConfigId": "0",
  "launcher": { "address": "<factory>", "codeHash": "<runtime-keccak256>" },
  "launchDeployer": { "address": "<deployer>", "codeHash": "<runtime-keccak256>" },
  "memeHook": { "address": "<hook>", "codeHash": "<runtime-keccak256>" },
  "feeEscrow": { "address": "<escrow>", "codeHash": "<runtime-keccak256>" },
  "buybackVault": { "address": "<vault>", "codeHash": "<runtime-keccak256>" },
  "graduationExecutor": { "address": "<executor>", "codeHash": "<runtime-keccak256>" },
  "graduationGuard": { "address": "<guard>", "codeHash": "<runtime-keccak256>" }
}
```

Resolve the current deployment from the official documentation. Use read-only
`cast` calls to verify chain ID, bytecode hashes and the factory's dependency
getters at one block. Select an enabled `getLaunchConfig(id)` and review its
supply, curve fee, reserves, graduation threshold and pool settings. Config IDs
are stable but their terms can change. An upgrade requires a newly reviewed
profile; the service never automatically trusts replacement bytecode.

## Preparation and recovery

1. A wallet-aware estimate checks `canLaunch(wallet)` before artwork publication.
   A wallet-free estimate only describes cost, not eligibility.
2. Preparation verifies the pinned stack, its dependency addresses, enabled
   launch config, live launch fee and the wallet gate. It binds
   `previewLaunchEconomics(configId, zeroAddress)` into the launch calldata.
3. The server verifies published artwork and simulates the unsigned transaction.
   The simulation returns token and curve addresses. It estimates gas with a 20%
   unit buffer and checks the wallet balance against fee plus gas. The existing
   global maximum transaction budget applies.
4. The browser reconstructs the calldata from the saved draft and publication.
   A wallet-side `eth_call` must return the same addresses before the durable
   dispatch reservation and wallet submission. Changed launch terms or a closed
   gate revert without a successful launch.
5. Recovery reuses the existing launch journal and nonce, records offered
   envelopes, waits for confirmations, then verifies `TokenLaunched` and deployed
   metadata, supply, pairing and creator fee recipient. It never sends a retry
   automatically after an uncertain wallet submission.

The fee estimate uses the configured gas ceiling until actual calldata is
simulated. It is not a claim that every launch consumes that much gas.

## Verification

On 7 September 2026, read-only `cast` calls at Robinhood block 57,234,331 found
config 0 enabled, a launch fee of 0.0005 ETH, and `canLaunch` true for a synthetic
ordinary address. A direct factory `eth_call` with a synthetic balance override
successfully returned token and curve addresses. No transaction was sent.
These observations are historical; each preparation reads the current state.
The docs' statement that public launching is closed differed from this read.
An existing public v2 token also confirmed the native pairing and creator metadata
field semantics through `getLaunchedToken` and `getTokenInfo`.
The explorer's verified-source endpoint returned HTTP 403, so source-level
verification through that endpoint was unavailable.

Synthetic tests cover routing, profile validation, wallet restrictions, changed
contracts, funding, calldata/artwork substitution, simulation failures, receipt
validation and recovery. Live creation/confirmation with a funded wallet has
not been performed.

Sources: [pons v2 builder guide](https://docs.ponsfamily.com/v2),
[pons machine-readable guide](https://docs.ponsfamily.com/llms.txt).
