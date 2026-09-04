# Launchpad catalog cache

Browser catalog reads never contact O1. They return the latest validated snapshot
from the read service's existing private SQLite volume. A single server worker
checks whether each supported chain snapshot is due and refreshes it at most once
every six hours. Concurrent calls and process restarts reuse the durable retry deadline.
The webview requests that snapshot only when O1 is selected or its pairing menu
is opened, then keeps it until the server-provided expiry instead of polling on
page entry.
Provider retry deadlines are shared by both chains and persisted across restarts.

Each successful refresh costs 20 O1 units. The new cadence therefore uses at most
160 units per day across Robinhood and Base instead of allowing a five-minute RAM
cache to exhaust the 600-unit daily provider budget. Failed refreshes preserve
the last valid snapshot and back off for 15 minutes to six hours; a longer provider
`Retry-After` is honored up to one day.

The database keeps the validated internal address mapping so Long's allowlist can
be intersected after restart. Browser responses contain only opaque pair IDs and
symbols. Expired retained mappings are removed after seven days. Refresh leases
are transactional and fenced so a late request cannot overwrite newer data.
Runtime databases remain outside Git.

`READ_UPSTREAMS=false` or a missing `O1_API_KEY` disables both refreshes and
serving cached live eligibility. Base remains paused in the webview, but its
backend snapshot stays bounded and ready for later activation. The maintenance
worker still removes expired retained mappings while provider reads are disabled.

Fresh snapshots may validate the current form. Expired snapshots never become
launch authorization. The saved public token list can remain visible while the
worker waits, but O1 launch preparation must revalidate the selected pairing before
the wallet is asked to sign or send anything.
