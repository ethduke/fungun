# FOMO trader purchases

The FOMO row sits immediately below Popular tokens, with a compact strip on the
other app tabs. Entries link the trader to their canonical FOMO profile and the
token contract to Robinhood GMGN, followed by the latest recorded purchase time
in the viewer's local timezone. A later sell does not remove a historical buy.

## Configuration

Set `FOMO_ENABLED=1` and `FOMO_API_KEY` in the ignored root `.env` for `npm run dev`,
or in the existing read service's deployment secrets. The key is selected only
for the API process and is never forwarded to the web process. With no key the
status says tracking is not configured; cached buys remain readable.

The default mapping is `apps/api/src/fomo-users.json`, including `runn3rrr` and
the eight canonical handles from the supplied handoff. Profile links use mapping
keys; display labels may differ. Set `FOMO_USERS_PATH` to an absolute JSON path
to override the full mapping, then restart. Adding users does not recover their
uncached earlier events. No identity or wallet-resolution calls are made.

## Storage and lifecycle

The existing single-machine read service owns one `/ws/alerts?chain=robinhood`
connection for the entire watchlist. It initializes additive `fomo_*` tables in
its existing WAL SQLite database (`BUDGET_DB_PATH`), retaining the existing
production `/data/read-budget.sqlite` volume and machine-ID startup guard.
The API Docker build includes the shared Stream projection and registry modules.
Use the existing immediate, single-machine deployment, never another replica or
web worker for this collector. Shut down collection before closing the database.

Connection attempts are committed before connecting, capped at 12 in any rolling
24 hours across restarts. Retry deadlines survive restart; exponential retries
range from one minute to one hour. Protocol ping/pong checks run every 20 seconds,
with a 20-second handshake timeout. Policy-denied sockets stop until operator
intervention/restart, and persist a one-day retry deadline. Errors never log the
credential-bearing URL. There is no FomoAPI REST polling or REST fallback.
The 12-attempt counter is local to this service, not shared with other projects
using the same key.

A background observer reads the existing public RH monitor Stream snapshot at
four-second intervals even without viewers. It uses the same stablecoin filter
and projection as the web feed, and commits all qualifying contracts before
acknowledging a snapshot. Source failures use the relay's existing backoff.
This observer is an additional public Stream reader, not a FomoAPI request.
Stream registration and cached buys are joined in either arrival order; no
expiry or removal of Stream rows deletes previous matches. Replays deduplicate
by provider ID, source and handle (a best-effort field hash when no ID exists).
Only explicit app-feed `buy` events with known Robinhood chain ID, valid contract,
allowed handle and valid provider time generate highlights.

`POST /api/fomo` (proxied to `/v1/fomo`, empty JSON object, `x-fungun-intent: fomo`)
reads the local cache. Visible clients refresh every 15 seconds; hidden clients
pause and retain their rendered results. No client opens a provider socket.
Status includes connection health, welcome-message delay, connection count,
Stream observation health and incomplete history. The row keeps saved buys
visible during disconnections.

## Coverage and verification

History is always marked incomplete: socket replay has no completeness guarantee,
and the upstream Stream exposes snapshots, not a durable ingestion cursor. Tokens
that disappear between snapshots or during observer downtime may be missed. The
source adapter explicitly assigns chain 4663 after the existing Robinhood-only
projection. Every token admitted by this observer is durable, but this does not
claim recovery of the upstream's entire historical Stream. No history backfill
or historical-position inference runs.

Tests use synthetic events in temporary databases and fake sockets, never the
production cache or provider quota. Run `node --test apps/api/src/fomo*.test.mjs
scripts/fomo*.test.mjs`. For a live check, configure the key on the sole API
process, inspect the welcome delay via `/api/fomo`, and confirm a real allowed
buy matches an observed contract. Local checks alone do not establish live status.

Protocol reference: https://fomoapi.io/llms.txt (checked 5 September 2026).
