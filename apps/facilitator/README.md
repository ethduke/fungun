# Private x402 facilitator

This service uses the official x402 Foundation v2 packages and exposes only four routes:

- public `GET /healthz` for the Fly health check;
- bearer-protected `GET /supported`;
- bearer-protected `POST /verify`;
- bearer-protected `POST /settle`.

The payment policy accepts only `exact` EIP-3009 authorizations on `eip155:4663` for canonical Robinhood USDG, the configured service recipient, the configured maximum prompt price, and a five-minute authorization. It pins the live USDG proxy, implementation, EIP-3009 facet, and EIP-712 domain. An upstream USDG upgrade therefore stops startup until its new deployment is reviewed and the pinned hashes are updated.

The facilitator process has exactly these required runtime values:

| Variable | Value |
| --- | --- |
| `X402_FACILITATOR_PRIVATE_KEY` | Dedicated relayer private key |
| `X402_FACILITATOR_BEARER_TOKEN` | Shared 32–256 character server credential |
| `ROBINHOOD_RPC` | HTTPS Robinhood RPC |
| `IMAGE_USDG_ADDRESS` | Canonical address in the official Robinhood contracts registry |
| `IMAGE_PAYMENT_RECIPIENT` | Operator-controlled USDG revenue address |
| `IMAGE_MAX_PRICE_USDG_BASE_UNITS` | Maximum live quote in six-decimal USDG units |

The asset service receives the same bearer token plus `X402_FACILITATOR_URL`; it never receives the relayer private key. There are no optional facilitator variables.

Settlement allows only USDG `transferWithAuthorization`. Raw transactions and ERC-6492 factory deployment are disabled. Each transaction is estimated, receives 20% headroom, and is rejected above any of these compiled policy limits:

| Limit | Value |
| --- | ---: |
| Estimated gas | 160,000 |
| Submitted gas | 200,000 |
| Max fee | 5 gwei |
| Max priority fee | 0.1 gwei |
| Max total transaction fee | 0.001 ETH |

Fund the relayer with only the operating float you intend to risk. The initial target is `0.01 ETH`; top-ups are manual. A maximum-balance transaction gate is deliberately absent because anyone could disable the service by donating ETH to the public relayer address.

Deploy with the dedicated config after setting the required secrets:

```sh
flyctl deploy -c fly.facilitator.toml -a farmgun-facilitator
```

The public Fly edge terminates HTTPS, while the bearer token keeps all x402 routes private. Do not expose the bearer token or relayer key to the browser bundle.
