# Implementation status

Snapshot: 2026-09-04. This separates implemented code from production readiness.
Fee reads/claims are owned by a separate task and are not assessed here.

| Step | Status | Implemented | Remaining |
| --- | --- | --- | --- |
| 1. Live data | Partial | Server-only environment allowlists; bounded/cached read service; O1 catalogs; Long ticker checks | Complete contract/pairing verification and O1 ticker checks; fee coverage tracked separately |
| 2. Image and metadata storage | In progress | Content validation; isolated decoder packaging; write-once Fly asset service; explicit inline preview and wallet publication; read-only uncertain-result recovery | Real Fly isolation/resource verification; independent backup/restore; terminal recovery; public retrieval and Long display verification |
| 3. Launch preparation | Partial | Ordinary Long unsigned builder and cost model, tested offline | Live simulation and trustworthy ETH/USD totals; O1 builder; verified metadata attachment |
| 4. Wallet execution | Next | Wallet connection exists; artwork approval is not launch execution | Explicit launch approval, per-launchpad progress, receipt checks and durable duplicate-submission protection |
| 5. Paid Grok | Partial | System prompt builder and editable ticker-populated prompt | One-time payment approval, spend limits, paid generation and output validation |
| 6. Release | Next | Automated unit/abuse checks, source safety checks and local container checks | Real Rabby/MetaMask tests; final history scan; dedicated Fly deployment; domain/DNS verification |

## Current completed submilestone

Step 2 browser integration: same-origin bounded upload proxy, processed preview,
exact wallet publication approval and read-only recovery after an uncertain
response. Generated test fixtures exercise changed-wallet/chain/content guards,
duplicate clicks, content/message substitution, rate limiting, malformed response
handling and recovery privacy. No real wallet was signed and no transaction sent.

Publication stays disabled by default. Storage receipts explicitly carry
`launchReady: false`; a stored image is not proof that a token is safe to launch.
See [launch-assets.md](launch-assets.md) and [fly-assets.md](fly-assets.md).

## Next implementation boundary

Finish durable backup/restore and terminal publication recovery, then verify the
dedicated Fly asset stack before enabling uploads. Afterwards connect ordinary
Long's prepared metadata to read-only live simulation and explicit wallet launch.
Do not use the Telegram bot's runtime, secrets or volume for this service.
