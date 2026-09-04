# Fee reads and wallet claims

The FEE page loads a validated address after a 500 ms debounce. It never polls.
Refresh is explicit; each source is cached for 45 seconds with concurrent work
coalesced. Missing configuration and failed reads mean **unknown**, not zero.

## Coverage

- Long / Robinhood: live beneficiary fees from up to two operator-reviewed locked
  pools. This is partial coverage, not wallet-wide discovery. Separate hook
  payouts remain unsupported. Both pool currencies are paid by one claim.
- O1 / Robinhood and Base: one indexed page, at most 25 positions per chain.
  Identical escrow/recipient/currency positions are deduplicated, not summed.
  More pages and unverified positions are labeled partial.
- O1 / Base: at most four positions in approved current escrows receive live
  `owed` reads. Other versions and O1 Robinhood remain indexed, with claims disabled.
- Fees are displayed by payout currency and source. O1 escrow balances are shared
  across launches; they cannot be labeled as fees owed by an individual launched coin.

## Private runtime configuration

Keep all values in an ignored local `.env` or Fly runtime secrets. Never paste
keys into chat, browser variables, tracked files, command arguments or tests.
The committed `.env.example` must stay blank. Fee reads use `READ_FEES=true`;
claim preparation additionally requires `WALLET_CLAIMS=true`. These switches are
independent of catalog/ticker `READ_UPSTREAMS`.

Use server-only `O1_API_KEY`, `ROBINHOOD_RPC` (or its existing alias), and
`BASE_RPC_URL`. `FEE_CONTRACTS_JSON` has this shape; the placeholders below are
intentionally invalid and cannot enable claims:

```json
{
  "o1": [{ "chainId": 8453, "escrow": "<verified-current-escrow>", "codeHash": "<runtime-hash>" }],
  "long": {
    "manager": "<verified-initializer>",
    "managerCodeHash": "<runtime-hash>",
    "hook": "<verified-Long-hook>",
    "hookCodeHash": "<runtime-hash>",
    "pools": [{
      "asset": "<launch-token>",
      "currency0": { "address": "<lower-currency-address>", "symbol": "<symbol>", "decimals": 18 },
      "currency1": { "address": "<higher-currency-address>", "symbol": "<symbol>", "decimals": 6 },
      "fee": 3000,
      "tickSpacing": 60
    }]
  },
  "baseOracle": {
    "address": "<gas-price-oracle-proxy>",
    "codeHash": "<proxy-runtime-hash>",
    "implementation": "<verified-implementation>",
    "implementationCodeHash": "<implementation-runtime-hash>"
  }
}
```

Omit unconfigured sections. Native currency uses the runtime zero address, ETH/18;
wrapped ETH is distinct. Verify actual pool fee, spacing and token decimals—example
numbers are not deployment configuration. Pool IDs are computed from the full key.

Before enabling claims, the operator must independently verify source/ABI, chain,
runtime hashes, immutable hook/PoolManager wiring and deployment provenance using
read-only `cast` and the official deployment links. Only directly deployed,
non-upgradeable Long managers/hooks and current O1 escrows are supported. Do not
pin a proxy as an immutable contract. Hashing arbitrary RPC bytecode is not a review.
The Base gas oracle is the one supported proxy: both its EIP-1967 implementation
slot and implementation runtime hash are checked. Pin checks, balances, Long fee
checkpoints/collection simulation and oracle reads use one explicit block.

## Claim boundary

Same-origin JSON POSTs use `x-fungun-intent` matching their operation:

- `/api/fees` → `/v1/fees`: `address`, `chainId`, `padId` only.
- `/api/claim-prepare` → `/v1/claim-prepare`: `address`, `positionId` only.

The second endpoint prepares but never sends a transaction. Opaque handles bind
wallet, chain, profile and position; they expire after two minutes. The service
rechecks contract identity, positive fees and Long beneficiary shares, simulates
the exact call, estimates gas and checks pending ETH balance. No arbitrary target,
calldata, method, URL, approval, recipient override or server signer is accepted.

Long calls only `collectFees(poolId)` directly from the beneficiary wallet. O1
calls only `claimFor(owner,currency)`, which pays that owner. Both have zero native
value and no token approval. Review shows gas in ETH, including Base L1/operator
fees, with a 20% gas-limit buffer and a high-gas warning at 0.01 ETH. USD remains
explicitly unavailable without a live reference price. Buffers are not price caps.
The wallet can change fees; the user must review its final transaction.

Preflight results are coalesced for ten seconds and expire after twenty seconds.
Only an explicit Confirm in wallet click can invoke one `eth_sendTransaction`.
The current account and chain are rechecked. There are no write retries, namespace
fallbacks, automatic network switches or signature transmission to the backend.
Wallet rejection clears the request; ambiguous writes block further claims.
After checking wallet activity, the user can acknowledge uncertainty, wait thirty
seconds and prepare again. This acknowledgment never resends a transaction.

Check receipt is manual, at most once per ten seconds through the connected wallet.
Successful status alone does not prove a payout: Long requires a matching `Release`
event, O1 a matching `Claimed` event with owner/currency/destination. Actual receipt
amounts may differ from the estimate. One inclusion is not guaranteed finality.
The session guard survives navigation, but not reloads or separate tabs. Always
check wallet activity before retrying after a reload, replacement or dropped response.

## Privacy and quotas

Wallet addresses reach the backend and the relevant provider; public transaction
data necessarily reaches the chain. Do not enable request-body, URL or wallet
telemetry. No addresses, signatures or claim records are stored in SQLite or browser
storage. Server handles and browser transaction state are bounded, volatile memory.

Every RPC method in a batch consumes durable quota. O1 fee discovery reserves three
units per page. The shared short burst cap is 60 units/minute so one bounded load
and claim review can complete; daily caps remain 2,000 total, 600 O1 and 1,400 RPC.
The existing single-Machine Fly storage requirement and request/concurrency limits
still apply. Limits can return 429 mid-read; partial failures must not become zero.

## Verification sources

- [O1 production contracts](https://docs.o1.exchange/launchpad/reference/production-contracts): follow the current Base Fee Escrow verified-source link.
- [O1 functions](https://docs.o1.exchange/launchpad/reference/events-functions) and [claim API](https://docs.o1.exchange/launchpad/api/claims-and-creator-actions): owner-bound payout semantics; historical suites differ.
- [O1 schema](https://docs.o1.exchange/launchpad-api-openapi.yaml): currency metadata is optional and must be matched by address, never ticker.
- [Doppler FeesManager](https://github.com/whetstoneresearch/doppler/blob/bda077cf/src/base/FeesManager.sol): `collectFees` releases the caller's share; return values are pool-wide newly collected fees, not that caller's payout.
- [Doppler deployments](https://github.com/whetstoneresearch/doppler/blob/main/Deployments.md): confirm Long's Robinhood initializer against the reviewed source reference.
- [OP fee estimates](https://docs.optimism.io/app-developers/guides/transactions/estimates): execution, L1 data and operator components.

Tests use generated synthetic addresses and mocked RPC/wallet transports. No live
claim, provider-credential setup or Fly deployment was performed for this change.
