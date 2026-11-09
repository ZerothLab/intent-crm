# Production integration and lifecycle contract

This contract defines the current provider, lifecycle, delivery, financial correction, and access-control invariants. It complements the [shared application contracts](contracts.md) and [commercial contracts](management-contract.md).

## Models and context

Model settings are versioned and administrator-only. Credentials use AES-256-GCM with a deployment-provided 32-byte key and tenant/connection AAD. Public projections never include ciphertext or plaintext. Editing disables a connection and clears test results. A real connection must pass a test for the current revision before activation; one connection per tenant/purpose is active. Re-check configuration and current membership after generation.

Supported providers are Fixture, DeepSeek, and OpenAI-compatible Chat Completions. Provider outputs must match strict schemas, then pass domain evidence and ownership validation. HTTPS endpoints require approved public hostnames; DNS addresses are validated and pinned, redirects are forbidden, and time, request, response, and context size are bounded. No untrusted model output determines actor, tenant, permission, recipient authority, or business commands.

Conversation generation receives a bounded selection of the initiating member's private turns plus current authorized records. Next-step generation includes prior decisions and current action/task/financial outcomes. Evidence quotes remain verbatim. Original records are never truncated in storage. Missing or omitted context cannot be asserted as fact.

## Work continuity

Cancellation is limited to undispatched draft/approved/failed actions, requires a revision and reason, clears approval, closes commitments, and wakes the workflow into a terminal state. Unknown/executing outcomes require reconciliation. Manager takeover preserves the original initiator, assigns current execution responsibility, and requires new approval.

Customer handover atomically transfers the customer, open opportunities, open tasks, and eligible pending work; it revokes stale access and invalidates pending approvals. Historical signed attribution remains unchanged. Managers can reschedule, reassign, cancel, or reopen tasks; prior results remain in audit history.

## Delivery and recovery

Real gateway configuration is encrypted and administrator-only. Approval binds delivery mode/revision. The worker persists a unique dispatch claim before sending. A positive confirmed response records a real receipt; all ambiguous outcomes become unknown and block automatic redispatch. Verified non-delivery requires a new operation and approval.

Inbound callbacks authenticate timestamp plus exact raw JSON bytes with HMAC-SHA256, validate the originating operation and recipient, and deduplicate event identity/content. Customer replies become evidence and durable planning requests. Conflicting provider events retain the existing receipt and append an audit warning. Gateways must honor the documented non-delivery guarantee.

Worker heartbeats require a running worker and successful Temporal contact. Readiness uses a 30-second heartbeat window. Administrator diagnostics show tenant-scoped backlogs and stalled planning. Recovery after five minutes creates an idempotent successor only before an action exists. Activity deadlines allow both bounded extraction and reasoning requests; database connection, lock, and statement waits are bounded.

## Finance

Financial corrections are append-only commands with actor, evidence, reason, and idempotency identity. Contract cancellation and payment/refund reversal preserve original amounts and markers. Refunds are actual business records with date, unique reference, and amount, not bank transfers. Refund totals cannot exceed a payment. Correcting a refund cannot overpay an installment; payments with active refunds cannot be reversed. Active payments must be corrected or fully refunded before contract cancellation.

Current bookings exclude cancelled contracts. Collections use active payments minus active refunds, with refunds assigned to their own dates and historical owners. Receivable balances use net collections. A cancelled contract creates no live receivables. Re-registering an opportunity is allowed after cancellation; all prior contracts remain available. Forecast snapshots are immutable. Financial commands lock contracts before installments to avoid opposing lock order.

## Language and documentation

English is the default. UI translations use stable English keys; module-level label maps retain source keys and translate at render time. Simplified Chinese is a persisted browser preference, not a CRM business record. API writes and provider requests capture the requested locale where relevant. Source evidence, names, and stored business prose retain their original language. Currency remains CNY and business dates remain Asia/Shanghai.

All public documentation, README files, source comments, and default product descriptions use English. Chinese translation catalogs and original customer content are valid exceptions. Development instructions, memories, reports, and acceptance images remain in `.codex/`.

Migrations: `0009_production_lifecycle.sql`, `0010_refunds.sql`, `0011_financial_lookup_indexes.sql`. Existing applied migrations must not be edited.

