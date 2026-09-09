# Market narratives

The Market feed has one Narratives row. It replaces Popular Token and the old
inflow highlights. Each linked name searches X and displays its distinct-token
count and age, for example `🆕 Dogs (x2) · 2m, Marians (x3) · 18m`.

The API's existing background market-feed observer records names in the existing
persistent SQLite database. A narrative arrives when its second distinct token
is observed. Groups use the existing case-, accent- and punctuation-insensitive
similar-name matching. Multiple pools and repeated snapshots of the same contract
never add mentions. A pending first mention can qualify for up to 24 hours.

Arrivals are shared by all viewers and survive browser reloads and API restarts.
The newest arrivals appear first. An existing group's name, arrival time and
position stay fixed when its count increases. Its badge lasts ten minutes and its
entire entry expires 24 hours after arrival, even if more mentions were added.
Counts and entries remain available when their original pools leave the feed.
Expired tokens still present upstream cannot restart an episode; two new tokens
are required. Tombstones are removed after those tokens have been absent for a day.

The journal begins observing at deployment; it does not infer historical arrival
times. The first snapshot can therefore admit several groups together. No extra
provider connection, RPC read, or per-viewer upstream poll is added. Narratives
are returned alongside the existing `/api/fomo` response and its `serverTime`.
The browser advances ages from that server clock, removes cached entries at
expiry even during an outage, and preserves horizontal scroll and link focus.
The compact feed remains FOMO-only. The production observer runs continuously;
when FOMO is disabled in a local environment, that observer is not started.

`NarrativeStore` creates only its own additive tables and index in the existing
database. It never initializes, replaces or clears the budget or FOMO tables.
Tests cover arrival order, deduplication, count growth, exact expiration,
readmission prevention, persistent reopen, rendering and age/badge boundaries.
