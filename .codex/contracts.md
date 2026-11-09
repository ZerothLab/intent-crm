# Shared application contracts

These invariants apply across the API, worker, domain, and web application. Read [the production contract](production-contract.md) for providers, delivery, financial corrections, and current authority checks; [the management contract](management-contract.md) covers commercial records and metrics. Exported schemas in `packages/contracts/src/` define the exact accepted input and output shapes.

## Module boundaries

- `packages/contracts`: shared types and strict validation schemas.
- `packages/database`: PostgreSQL access, Drizzle schema, migrations, and explicit fixture seed.
- `packages/domain`: business commands, permissions, revisions, transactions, and audit records.
- `packages/harness`: bounded provider calls and validated, grounded model output.
- `apps/api`: host authentication, HTTP validation, error mapping, and serving the built web app.
- `apps/worker`: Temporal workflows, activities, and outbox publication.
- `apps/web`: source inspection, forms, navigation, and explicit human decisions.

Do not add framework or Temporal SDK dependencies to the domain. The model cannot directly query or modify business state. The browser cannot grant itself a role, tenant, or recipient authority.

## Authentication and tenancy

Password sessions are host-issued, persisted as hashes, and bound to current active membership. Password-mode authentication uses HttpOnly, SameSite=Strict cookies; production also requires Secure cookies and an exact configured HTTPS origin. Unsafe password-mode requests require an exact Origin match, including login and logout. Forwarded client addresses are trusted only through configured proxy rules.

Development sessions require explicit development configuration and loopback access. Production must reject development authentication. A 401 must never silently log the browser back in as an administrator.

Every read and write is tenant-scoped. Sales and engineer access is additionally constrained by current customer ownership. Composite tenant foreign keys prevent cross-tenant relationships. Domain entry points resolve fresh membership and reject stale authority versions. Losing customer access also removes access to the member's conversations about that customer.

Member changes require the current revision and preserve the final active administrator. Changes to role, activation, email, or credentials revoke sessions and advance authority. Previously issued approvals do not revive when access is later restored.

## Evidence, planning, and execution

Evidence remains immutable source material. Source import, planning request, and outbox event commit together. Evidence deduplication is scoped to the tenant and customer. A worker receives identity from trusted persisted state, not model output.

Planning accepts only grounded source IDs and exact quotes from the supplied authorized context. Candidate facts require separate human review. Neither a fact review nor an assistant reply silently changes a formal business field, opportunity stage, contract, or payment.

Plan acceptance creates one action per run. Actions have revisions and stable operation identities. Approval binds the exact content, recipient, delivery configuration, and applicable authority versions. Editing or losing authority invalidates that approval.

Temporal signals are notifications, not permission grants. Activities re-check domain state before execution. Persist the dispatch claim before making an external call; an ambiguous outcome becomes `unknown` and requires explicit reconciliation. Never automatically resend an operation with an unknown external outcome.

Receipts establish delivery outcomes only. A delivered proposal is not customer consent, a signed contract, or payment. Fixture inference and simulated receipts remain visibly identified.

## Product lifecycle

`ProductService` owns customer creation and edits, fact reviews, failed-run successors, private conversations, and the work inbox. Ordinary customer edits cannot transfer ownership; use the handover command.

Conversations are private to tenant and member, including against manager access. User messages and validated replies are persisted atomically under a request ID. Reusing an ID with different input is a conflict. Save-time validation re-checks current customer access, source membership, quote grounding, and permitted application links.

Failed planning can create an idempotent successor with a new workflow identity while retaining the previous error and history. Runs with an action or unknown delivery are not retried through the planning-retry path.

Workspace names are administrator-editable with optimistic revision checks. The login identifier is stable. Bootstrap creates a new empty workspace, administrator, and Fixture configuration; it never resets an existing workspace.

## Persistence and validation

Commands validate strict input schemas and return explicit validation, authorization, missing-resource, or revision/state-conflict errors. Business mutations and audit events share a transaction. Preserve the customer-scope-first lock order and avoid holding database connections across model inference.

Applied migrations are immutable. New schema changes must preserve existing business records and use a new migration. Seeds are explicit fictional fixtures for disposable environments and must not run against production.

Tests must cover tenant and ownership denial, stale revisions and authority, grounding, duplicate execution, unknown-outcome reconciliation, session revocation, final-administrator protection, and the affected business invariants with real PostgreSQL. Workflow changes also require real Temporal verification. Missing infrastructure must be reported as unverified, not passed.
