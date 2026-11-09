# Project instructions

Intent is an AI-native CRM with a React/Vite web application, NestJS API, PostgreSQL/Drizzle data layer, and Temporal worker in a strict TypeScript pnpm workspace.

## Architecture and authorization

- Read [the shared contracts](contracts.md) and [the production contract](production-contract.md) before implementing changes. Commercial and management changes also follow [the management contract](management-contract.md).
- Keep shared contracts and root configuration coordinated across contributors. Respect module boundaries described in [the architecture](architecture.md).
- All business writes go through domain commands. Trusted tenant and actor identity come from the host, never model output or client tenant headers.
- Evidence, proposals, approvals, dispatch, and receipts are distinct. Approval binds the exact revision. Unknown external outcomes block automatic redispatch.
- Revalidate current membership, authority versions, customer scope, and affected resource versions at the command boundary. Preserve transaction lock order and last-administrator protection.
- Applied database migrations are immutable. Add a new migration for subsequent changes.
- This is an independent project. Do not import another application's code or credentials without explicit authorization and compatible licensing.
- Do not acquire credentials, make paid provider calls, send customer messages, deploy, or commit without applicable authorization.

## Truthful behavior and documentation

- Fixture models and simulated delivery must stay visibly labeled. Local verification does not establish live provider, gateway, or production deployment validation.
- English is the default for public documentation, source comments, and interface copy. Support Simplified Chinese through translation catalogs; never rewrite original customer evidence as a translation.
- Root `README.md` and `docs/` address product users and deployment administrators. Keep engineering instructions, local paths, test identifiers, task history, and acceptance logs out of them. Public product documentation must not link into `.codex/`.
- Maintained engineering guidance belongs here. Local memory, work plans, logs, and acceptance screenshots may also be stored here but are excluded from Git by the explicit allowlist.
- Keep source, tests, migrations, and runnable scripts in their existing package locations. Documentation organization is not a reason to move application code.
- Preserve truthful limits: external providers and gateways require configuration; payment/refund records do not initiate bank transfers.

## Verification

Follow [the development guide](development.md). Run typecheck/build and meaningful business, tenancy, access-control, and recovery tests for affected behavior. Use a disposable database, require real Temporal tests for workflow changes, and report skips and unverified infrastructure honestly. Never use production customer data or credentials in fixtures.
