# Fungun

A noncustodial launchpad composer for Long and O1.

This milestone is a local, clickable webview. Live deployments, ticker lookups,
RPC services and paid image generation remain disabled until their adapters
and safeguards are verified. Telegram integration is out of scope.

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
