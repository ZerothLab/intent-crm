# Development and verification

## Requirements

Use Node.js 22.12 or later, pnpm 10.4.1, and PostgreSQL 16. The default local infrastructure uses Docker Engine and Compose v2. Temporal tests and the development server use the official Temporal CLI; the SDK can download it on first use, or `TEMPORAL_CLI_PATH` can point to an existing executable.

## New local workspace

Run these commands from the repository root for a new, disposable development environment:

```sh
npm install --global pnpm@10.4.1
pnpm install --frozen-lockfile
cp .env.example .env
docker volume create intent-crm_intent-postgres
pnpm infra:up
pnpm db:migrate
pnpm db:seed
```

Do not overwrite an existing `.env` or change the database volume, user, or database name when continuing an existing installation. The PostgreSQL volume is external and must be created explicitly. Production upgrades follow the [upgrade guide](../docs/upgrade.md).

Start Temporal in a separate terminal:

```sh
pnpm dev:temporal
```

Start the web application, API, and worker in another terminal:

```sh
pnpm dev
```

Open `http://127.0.0.1:5173` and choose the demo workspace. Default local ports are web `5173`, API `3100`, PostgreSQL `54329`, Temporal `7233`, and Temporal UI `8233`.

The seed contains fictional customer records, a deterministic Fixture model, and simulated delivery. Commercial examples use the fixed period `2026-10`; other periods do not generate fictional performance. Import customer evidence, review the resulting facts and draft, approve its current revision, and inspect the simulated receipt.

Stop application and Temporal terminals with Ctrl+C, then run `pnpm infra:down`. The external PostgreSQL volume and `.local/temporal.db` are retained. Do not remove them to perform an ordinary restart.

## Tests

**Use a dedicated disposable test database.** Integration tests run migrations, insert fixture records, and may change or delete data. `pnpm test` reads `.env`; explicitly override `DATABASE_URL` and never point tests at development records you need to retain or at a production database.

For the default local PostgreSQL instance, create a test database once:

```sh
docker compose exec postgres sh -c 'createdb -U "$POSTGRES_USER" intent_crm_tests'
```

Run the checks:

```sh
pnpm typecheck
DATABASE_URL=postgresql://intent_local:intent_dev_only@127.0.0.1:54329/intent_crm_tests \
  INTENT_TEMPORAL_TESTS=1 pnpm test
pnpm build
node --test scripts/ci-image-tags.test.mjs
```

The database credentials above are only the defaults from `.env.example`. Adjust the test URL to your isolated local instance. With `INTENT_TEMPORAL_TESTS=1`, workflow tests start and stop a real local Temporal server unless `TEMPORAL_TEST_ADDRESS` points to a separately managed, isolated test server. Do not run an application worker against that test namespace.

Without a database or Temporal opt-in, some integration tests skip. A successful command containing skips is not a full validation. CI requires zero skips and verifies permissions, tenant isolation, revision conflicts, evidence grounding, duplicate requests, financial consistency, session revocation, and recovery.

`scripts/acceptance.mjs` and `scripts/product-acceptance.mjs` exercise a running application and mutate records. Run them only against an explicitly authorized, isolated acceptance workspace after reviewing their required environment variables. `pnpm test:product-acceptance` requires `INTENT_ACCEPTANCE_ALLOW_MUTATIONS=true` and can temporarily disable a test model. It must never target a real team workspace.

## Password mode

For local password authentication, change `INTENT_AUTH_MODE=password` and set `INTENT_PUBLIC_ORIGIN=http://127.0.0.1:5173` in `.env`, then run `pnpm admin:bootstrap` and `pnpm dev`. Bootstrap creates an empty workspace and its administrator; it does not insert demo business data. Keep passwords out of shell history and repository files.

Production password authentication requires a same-origin HTTPS deployment. See the [deployment guide](../docs/deployment.md). Real model and delivery providers require administrator configuration and separate credentials; automated fixtures do not verify their live operation.

## Container build and CI

Build the current application from source:

```sh
docker build -t intent-crm:0.4.0 .
```

Use that local image in `INTENT_IMAGE` when following the deployment guide. The Dockerfile installs dependencies inside Linux, runs typecheck/build, and runs the resulting application as a non-root user. Do not copy host `node_modules` into the image. The current source-based runtime retains `tsx` and Temporal bundler dependencies.

The GitHub Actions workflow runs PostgreSQL and real Temporal tests, then builds and smoke-tests the Linux image. `docker/smoke.mjs` requires a disposable PostgreSQL database and valid production configuration: it applies migrations, creates a temporary workspace, checks production authentication and compiled assets, and bundles Temporal workflows. It is not a database-free image check. Use the workflow's invocation as the maintained reference.

Image publication is disabled by default. To enable it, maintainers configure the following under **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
| --- | --- | --- |
| Repository variable | `DOCKERHUB_PUBLISH_ENABLED` | Exactly `true` to authorize registry publication |
| Repository variable | `DOCKERHUB_IMAGE` | Lowercase Docker Hub `namespace/repository`, without registry hostname, tag, or digest |
| Repository secret | `DOCKERHUB_USERNAME` | Docker Hub account with write access to the selected repository |
| Repository secret | `DOCKERHUB_TOKEN` | Access token with the required repository permissions |

With publication enabled, successful `main` pushes publish `edge` and SHA tags. Version-tag pushes publish version and SHA tags; stable versions also update the minor-version tag and `latest`. Pull requests never publish. A manual run publishes only when run from the repository's default branch with the `push` input selected; it still requires `DOCKERHUB_PUBLISH_ENABLED=true` and the destination and credentials above. Other manual runs only build and verify.

A local Docker login does not configure GitHub Actions credentials. Keep runtime database passwords, administrator passwords, and provider keys out of Actions build arguments and repository files. Source publication alone does not establish that a deployable image has been published. Check the actual workflow result and registry digest before using an image reference.
