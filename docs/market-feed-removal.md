# Market Feed summary

The Market Feed summary remains available: Popular Token, FOMO buys from the
last 24 hours, and the ten-token `>10ETH INFL:` queue with GMGN links and price
changes. The full ETH and SHARES token columns, token cards, per-bin ladders,
and their COPY controls are removed. Other tabs retain the compact FOMO strip.

The summary reads one bulk monitor snapshot every 15 seconds while visible,
instead of every four seconds. The API's shared FOMO token-registration observer
also runs every 15 seconds so new matching buys still appear without a viewer.
FOMO refreshes every 15 seconds; its shared collector and relay remain unchanged.

Only the inflow queue's at most ten qualifying tokens request prices, at the
existing two-minute cadence. The API batches due V4 pool reads in one call and
shares its price cache across viewers. This is required for the planned inflow
percentage changes; the removed full lists do not add per-token price requests.
All three summary endpoints are enabled. Hidden/offscreen/offline clients pause.

The independent rh-monitor trading service is unchanged. Slower bulk HTTP polling
reduces requests but does not reduce that service's independent RPC consumption.
Removing token cards alone does not imply lower RPC CU usage; inflow price reads
remain bounded as described in [tracked-prices.md](tracked-prices.md).
