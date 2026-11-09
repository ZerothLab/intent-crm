# Upgrades and data preservation

Keep the existing workspace, PostgreSQL connection, persistent volume, encryption key, Temporal address, and namespace when upgrading Intent. A fresh-install procedure is not a migration plan.

## Upgrade procedure

1. Record the running image digest and infrastructure configuration.
2. Back up PostgreSQL, Temporal persistence, and the encryption key. Verify that restoration works in isolation.
3. Stop the API and worker, select the tested new image, and apply migrations.
4. Start the new version and verify sign-in, customer records, opportunities, financial history, and pending workflows.

Commands are in the [deployment guide](deployment.md#backups-and-upgrades). Migrations are forward-only. Stop and investigate failures; do not delete new tables or edit migration checksums to bypass them.

The model and lifecycle release adds encrypted provider settings, action cancellation and takeover, handover, delivery ledgers, signed inbound events, financial corrections, refunds, and execution diagnostics. Existing connections remain explicitly labeled Fixture demo connections, and delivery remains simulated until configured. No stored customer evidence is translated. The interface defaults to English unless the browser has saved a Chinese preference.

The access-control update adds member revisions, authority-bound approvals, and an administrator audit view. Existing approvals awaiting dispatch return to draft during migration and require another review. Completed and uncertain delivery records retain their state. Update the API, worker, and web application together; member edits now require the revision returned by the member directory. Customer ownership changes must use the handover operation.

The AI workbench update adds outstanding fact reviews and shared inference admission controls. Apply the new database migration before starting the updated API. Conversation results remain replayable; concurrent messages in one conversation are serialized, and an interrupted request releases its reserved capacity after three minutes.

Set the encryption key and endpoint allowlists on both API and worker before adding external credentials. Preserve the key on subsequent upgrades. Do not run demonstration seeds or bootstrap an existing workspace again.

## Preserve the database

`INTENT_POSTGRES_VOLUME` must reference the actual existing volume. Keep the database user, database name, password, and connection URL consistent with it. Changing environment variables does not rename a database or alter an existing role's password. Never replace your deployment environment file wholesale with an example.

The production volume uses `external: true`. Application removal does not delete it. A missing or mistyped volume fails instead of creating an empty replacement. Never allow two PostgreSQL instances to mount the same data directory.

## Earlier project identifiers

Deployments previously using `rho-crm` should update application configuration while preserving stored data:

| Previous setting | Current setting | Required action |
| --- | --- | --- |
| `RHO_IMAGE` | `INTENT_IMAGE` | Select the actual tested application image or digest |
| `RHO_BIND_IP` | `INTENT_BIND_IP` | Preserve the listener address |
| `RHO_HTTP_PORT` | `INTENT_HTTP_PORT` | Preserve the port |
| Existing PostgreSQL volume | `INTENT_POSTGRES_VOLUME` | Use the original volume |
| Existing database identity | `POSTGRES_USER`, `POSTGRES_DB` | Preserve the actual values |
| `DATABASE_URL`, `POSTGRES_PASSWORD` | Unchanged | Keep valid credentials and database connection |
| `rho_session`, `__Host-rho_session` | `intent_session`, `__Host-intent_session` | Sign in again; passwords are unchanged |

Earlier defaults were `rho-crm-production_rho-postgres` for production and `rho-crm_rho-postgres` for development. Inspect the actual container mounts instead of assuming these names. Stop the previous API, worker, and PostgreSQL before switching configuration; retain the volume. Finish maintenance only after verifying business records and in-progress workflows.
