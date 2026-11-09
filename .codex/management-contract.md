# Commercial and management contracts

`CommercialService` owns opportunities, targets, forecast snapshots, intervention tasks, contracts, installment receivables, payments, refunds, and evidence-backed corrections. Exact schemas live in `packages/contracts/src/management.ts` and `packages/contracts/src/advancement.ts`. The [production contract](production-contract.md) defines correction and handover rules.

## Authority and revisions

Every command re-checks active membership and customer scope. Administrators and managers have tenant-wide management authority. Sales edits also require opportunity ownership; engineers are read-only for commercial records but may complete assigned tasks they can currently access. Related records and evidence must belong to the same tenant and customer.

An opportunity has a stable customer, independent stage, owner, amount, expected close date, and revision. Edits use `expectedRevision` and append history with actor, explanation, and before/after state. Stage changes update stage-entry time. Lost opportunities require a reason; reopening preserves history. Recording a contract marks an opportunity won atomically. Sending a message never changes its stage.

Customer handover transfers open work through the dedicated command and preserves historical contract attribution. Ordinary editing cannot bypass ownership checks or strand open work with a person who cannot access it.

## Money and business records

All amounts are integer CNY cents with safe-integer checks. Customer budget is not an opportunity amount. Contracts, payments, and refunds record business events; they do not initiate transfers, reconcile a bank account, or recognize accounting revenue.

Contract registration atomically creates installments, marks the opportunity won, and appends history and audit. Installments must sum exactly to the contract amount; due dates cannot precede signing. Historical owner attribution is fixed when the contract is recorded. References are unique within their defined tenant scope.

Payment and refund commands use idempotency identities and row locks. Identical retries return the existing record; conflicting payloads fail. Payments cannot exceed the remaining installment balance. Refunds cannot exceed the associated active payment. Corrections preserve original records and require actor, evidence, and explanation.

Financial commands lock contracts before installments. A payment with active refunds cannot be reversed. Cancelled contracts create no live receivable, and re-registration retains the prior contract history. Current bookings exclude cancelled contracts; net collections subtract active refunds on the refund's own business date.

## Targets, tasks, and advancement proposals

Targets are versioned by month and owner, with a workspace-wide scope when owner is absent. Missing targets and attainment ratios remain null rather than manufactured zeroes. Forecast snapshots are immutable and preserve both the calculated metrics and underlying opportunity projection.

Tasks have an active assignee with customer access, a due date, and revision. Completion requires an outcome note. Managers may reassign, reschedule, cancel, and reopen tasks; history remains. Completing a task does not automatically advance a deal or eliminate its risk.

Advancement proposals use a person-defined goal, deadline, and confirmed fact from the same customer. Generation re-checks current model readiness and customer/opportunity access before persistence. The proposal preserves the source quote and source, opportunity, and proposal revisions. Candidates, rejected facts, or stale review revisions cannot supply confirmed evidence.

Applying a proposal re-checks exact revisions, authority, source review, and model configuration. It updates only the next step and its due date. It cannot change amount, stage, forecast category, source evidence, or delivery state. Decisions and opportunity history commit together. Request IDs and decision replay rules prevent duplicate application.

## Metric definitions

The pure `calculateManagementOverview` function receives explicit dates and data. The backend reads the source records in a consistent transaction. Currency is CNY and business dates use Asia/Shanghai.

- Bookings: active contract amounts signed in the selected month, attributed to the recorded historical owner.
- Collections: active payments in the month minus active refunds dated in the month, preserving historical owner attribution.
- Receivables: active installment balances based on net collections. Monthly due amounts and monthly cash flow are separate measurements.
- Overdue balances: unpaid amounts with due dates before the as-of date, including prior periods.
- Base forecast: selected-period bookings plus open `commit` opportunities expected to close in that period. Upside adds `best_case`; categories are mutually exclusive and are not calibrated probabilities.
- Attainment and forecast gap: calculated only when the corresponding target exists. Forecast gap has a lower bound of zero.
- Closed win share: current won/lost records with close dates in the period. Reopening changes the current historical view; stored snapshots preserve prior observations.
- Risk prompts: overdue expected close or next-step dates, missing next steps or deadlines, at least 14 days in stage, or missing evidence. These are transparent rules, not industry benchmarks or predictions of failure.

Snapshot differences distinguish added, removed, and changed opportunities. Moving an opportunity to a different period is not proof of a lost deal. Missing data is not invented. Dashboard totals and snapshots use the same authoritative calculation.

## Verification

Cover tenant isolation, role and ownership denial, stale revisions, immutable history, exact money arithmetic, missing targets, snapshot immutability, payment/refund idempotency, concurrent balance limits, and evidence-backed proposal application. Demo data uses a fixed fictional period; tests must not create real customer records or send messages.
