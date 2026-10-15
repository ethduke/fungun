# Automatic Fly staging

The existing website at `https://farmgun.fun/` remains production. Staging is a
separate copy of the same web source at `https://farmgun-staging-web.fly.dev`,
backed by `farmgun-staging-api` on a separate Fly private network. Neither
production app, its secrets, nor its volume is used by this workflow.

## Release path

After the **Webview checks** workflow succeeds for a push to `main`, **Deploy
staging** verifies the exact current main SHA and all three required GitHub
Actions checks: `webview`, `production-build`, and `repository-safety`. PR/fork
workflow runs cannot trigger a release. A second check immediately before
deployment skips a superseded main commit. Deployments are serialized and are
never cancelled halfway through rollback.

The job builds credential-free web/API images from that SHA, adds source and
release labels, and pushes versioned tags to each staging app's Fly registry.
The version is `sha-<commit>-<run-id>-<attempt>`; it is not reused on reruns.
Deployment uses the pushed digest rather than a mutable version tag.
After an immediate update, Fly may briefly report the previous image while the
Machine is `replacing`. Both deployment and recovery wait up to one minute for a
started Machine with the expected digest before probing the HTTP endpoints.
If an idle Machine remains stopped after an update, recovery explicitly starts
it only once its desired configuration names the selected image digest.

Before changing either Machine, the job captures both deployed image digests and
refreshes a `rollback` tag for each previous image. A failed Fly deployment, wrong
deployed digest, failed health check or failed mocked preparation request restores
the affected previous images and verifies the restored pair. The run still fails
after a successful rollback. A failed rollback is reported as a failed release.
The first release has no previous image: failed first-release Machines are
removed instead of being left available for autostart.

The workflow retains a small JSON record with both previous/new digests and the
rollback result as a GitHub artifact for 30 days. It contains no request bodies,
wallet identities, provider errors or credentials. Fly does not guarantee permanent
registry retention, so this is an immediate/previous-release rollback mechanism,
not an indefinite image archive. No image cleanup job deletes the previous image.
Image rollback does not reverse configuration changes; staging has no migrations
or persistent database to reverse.

## What the checks exercise

Fly's service checks probe `/healthz`. The release also checks both public health
endpoints, rendered web HTML, and a synthetic `POST /api/launch-prepare` through
the web proxy to the mock API. The response must identify itself as mock staging
and contain an empty transaction list. Cold-start retries are bounded.

The staging API uses the existing request/origin/body validation and an in-memory
request budget, but does not construct provider clients, launch adapters, wallets,
payment facilitators, or agent credentials. Catalogs show unavailable launchpads;
mock preparation is a deployment protocol check, not a live launch demo. It cannot
reserve, claim, publish, sign or send a real transaction. Its entry point refuses
production app identities and provider/wallet credentials. Staging Fly apps must
have no secrets; deployment refuses them if any are added manually.

The ordinary production API entry point and persistent-storage requirements are
unchanged. CI's mocked launch/payment/agent suites still run with `--network none`.

## Credentials, approval and cost

The `staging` GitHub environment permits protected branches only. It holds two
separate app-scoped Fly deploy tokens, `FLY_STAGING_API_TOKEN` and
`FLY_STAGING_WEB_TOKEN`. They expire after one year: renew them using
`fly tokens create deploy --app <staging-app> --expiry 8760h` and replace the
matching environment secret without printing or committing the token. An expired
token fails deployment; it does not bypass CI or fall back to production access.

The `production` environment requires the repository owner's approval, disallows
administrator bypass and permits protected branches only. There is no automatic
production workflow and no production Fly token in GitHub Actions. Production
remains an explicitly approved operator deployment; do not reuse staging's mock
API process configuration for it. A future production Actions job must use the
protected `production` environment and separately approved credentials.

Each staging app uses one shared-CPU Machine, with no HA spare, no volumes, no
dedicated IPv4 and no separate build server. The web Machine has 512 MiB and the
mock API has 256 MiB. Both stop when idle and restart on a request; they are not
promised to be free (Fly still charges for applicable storage/network/compute).
There are no production DNS changes.

## Manual recovery

In GitHub Actions, select **Deploy staging**, **Run workflow**, branch `main`,
and action `rollback`. Both retained images must have a matching release label
before either app is changed. A first deployment has no retained pair. Run action
`deploy` to rebuild/redeploy the current main commit after its required checks pass.

For a release-record digest recovery outside Actions, use the record's `previous`
image with `fly deploy --app <staging-app> --config fly.staging.<service>.toml
--image <previous-digest> --ha=false --strategy immediate`, for both services, then
run `node scripts/smoke-staging.mjs`. Use the staging app names only. Never change
production as part of a staging recovery.

References: [Fly app-scoped tokens](https://fly.io/docs/security/tokens/),
[Fly image rollback and retention](https://fly.io/docs/blueprints/rollback-guide/),
[Fly autostop](https://fly.io/docs/launch/autostop-autostart/), and
[GitHub protected environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
