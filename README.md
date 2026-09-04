# Fungun

A noncustodial launchpad composer for Long and O1.

```sh
npm run setup
npm run dev
```

In a second terminal, run `npm run dev:api` (Node 24.4+). External reads default
to disabled; see [read-service setup](docs/read-service.md) for runtime configuration.

Open http://127.0.0.1:3000. See [development notes](docs/development.md) for
working controls, deliberate limitations, tests and the Fly backend boundary.

This milestone is a local webview with a guarded read-service backend. Configured
adapters can load Long/O1 catalogs and check Long ticker reservations; O1 ticker
availability stays unverified. Transactions, fees/claims and paid image generation
remain disabled. Telegram integration is out of scope.

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

Wallet connection does not authorize a signature or transaction. No transaction
may be submitted by this scaffold. Public on-chain data is not secret, but
operational copies do not belong in this repository.
