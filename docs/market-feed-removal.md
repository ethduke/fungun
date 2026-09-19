# Market Feed removal

The webview no longer mounts Market Feed on any page. This removes its summary,
FOMO strip, ETH and SHARES lists, and all browser feed and token-price polling.
`GET /api/tracked-feed` returns 410 without contacting the monitor or registries.
The web proxy no longer forwards `fomo` or `tracked-prices`, and the API rejects
`/v1/tracked-prices` before any provider work or budget debit. Previously open tabs
therefore cannot continue per-token price RPC reads.

The API no longer runs the four-second all-token Stream observer. The shared
FOMO collector and durable event journal remain for the independent Telegram
relay; they do not perform token-price RPC reads. Their existing data is retained.
The rh-monitor trading service and its own tracking are independent and unchanged.
Removing this webview does not eliminate RPC work required by that service.

Validate with the API service/FOMO tests, frontend typecheck and production build.
Confirm the deployed pages omit `tracked-market-feed`, the retired endpoints do
not forward requests, and existing catalog/launch-estimate operations still work.
