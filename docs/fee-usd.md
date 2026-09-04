# Claim gas USD estimates

Claim preparation converts estimated native ETH gas into USD with Coinbase's
public `GET https://api.coinbase.com/v2/prices/ETH-USD/spot` endpoint. This fixed
pair request contains no wallet address, contract, token, credentials or API key.
The existing server-side `Upstream` transport supplies response-size and timeout
limits, concurrency control and durable `market` quota accounting. It makes no
price request until a claim passes simulation and the ETH balance check.

The server validates the ETH/USD pair and a positive bounded decimal price, then
performs the conversion with integer arithmetic at 18 decimal places. A shared
60-second cache coalesces concurrent requests; it has no timer or polling loop.
An unavailable, invalid or quota-limited price returns `gasUsd: null` and never
blocks an otherwise valid claim. Expired prices are not served as fresh estimates.

The optional quote field is `gasUsd: { amount, ethPrice, observedAt, source }`.
Both amounts are decimal strings in USD; `observedAt` is the server's Unix
millisecond time when the reference price was received, and `source` is
`coinbase`. This estimates gas only; it does not price the claimed tokens or
change transaction gas, native value or budget checks. The reference is an
indicative spot price, not an executable exchange quote.

The [Coinbase Data API documentation](https://docs.cdp.coinbase.com/coinbase-business/track-apis/prices)
documents the public spot endpoint and its lack of authentication. A live
unauthenticated ETH/USD request returned a valid price on September 4, 2026.