## Access-control closure

Member edits require the exact public member revision. Host actors carry an authority version; each command re-reads membership and rejects a stale host context. Role, activation, login email and credential changes advance authority and revoke sessions. Approval binds current approver and execution-owner authority versions; a role or activation round trip cannot restore old approval. Final-admin protection remains transactional.

Ownership changes go through handover, never ordinary customer editing. Customer scope locks precede dependent opportunity/task/action/fact/planning locks, including dispatch completion and inbound receipt paths. The existing claim remains the authorization boundary for an operation already dispatched; revocation cannot recall its external effects.

`/settings/access` explains the four roles in both languages. `/api/settings/audit` is administrator-only and returns tenant-scoped, paginated metadata plus a safe role/status change projection. No credential or business-body field is exposed. Browser account changes discard earlier in-flight successful responses. Migration `0012_access_control.sql` adds these bindings and returns pre-upgrade approved actions to draft without changing completed or unknown outcomes.

## Product maturity controls

Candidate fact reviews are first-class `WorkInbox.facts`, scoped to current customer access and absent for engineers. Decisions remove candidates from the queue; handover transfers visibility. Workbench suggestions are transparent record-derived priorities, not predictive AI scores.

Planning carries reviewed facts into reasoning alongside extracted candidates. Compatible providers must ground extraction before reasoning and validate citations, links and recipients against exactly the bounded supplied context. Omitted evidence, facts, fields and outcomes are disclosed to the provider; no omitted source can validate a returned citation.

`0013_ai_requests.sql` supports durable shared API admission. Conversation generation is serialized by tenant/member/conversation; stored request IDs replay successful turns. Advancement request IDs and model-test revisions have their own keys. Claims use brief transactions, hashed keys, a three-minute crash lease and bounded concurrent/recent counts. No database connection spans provider inference. Resource authorization and current model configuration are checked again inside admitted work, and domain persistence revalidates access. Admission is a request-volume guard, not a token budget or an exactly-once provider billing guarantee. Worker concurrency is bounded to four activities per process and Temporal publication/heartbeat RPCs have cancellable ten-second deadlines.

## Release boundary and recovery controls

Planning revalidates current customer access, membership, run state and model bindings after extraction and before reasoning. A previously committed action wins over further inference. Identical source/key/value/quote facts are not reinserted by subsequent plans; existing human review and revision remain authoritative. Plan acceptance takes the customer lock before the planning-run lock so concurrent acceptance and fact review serialize.

Model and delivery host allowlists apply at use time, not only at configuration time. A revoked delivery destination invalidates approval before creating a dispatch claim. Historical authenticated callbacks remain reconcilable. A synchronous successful gateway response contains exactly `status: delivered` and a trimmed `reference` of 3–200 characters; every ambiguous or malformed response remains unknown. Outbound bounds are checked before DNS and JSON decoding rejects malformed UTF-8. DeepSeek requests explicitly disable thinking; custom OpenAI-compatible requests omit that provider-specific field. Empty final output cannot substitute a reasoning trace for a validated response.

Proxy trust defaults to disabled. `INTENT_TRUSTED_PROXIES` accepts explicit IP addresses or nonzero CIDR ranges, rejecting aliases, trust-all ranges and IPv4-mapped IPv6 CIDRs. Password login rate limiting uses the address derived by Express from this configured trust boundary; development sessions still require a loopback socket. Rate-limit errors provide bounded retry guidance.

Action and inbox reads fetch receipts in bulk while retaining tenant and customer authorization. Lazy page failures expose English/Chinese recovery and preserve navigation; a failed mutation display never triggers an automatic repeat write. Mobile navigation traps focus, makes background content inert and restores focus on dismissal.

Release verification requires a complete TAP summary with all tests passed and no skipped, cancelled or TODO cases, including real PostgreSQL and Temporal markers. High/critical dependency advisories block the release workflow. Docker build contexts exclude secrets, backups and local engineering history. Unexpected supervised child exit returns failure so service restart policies can recover. Container smoke and backup/restore checks are distinct from live provider, gateway, production workload and infrastructure recovery acceptance.
