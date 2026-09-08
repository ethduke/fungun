# Runtime secrets

The aggregator does not need a wallet private key or seed phrase. Launches and
claims belong in the connected user's wallet. Keep signing material in a separate
wallet environment, not this project's `.env`; the launcher ignores it but does
not remove or modify your local file.

`npm run dev` parses the ignored root `.env`, passes only the API's named
configuration to the read-service process, waits for it, then starts the web app
with a separate explicit allowlist. `npm run dev:api` uses the same API allowlist when
the service is debugged separately. Unknown names, private keys, seed phrases,
Telegram credentials, public build variables and unused image-provider credentials
are not forwarded to the API. Existing shell configuration takes precedence. Only
selected operating-system settings come from the shell, never the local file. The
launchers do not print values or pass them as arguments.

The web child receives only basic OS settings (`PATH`, `HOME`, temporary-directory
and locale settings, `TZ`), the sandbox watcher flag, validated development origin
and ports, and these named public settings from the shell: `READ_SERVICE_ORIGIN`,
`ASSET_SERVICE_ORIGIN`, `ASSET_PUBLIC_ORIGIN`, `ASSET_UPLOADS`, `ASSET_STORAGE`,
`PINATA_GATEWAY`, and `IMAGE_USDG_ADDRESS`. Do not put credentials in public URLs.
Unknown shell variables, provider and wallet credentials, `NODE_OPTIONS`,
`NODE_DEBUG`, `DEBUG`, and arbitrary `NEXT_PUBLIC_*`/`VITE_*` variables are excluded.
Adding a new web setting requires an explicit allowlist change and test review.
This boundary applies to `npm run dev`, not a directly launched `dev:web` process.

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

The separate asset launcher also allowlists OpenRouter, x402, USDG and read-only
settlement RPC settings for [image generation](image-generation.md). Those values
are never forwarded to the read API, the isolated decoder, or a web build. Only
the public USDG asset configuration is shared with the web quote proxy.

For managed IPFS, set `ASSET_STORAGE=ipfs`, `PINATA_GATEWAY` to the public
`*.mypinata.cloud` hostname, and `PINATA_JWT` only in the asset service. Never add
the JWT to the web application, a gateway URL, Git, logs or wallet messages.

Facilitator request logs contain only a fixed event, a recognized route label
(`/healthz`, `/supported`, `/verify`, `/settle`, or `unknown`), HTTP status, and
duration. Unexpected-error logs contain only the event, route label, and fixed
`unexpected_error` code. Raw paths, queries, headers, bodies, provider messages,
stacks and error causes must not be added to these records, including on HTTP 401.
Any reverse-proxy or hosting access logs need their own equivalent configuration;
the application logger cannot redact another service's logs.

## Generated web-server secrets

Vinext generates a server-only `prerenderSecret` during a production build. Treat
the generated server manifest and bundles as sensitive; do not print their values
while inspecting output, attach them to reports, or commit them to Git.

If that value is exposed, run `npm run build:fly` from the repository root. This
uses the production environment allowlist and refuses local web dotenv files.
Rebuild all artifacts together rather than manually changing one generated file.
Compare old and new values only in memory: confirm the value changed, the old
value is absent from the rebuilt `apps/web/dist` tree, and neither value occurs in
`apps/web/dist/client` or `apps/web/public`. Report only pass/fail results and
counts, never the values. Generated artifacts remain ignored and uncommitted.

A local rebuild does not replace an already running process or a deployed
artifact. If the exposed build was deployed or copied elsewhere, arrange a
separately authorized rebuild/redeployment or removal of those copies too.
