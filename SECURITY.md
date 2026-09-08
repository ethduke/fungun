# Security policy

Never include credentials, private keys, wallet signatures, personal wallet addresses, authenticated RPC URLs, real transaction captures, or user uploads in this repository, examples, issue reports, logs, or build artifacts. Treat the private repository as already public.

Use GitHub private vulnerability reporting once enabled. Until then, contact the repository owner privately. Do not open public issues containing exploit details or sensitive data.

## Repository checks

Enable the committed hooks once per checkout:

```sh
git config --local core.hooksPath .githooks
```

The pre-commit hook scans the staged Git blobs, not the working copies. The pre-push hook scans all reachable Git history. CI runs the same checks without application secrets. Make the `repository-safety` job a required branch-protection check.

```sh
node --test scripts/check-repository.test.mjs
node scripts/check-repository.mjs
node scripts/check-repository.mjs --tracked
node scripts/check-repository.mjs --history
```

Checks reject sensitive/generated filenames, credential assignments and common provider tokens, literal EVM addresses/private-key hex/signatures, symlinks/submodules, and files larger than 1 MiB. Package-manager lockfiles may be up to 3 MiB. Findings contain filenames and rule names only. Never put secrets in filenames.

Credential checks include Pinata JWTs, FOMO relay tokens, Telegram bot tokens,
OpenRouter keys, and authenticated HTTP/WebSocket URLs (including encoded query
parameter names). A few exact historical negative-test fixtures are permitted
only at their reviewed test paths; other values in those files are still scanned.
Construct new fake credentials and authenticated test URLs at runtime.

CI additionally runs [Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1),
downloaded from the official release and verified against a pinned SHA-256.
Its default rules are enabled, with one narrowly scoped exception for a reviewed
pair of environment-variable names. It scans all available refs with full secret
redaction and ignores inline suppression comments. To run the same independent
check locally after installing that version:

```sh
gitleaks git --config=.gitleaks.toml --log-opts=--all --redact=100 --ignore-gitleaks-allow --no-banner .
```

Keep real-wallet tests, captures, uploads and generated output outside Git. Commit only small synthetic tests, constructing address-like strings at runtime. An `.env.example` may contain empty values or explicit placeholders such as `<set-at-runtime>`; actual environment files are forbidden. Supply operational addresses and secrets through deployment configuration, never source literals.

These checks are defense in depth, not proof of absence: hooks can be bypassed and CI runs after upload. Review every staged diff and all history before pushing or making the repository public. The history scan covers objects reachable from local refs, not remote-only, dangling or externally cached objects. Ignore rules do not remove already tracked files.

## Runtime boundaries

Private keys stay in the user's wallet. Application servers must not receive or store private keys or seed phrases. Keep provider keys server-side in deployment secrets; never expose them through client environment prefixes, browser bundles, HTML, source maps or API error responses.

Do not log prompts, request bodies, wallet addresses, authorization/payment headers, signatures, signed payloads or raw upstream responses. Use a narrow allowlist for structured log fields. Wallet addresses, contract targets and submitted transactions are visible to the wallet and blockchain; repository hygiene cannot make that activity private.

## Suspected exposure

Stop affected operations and revoke/rotate the exposed credentials immediately. A leaked wallet key cannot be rotated: migrate remaining funds using a separate secure recovery procedure. Remove sensitive data from repository history, artifacts and logs, then coordinate cleanup of remote caches and clones. Deleting the latest version does not undo exposure. Re-run the complete history audit before publication.
