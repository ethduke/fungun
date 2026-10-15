# Fly deployment preparation

For automated staging releases, health checks, retained image rollback and the
production approval boundary, see [staging deployment](staging-deployment.md).

The webview now has a separate Node production target. This preserves the existing
Worker-based local preview and default build; it does not migrate the framework
or change the launch interface. Neither Fly app has been provisioned by this step.

## Build boundaries

`npm run build:fly` produces `apps/web/dist/standalone/`. From `apps/web`,
`npm run start:fly` runs it in production mode. Do not start the emitted server
without `NODE_ENV=production`: React must select its production runtime before
the first module import. `PORT` and `HOST` configure its listening address.

The build launcher never reads the root `.env`, excludes provider/wallet/build
credentials from its child environment, and refuses local `.env` files inside
`apps/web`. Configure origins at runtime, not in public build variables.
Both targets use `dist/`; build one target at a time. Rebuild the default Worker
target with `npm run build` before using its existing start/package workflow.

`apps/web/Dockerfile` is a multi-stage build with the same pinned Node base as
the API. Its final image contains the standalone runtime, not API source or
build tools. The build context excludes local environments, wallet/key files,
captures, tests and runtime databases. Both service containers run as `node`.

The standalone build passed HTTP smoke checks for `/`, `/fees`, `/healthz` and
`/llms.txt`; the production proxy rejected wrong-origin and oversized requests
without contacting a provider. The Fly web template passed CLI validation.
Both Linux ARM64 containers passed isolated runtime checks. The web container
served the same pages as a non-root user with no provider credentials or public
source maps. The API refused a missing persistent mount, repeat initialization
and a mismatched Machine identity; it served health checks with its initialized
volume. Actual Fly architecture, Machine and volume checks remain deployment gates.

## Separate service configuration

- `fly.web.toml`: dedicated web app, port 3000, one initial shared-CPU/512-MiB
  Machine, no persistent volume. `/healthz` performs no provider/RPC reads.
- `fly.api.toml`: dedicated API app, port 8787, one approved Machine and one
  `read_budget` volume. Follow the [persistent-budget bootstrap](read-service.md).
- Web runtime: `APP_ORIGIN` is the exact public HTTPS website origin;
  `READ_SERVICE_ORIGIN` is the dedicated API's HTTPS Fly hostname.
- API runtime: the same `APP_ORIGIN`, approved Machine identity and only reviewed
  [API runtime settings](runtime-secrets.md). No wallet private key or bulk `.env`
  import. Claims, launches and payments stay disabled pending separate verification.

Existing organization and region defaults can be reused. Do not overwrite the
existing bot app, use its signing/Telegram secrets or reuse its data volume.
Do not run two API Machines or initialize a replacement quota database.

## Deployment and domain sequence

1. Finish source review, tests and secret scans for the exact deployment revision.
   Keep unrelated in-progress changes out of the deployment snapshot.
2. Provision the dedicated apps and one new API volume. Confirm the mount, perform
   the explicit one-time budget initialization, then pin that Machine identity.
   With publication still disabled, initialize the IPFS journal exactly once on
   the asset Machine with `node /service/src/init-ipfs-store.mjs`; the initializer
   is copied into that image and refuses an existing journal.
3. Supply the allowlisted runtime settings and deploy each service without HA.
   Confirm health checks and the web-to-API boundary on the actual Machines.
4. Attach the website's main hostname and optional `www` hostname to the **web**
   app, using `fly certs add`. The API can keep its Fly-provided hostname.
5. Copy the exact records from `fly certs setup` to the domain provider. Replace
   only conflicting parking/website records; preserve email/MX and unrelated TXT
   records. Never put application credentials into DNS. Run `fly certs check`
   after propagation and set any canonical-host redirect in the web service.

No DNS targets should be guessed or copied from another app. The domain is known;
no new user parameter is required to finish packaging and validation.

References: the installed Vinext README documents standalone Node output;
[Fly volumes](https://fly.io/docs/volumes/overview/) and
[custom domains](https://fly.io/docs/networking/custom-domain/) describe the
remaining deployment and DNS steps.
