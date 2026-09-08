# Fungun

A noncustodial launchpad composer for Long, O1 and Longbow on Robinhood Chain,
and O1 on Base.

```sh
npm run setup
npm run dev
```

`npm run dev` starts the read service first, waits for its health check, then starts
the web app; either process stopping shuts down the other. Use `npm run dev:web`
and `npm run dev:api` only when debugging the services separately (Node 24.4+).
External reads default to disabled; see [read-service setup](docs/read-service.md)
for runtime configuration. Separate worktrees can use distinct local web and API
ports with matching `APP_ORIGIN` and `READ_SERVICE_PORT` settings.

Open http://127.0.0.1:3000. See [development notes](docs/development.md) for
working controls, deliberate limitations, tests and the Fly backend boundary.

This milestone is a local webview with a guarded read-service backend. Configured
O1 catalogs load through the read service; Long and Longbow use bundled ticker
lists (64 and 194 choices). Long ticker reservations can be checked; O1 stays
unverified and Longbow ticker checking is not connected. Configured fee adapters support bounded live reads
and explicit wallet claims. The Fees tab discovers the connected wallet's beneficiary positions with
resumable pages and queues all eligible claims for individual wallet confirmation;
see [fee setup and coverage](docs/fee-claims.md).
USDG/x402 image generation is implemented and defaults to disabled until its runtime
settings are configured; see [image setup and recovery](docs/image-generation.md).
Drafts, images and published metadata survive reloads. Configured launch services
prepare verified unsigned transactions for the connected wallet. Base O1 supports
ETH and registered stock pairings; see [Base launch setup](docs/o1-base-launch.md).
Telegram is out of scope.

## Agent documentation

The public [llms.txt scaffold](apps/web/public/llms.txt) is served at `/llms.txt`,
with a linked [agent guide](apps/web/public/agent-guide.md) and HTML discovery link.
It follows the [llms.txt proposal](https://llmstxt.org/); it is context, not an
authorization policy. Keep both files aligned with implemented capabilities.
Use same-origin links until a production domain is configured. These files are
public assets: no credentials, operational addresses or private examples belong here.

## Repository policy

- Never commit credentials, private keys, wallet data, signatures or real transaction captures.
- Keep runtime addresses and provider configuration outside source control.
- Commit only small, reviewed source assets and synthetic tests; exclude test output.
- Keep dependency lockfiles. Review staged files before every commit.
- Never put a secret in a browser environment variable or container build argument.
- Private repository visibility is not a substitute for these controls.

## Development boundary

Wallet connection does not authorize a signature or transaction. Claims require a
verified preflight, a separate confirmation and wallet approval; the backend never
signs or sends. Public on-chain data is not secret, but
operational copies do not belong in this repository.


pons v2 is available in the Robinhood launchpad selector with ETH pairing
(`pons-native`), immutable metadata, zero creator tax and buybacks off.
The connected wallet receives creator fees. Live eligibility, fees and launch
economics are checked before wallet submission. pons fee claims are not yet
integrated. It can be combined with O1 and either Long or Longbow.


## Agent deployments and themes

The optional authenticated agent API and local Node SDK support Long deployments,
exact-name trending-theme subscriptions and configured automatic launches. The
signer stays local; artwork can be supplied, generated with Grok/x402 or replaced
with a neutral placeholder. See [agent setup](docs/agent-launches.md) for runtime
access, spending limits, CLI commands and recovery. Run `npm run test:agent` for
agent, payment, subscription and integration checks. This feature is disabled by
default and requires deployment configuration before use.
