# Deployment guide

Intent runs as an API and web service, a Temporal worker, and PostgreSQL. Model connections and customer delivery are configured per workspace. Start in simulated mode, validate your integrations, then enable live services for the intended workspace.

For an existing installation, read [Upgrades and data preservation](upgrade.md) first. Do not replace an existing database with a new example volume.

## Prerequisites

- Docker Engine and Compose v2, plus access to the [published Intent image](https://hub.docker.com/r/zerothlab/intent-crm).
- PostgreSQL 16, provided by the production Compose file with an external persistent volume. The database port is not published to the host.
- A persistent Temporal service on a protected internal endpoint and an existing namespace. The development CLI is not a production service. This distribution does not configure Temporal mTLS or API-key authentication; do not point it at a service requiring either without adding that integration.
- An HTTPS reverse proxy serving the web application and `/api` on the same origin. The default host binding is `127.0.0.1:3100`. A proxy in another container needs an explicitly reachable network address.

## Get the release

The current published version is [v0.4.0-rc.1](https://github.com/ZerothLab/intent-crm/releases/tag/v0.4.0-rc.1), a prerelease for evaluation before production adoption. Its image supports `linux/amd64` and `linux/arm64`. Obtain the matching deployment files and application image:

```sh
git clone --branch v0.4.0-rc.1 --depth 1 https://github.com/ZerothLab/intent-crm.git
cd intent-crm
docker pull zerothlab/intent-crm:0.4.0-rc.1
```

Set `INTENT_IMAGE=zerothlab/intent-crm:0.4.0-rc.1` in `.env.docker`. To pin the verified multi-architecture image immutably, use this value instead:

```dotenv
INTENT_IMAGE=zerothlab/intent-crm@sha256:bdc1acfe1544b2adefb36f6fa59102a76fc68b7f7375cd342fd86ad1bee4537b
```

### Optional: build your own image

For a customized installation, build from the checked-out source:

```sh
docker build -t intent-crm:local .
```

Set `INTENT_IMAGE=intent-crm:local` and use `docker compose --env-file .env.docker -f compose.production.yaml pull postgres` instead of pulling the application image in the steps below. This local image contains your checked-out source and changes; validate it before use.

## Configure the installation

Copy `compose.production.yaml` and `.env.docker.example` to the deployment directory:

```sh
cp .env.docker.example .env.docker
chmod 600 .env.docker
```

Set these values in the protected environment file or your secret manager:

| Setting | Purpose |
| --- | --- |
| `INTENT_IMAGE` | Your tested image version or immutable digest |
| `INTENT_POSTGRES_VOLUME` | The actual persistent volume; reuse the existing name during upgrades |
| `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD` | Database identity; changing these variables does not rename existing database objects |
| `DATABASE_URL` | Matching credentials and database, using the Compose hostname `postgres`; percent-encode special password characters |
| `INTENT_PUBLIC_ORIGIN` | Exact public HTTPS origin, such as `https://crm.example.com`, with no trailing slash or path |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` | Protected Temporal endpoint reachable from both application containers |
| `INTENT_ENCRYPTION_KEY` | Canonical Base64 encoding of a random 32-byte key; required to save external model or gateway credentials |
| `INTENT_MODEL_ALLOWED_HOSTS` | Comma-separated custom model hostnames; DeepSeek's official hostname is included automatically |
| `INTENT_DELIVERY_ALLOWED_HOSTS` | Comma-separated approved public gateway hostnames |
| `INTENT_BIND_IP`, `INTENT_HTTP_PORT` | Reverse-proxy-facing listener, defaulting to `127.0.0.1:3100` |
| `INTENT_TRUSTED_PROXIES` | Optional comma-separated proxy IP addresses or CIDR networks whose forwarded client addresses may be trusted; empty by default |

Supply the same encryption key and hostname policies to the API and worker. Back up the key separately and securely. Intent never returns stored provider credentials to a client. Model or delivery credentials can be replaced in settings. Changing the master key requires re-entering all encrypted credentials; automatic key rotation is not provided.

Keep deployment secrets out of Git, image layers, command arguments, and logs. Preserve the Origin header at the reverse proxy. Configure request limits and provider budgets appropriate to your team.

By default, authentication throttles use the directly connected address and ignore forwarded client addresses. Behind a reverse proxy, this can put multiple users in the same source limit. Set `INTENT_TRUSTED_PROXIES` to the exact proxy peers or tightly scoped proxy networks when individual client addresses are needed. The edge proxy must replace untrusted `X-Forwarded-For` values with the actual client address, and any intermediate proxies must preserve a verified chain. Never trust broad Internet ranges or a network containing untrusted clients. Incorrect proxy trust can let a client evade source-based login throttling. The API rejects invalid proxy IP/CIDR configuration at startup.

## Initialize and start

```sh
# Only for a NEW installation. Existing installations must reuse their real volume.
docker volume create intent-crm-production_intent-postgres
# Validate without printing expanded secrets.
docker compose --env-file .env.docker -f compose.production.yaml config --quiet
# For a locally built application image, pull only postgres instead.
docker compose --env-file .env.docker -f compose.production.yaml pull
# Check application settings before starting services; this does not contact integrations.
docker compose --env-file .env.docker -f compose.production.yaml run --rm --no-deps api check
docker compose --env-file .env.docker -f compose.production.yaml run --rm bootstrap
docker compose --env-file .env.docker -f compose.production.yaml up -d --no-build api worker
```

Bootstrap waits for the database and applies migrations. It asks for a workspace identifier, workspace name, administrator name, email, and a hidden password of 12–128 characters. It creates no customer examples. Repeating an existing workspace identifier does not overwrite it. Do not run `db:seed` against a real team's database.

For automated bootstrap, supply `INTENT_BOOTSTRAP_WORKSPACE_ID`, `INTENT_BOOTSTRAP_WORKSPACE_NAME`, `INTENT_BOOTSTRAP_ADMIN_NAME`, and `INTENT_BOOTSTRAP_EMAIL` to the bootstrap container, and use `bootstrap --password-stdin` with a protected input stream. Never place the password in an argument or source file.

The image forces password authentication and disables development login. It runs as a non-root user with a read-only filesystem, temporary writable storage, and a private executable cache for its native workflow dependency. The API and worker restart independently.

Application startup rejects an invalid database URL, HTTPS origin, explicit Temporal address, or configured encryption key before launching the service. A blank encryption key is allowed for Fixture and simulated operation. Configuration checks do not establish database connectivity, matching encryption keys, or provider availability.

Sign in, create team accounts, configure both model purposes, and review [the integration contract](integrations.md) before enabling real gateway delivery. New workspaces start with the Fixture demo provider and simulated delivery. Keep at least two active administrators: password recovery email, SSO, and MFA are not included.

## Health and recovery

- `GET /api/health` checks API/database liveness.
- `GET /api/ready` checks the database and a recent worker heartbeat. The worker updates its heartbeat only while running and after contacting Temporal. It returns 503 if no heartbeat is newer than 30 seconds.
- **Delivery and runtime** shows the workspace's pending events, oldest pending event, stalled runs, uncertain actions, and last heartbeat. Stalled planning can be recovered after five minutes if no action exists.

Readiness does not prove provider availability or successful customer delivery. Monitor gateway failures, model budgets, Temporal queue latency, database capacity, and backup completion separately. In a shared database, readiness means at least one worker has recently reported; keep application services on a consistent Temporal configuration.

```sh
docker compose --env-file .env.docker -f compose.production.yaml ps
docker compose --env-file .env.docker -f compose.production.yaml logs --tail=100 api worker
```

An unavailable worker leaves durable requests pending. Restore the worker before retrying failed planning. Unknown delivery outcomes must be reconciled against external records and cannot be automatically resent. Never enable development login to recover a real account.

## Backups and upgrades

Back up PostgreSQL, Temporal persistence, and the encryption key. Database backups include customer and authentication data; protect them as production secrets. Schedule backups according to your recovery objectives and keep an encrypted copy outside the application host.

Use the `scripts/backup.sh` utility included with the release source. Run it from the deployment directory, with a new filename in an existing private directory owned by the backup operator:

```sh
sh scripts/backup.sh "/secure/backups/intent-crm-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

The utility streams a consistent PostgreSQL custom archive into a private temporary file, checks its archive index, and only publishes the requested filename after both commands succeed. It refuses to overwrite an existing backup and removes incomplete files after an error or normal termination signal. It accepts optional environment-file and Compose-file paths as its second and third arguments. Monitor its exit status; an archive index check does not replace a full restore rehearsal. Protect the backup directory against other writers and avoid deleting the last verified backup during retention cleanup.

Rehearse restoration into a separate PostgreSQL 16 instance and database with no production network access. Use `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges` with the custom archive, and verify workspace records and authentication before reconnecting any worker. Restore the corresponding encryption key and Temporal persistence according to your recovery plan. Never run a rehearsal against the production database or permit the restored worker to contact live model or delivery services.

After a real recovery, reconcile customer deliveries and financial entries that occurred after the recovery point before enabling live execution. Preserve the gateway's idempotency records: restoring a database cannot undo an external message or payment. Keep API and worker versions consistent with the restored schema and validate `/api/ready` after recovery.

Choose a tested new image or digest, then:

```sh
docker compose --env-file .env.docker -f compose.production.yaml pull
docker compose --env-file .env.docker -f compose.production.yaml stop api worker
docker compose --env-file .env.docker -f compose.production.yaml run --rm migrate
docker compose --env-file .env.docker -f compose.production.yaml up -d --no-build api worker
```

Do not start a new version after a failed migration. Migrations are forward-only and checksum-verified; do not edit applied SQL. Rollback requires a compatible image and corresponding restored backup. The external PostgreSQL volume survives Compose removal, including `down -v`; explicitly deleting that volume destroys its data. Never mount it into two PostgreSQL processes at once.

Before live operation, rehearse a restore into an isolated environment, validate actual provider/gateway credentials, test the public HTTPS route, and assess the expected load. Automated repository tests cannot certify your external infrastructure or recovery process.
