# Runtime secrets

The aggregator does not need a wallet private key or seed phrase. Launches and
claims belong in the connected user's wallet. Keep signing material in a separate
wallet environment, not this project's `.env`; the launcher ignores it but does
not remove or modify your local file.

`npm run dev` parses the ignored root `.env`, passes only the API's named
configuration to the read-service process, waits for it, then starts the web app
without those provider settings. `npm run dev:api` uses the same API allowlist when
the service is debugged separately. Unknown names, private keys, seed phrases,
Telegram credentials, public build variables and unused image-provider credentials
are not forwarded to the API. Existing shell configuration takes precedence. Only
selected operating-system settings come from the shell, never the local file. The
launchers do not print values or pass them as arguments.

This protects the normal local API startup path, not every process on the machine.
The launcher briefly holds the parsed file in memory; it is not a secure wallet.
Do not run the service or web build with the entire file injected through
`--env-file`, shell exports or a process manager. The webview must not receive
O1/RPC credentials, wallet keys or signatures in its environment or bundle.

Fly's container runs the API server directly. Configure only the required API
settings as runtime secrets; never bulk-import this `.env` or copy another app's
secrets. Signing keys are not part of `API_RUNTIME_NAMES`. No environment file,
test fixture or local database is included in the Docker build context.

Prefer a dedicated O1 key scoped to the required read endpoints. Local API quotas
cannot account for another bot or service using the same provider credential.
Keep `.env` ignored and run the staged, tracked and history security scans before
committing or pushing. Never include real credentials in tests.

O1 wallet launches additionally use the API-only `O1_WALLET_LAUNCH`,
`O1_LAUNCH_PROFILE_JSON`, `O1_LAUNCH_TOKENS_JSON`, and optional
`LONG_EXTRA_QUOTES_JSON` settings. The local launcher forwards these names only
to the API process and removes them from the web process. The Fly web build starts
from a fresh allowlist and receives none of them. Configure the O1 switch and
profile on the API app only; keep the switch `false` until the exact API and web
revision has passed live verification.

The separate asset launcher also allowlists OpenRouter, x402, USDG and read-only
settlement RPC settings for [image generation](image-generation.md). Those values
are never forwarded to the read API, the isolated decoder, or a web build. Only
the public USDG asset configuration is shared with the web quote proxy.

For managed IPFS, set `ASSET_STORAGE=ipfs`, `PINATA_GATEWAY` to the public
`*.mypinata.cloud` hostname, and `PINATA_JWT` only in the asset service. Never add
the JWT to the web application, a gateway URL, Git, logs or wallet messages.
