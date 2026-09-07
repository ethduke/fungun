# Stonks Exchange on Base

This integration targets [Stonks Exchange](https://www.thestonks.exchange/about), not stonx.ai. Base offers O1 and Stonks; Robinhood keeps Long, O1 and Longbow. The shared composer provides name, ticker, image and description. Stonks offers the 13 reviewed Coinbase stock pairings through its registry, identified by a chain-and-address digest rather than a ticker.

## Launch behavior

- Calls the reviewed `StonkLauncher2.launchWithMeta` on chain 8453. The supply is one billion tokens with 18 decimals, all offered to a single-sided Uniswap V3 position on the 1% fee tier. Mint rounding can leave token dust, which the contract returns to the creator.
- Uses the existing verified IPFS artwork publication. Image and description are emitted in `TokenMetaSet`; the token's hosted metadata URL base remains under the Stonks operator's control.
- No dev buy, token approval, zap, referral, airdrop or external fee recipient. Fees go to the connected wallet under the current locker split.
- Quotes the live launch fee and a conservative gas ceiling including Base L1 data and operator fees. Exact calldata is simulated and gas is buffered by 20% before wallet approval. No synthetic zero gas or execution-only Base estimate is displayed.
- The quote registry sets the opening price. When its feed is stale, the launcher uses the saved anchor. The selected pairing cannot change afterward. The LP NFT is locked in the reviewed fee locker.
- The reviewed locker currently assigns 70% of the 1% trading fee to the creator and 30% to the platform. Live values and pending fee changes are read for comparison. The operator can change fee splits or reassign a creator after an announced 24-hour delay.
- The launch ABI provides a maximum launch fee but no on-chain expiry or starting-price bound. A delayed wallet approval can still execute against a later registry price. Cancel an old wallet request before retrying.

## Verification and recovery

Runtime settings supply deployment addresses and bytecode hashes; no deployment address is embedded in source. Verify the launcher and locker proxy implementation slots, registry, linked token-deployer library, V3 factory and NFT position manager. Read contract links, supply, fee tier, enabled quote, decimals and symbol before preparing. Refuse changed wiring, unreviewed stock pairs, non-EOA wallets, occupied token addresses and excessive or insufficient complete gas budgets.

The launch salt binds the wallet, metadata hash, pairing and chain to the durable intent. The browser reconstructs the exact calldata, forbids hidden approvals or dev buys, and independently checks the launcher prediction and proxy implementations before requesting one wallet transaction. Existing durable launch attempts and recovery are reused.

Confirmation checks the successful transaction, both launch events, identity and metadata, on-chain token information, fixed supply, pool, NFT ownership and creator routing. An NFT ID from simulation is not assumed to remain valid: another user's launch can advance that global counter before this transaction is mined.

## Feed and creator fees

The feed reads the official coin index and includes the latest 30 supported Stonks stock launches with Base identity and Stonks token links. Missing trade counts, inflow and price history remain unknown. The official feed is cached for two minutes, feed contract wiring for 15 minutes, and the stock catalog for ten minutes to stay within the shared read allowance. Launch and claim preparation always recheck contract state. Stonks polling has an independent unavailable state and stops while the market feed is hidden.

Fees discovery uses the official index as a hint, then reads the verified launcher, locker, positions and current recipients. Coverage is marked partial because the index does not enumerate every custom recipient or old creator reassignment. The integration supports the standard creator route and calculates later split routing when an indexed creation is found.

`eth_call` of the position manager's `collect` as the NFT owner reads uncollected V3 fee growth. Amounts use the on-chain platform split and the exact last-recipient rounding rule. A changed nonzero compounding share pauses fee preparation because its state-dependent fallback needs separate support. Separate `claim(token)` rows represent deferred payouts; these are not added to uncollected fees twice. Collection preparation rechecks ownership and amounts, simulates `collectAll(token)` or `claim(token)`, and includes Base gas components. Receipt confirmation counts matching ERC-20 transfers received by the wallet, not a generic collection event or a deferred payment.

## Runtime configuration

- `STONKS_BASE_WALLET_LAUNCH=true` enables launch preparation.
- `STONKS_BASE_PROFILE_JSON` supplies `chainId`, `launchpad`, `launcher`, `locker`, `registry`, `positionManager`, `factory`, `tokenDeployer` and `quotes`. Launcher/locker pins include implementation addresses and implementation hashes. Each quote has `id`, `token`, on-chain `symbol` and `decimals`.
- Existing `BASE_RPC_URL`, `READ_UPSTREAMS`, `LAUNCH_ASSET_SERVICE_ORIGIN` and `FEE_CONTRACTS_JSON.baseOracle` are required for launches.
- Existing `READ_FEES` and `WALLET_CLAIMS` govern discovery and wallet claims. Keeping the profile while disabling launches preserves fee and feed reads.

All deployment values remain in ignored operational files or server runtime settings. Keep these variables out of the web build and public-prefixed environment variables.

The implementation was checked against verified explorer source, read-only `cast` state queries, NVDA/AAPL launch simulations, fee-collection simulations, and the automated Stonks integration tests. No blockchain transaction was signed or broadcast during development.
