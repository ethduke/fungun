# Manual production deployment

`https://farmgun.fun` is served by `farmgun-web`, with `farmgun-api` as its read
API. **Deploy production** runs only when manually dispatched on `main`. Merges,
staging releases, and successful CI runs never start a production deployment.
The workflow's registration and credential setup do not change running services.

## Select and approve a release

1. Open [Deploy staging](https://github.com/ethduke/fungun/actions/workflows/deploy-staging.yml)
   and choose a successful `deploy` run whose web UI you reviewed. Copy the numeric
   run ID from its URL (`.../actions/runs/<id>`). A rollback run is not a candidate.
2. Open [Deploy production](https://github.com/ethduke/fungun/actions/workflows/deploy-production.yml),
   click **Run workflow**, select branch `main`, and enter that staging run ID.
3. The unprivileged `plan` job validates the source workflow, same repository,
   protected-main ancestry, successful staging run, healthy release record,
   immutable API/web digests, and the latest successful `webview`,
   `production-build`, and `repository-safety` checks on the selected commit.
   It accepts an older tested main commit as well as the current main commit.
4. Read the `plan` job's summary: source staging run, commit, and both image
   digests. The `production` job waits before receiving any Fly credentials.
5. In that workflow run, click **Review deployments**, select **production**,
   then **Approve and deploy**. Only `ethduke` is a configured reviewer;
   administrator bypass is disabled. **Reject** or cancel to leave production
   untouched. Self-review is allowed so the sole owner can explicitly approve
   a run they dispatched.

The environment's rules are under repository **Settings → Environments →
production**. These rules protect GitHub Actions jobs using that environment;
they cannot prevent a separate operator with Fly credentials deploying by CLI.
Do not move the four Fly secrets to repository-wide secrets or a job without the
`production` environment.

## What is promoted

After approval, the workflow downloads and revalidates the staging record and
required checks. A staging rerun or changed record requires a new approval run.
It pulls the exact staged image digests, verifies their source/release labels,
and copies them into each production app's Fly registry. **It never rebuilds**
the release. The copied digest must be identical; otherwise deployment stops.
The images get unique `production-<run-id>-<attempt>` tags, but updates use digests.

Staging and production use the same Dockerfiles. Mock behavior belongs only to
staging's Fly process override. Promotion verifies the API image's default command
is `node src/server.mjs` and refuses production Machines with process overrides
or a staging environment marker. It changes only the image on the existing
approved Machines using `fly machine update --image`; it does not apply a staging
TOML file or production template. Runtime origins, provider settings, Fly secrets,
Machine identities, hardware, network settings and the API's existing `/data`
volume stay in place. The API Machine/storage identity and both web/API origins
are checked before updating, and runtime configuration is compared afterward.
No Machine or volume is created, scaled, or reinitialized.

The script accepts exactly the existing single API and web Machines. If one is
replaced intentionally, review and update the IDs in `scripts/fly-production.mjs`
through a PR before deploying. Asset, facilitator, decoder and bot apps are outside
this workflow.

## Health and rollback

Before any production image changes, both existing services must pass health
checks, both previous image digests must be captured, and both images must be
pulled and retained under each app's `rollback` tag. The workflow rechecks the
candidate and refuses an out-of-band production change during preparation.

The API updates first, then the web app, on their existing Machines. Fly waits
for Machine health; the workflow also waits for each started Machine to report
the exact expected digest. Public smoke checks then verify both `/healthz`
endpoints and the website's `/`, `/fees`, and `/llms.txt`, rejecting mock staging
health responses. These probes only send GET requests: no launch preparation,
payment, claim, transaction signing, or transaction submission is performed.
The GitHub jobs have no wallet keys or provider credentials. Existing production
runtime settings are read only in memory, never printed or saved as artifacts.

An update, digest, runtime comparison or smoke failure restores every attempted
service to its captured previous image in reverse order. It verifies the complete
original image pair and repeats health checks. The run remains failed after
successful recovery. A failed recovery is explicitly recorded as `rollback_failed`.
Deployments are serialized and are not automatically cancelled midway through
recovery. With one Machine per service, allow for a brief interruption on update.

`production-release-<run-id>-<attempt>` is a 30-day JSON artifact with the commit,
staging provenance, previous/target image digests, failure phase and recovery status.
It contains no Machine environment, secrets, wallet identities or provider errors.
The approval candidate artifact also lasts 30 days; expired staging records cannot
be promoted. Registry retention is not permanent; the previous-image tag protects
the immediate predecessor, not an indefinite release archive.

For a later manual recovery, obtain the exact `services.<api|web>.previous` digest
from that production artifact. After an explicit operator approval, update each
existing Machine with `fly machine update <machine-id> --app <production-app>
--image <previous-digest> --yes --wait-timeout 120`, then repeat the read-only
health checks. Never deploy a staging process configuration. An alternative is
dispatching this workflow for an earlier retained, successful staging deploy,
reviewing its plan and approving it normally.

This is an image release mechanism, not a database migration or data restore
system. Releases must remain compatible with the current persistent database
and their immediate predecessor; schema changes need a separately reviewed
backup/migration/recovery plan. The workflow runs no database initializer or
migration command, and image rollback cannot undo data writes.

## Credentials and maintenance

The protected `production` environment holds four separate app-scoped Fly deploy
tokens, each expiring after one year:

| Secret | Fly app | Purpose |
| --- | --- | --- |
| `FLY_PROMOTE_STAGING_API_TOKEN` | `farmgun-staging-api` | Pull the selected API image |
| `FLY_PROMOTE_STAGING_WEB_TOKEN` | `farmgun-staging-web` | Pull the selected web image |
| `FLY_PRODUCTION_API_TOKEN` | `farmgun-api` | Copy images and update the existing API Machine |
| `FLY_PRODUCTION_WEB_TOKEN` | `farmgun-web` | Copy images and update the existing web Machine |

Fly app deploy tokens also permit writes to their named app; the promotion script
uses the staging tokens only for registry authentication/pulls. No organization
token is stored in Actions. The existing staging environment keeps its own tokens.
Renew with `fly tokens create deploy --app <app> --expiry 8760h` and replace only
the corresponding production environment secret, without printing or committing
the token. No token enters a Docker build, application image, test process, or
public artifact. An expired/missing token fails the release; it cannot bypass approval.

References: [GitHub deployment review](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments),
[Fly app deploy tokens](https://fly.io/docs/security/tokens/), and the pinned
[Fly Machine update implementation](https://github.com/superfly/flyctl/blob/v0.4.108/internal/command/machine/update.go).
