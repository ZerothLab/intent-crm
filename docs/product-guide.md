# Product guide

## Set up your workspace

Sign in with your workspace identifier, email, and password. An administrator can change the workspace name, add members, set initial passwords, and configure customer fields. Share initial credentials through your organization's existing secure channel. Members can change their own password in Account settings. Changes to passwords, roles, activation status, or login email revoke existing sessions.

English is the default interface language. Choose **中文** in the language menu to use Simplified Chinese. This changes labels, prompts, and newly requested AI explanations without translating customer data or rewriting existing records. The preference is saved in the browser. Dates used for business deadlines remain based on Asia/Shanghai; amounts remain in CNY.

## Access control and audit

Open **Manage → Access and audit** to view the role permissions. These permissions apply to API requests, AI context, business commands, and background execution.

| Role | Customer scope | Responsibilities |
| --- | --- | --- |
| Administrator | All workspace customers | Manage members, workspace and integration settings; perform business operations; inspect audit history and recover stalled planning |
| Manager | All workspace customers | Manage sales activity, customer handovers, tasks, delivery reconciliation, contracts, collections, refunds and forecasts |
| Sales | Assigned customers | Maintain customer records; add and verify evidence; review actions; manage owned opportunities; complete assigned tasks |
| Engineer | Assigned customers | Read customer records; add evidence; use the assistant; complete assigned tasks |

Members can read the team directory, model metadata, and field definitions. Only administrators can change these settings. Private assistant conversations remain private to their creator, including from administrators, and still require current customer access. AI suggestions cannot change permissions or authorize their own execution.

Member edits require the current revision. If someone else has edited a member, reload before applying a change. The last active administrator cannot be disabled or demoted. Disabling and re-enabling an account does not restore old sessions. An approval made before a change to the approver's or execution owner's access cannot be dispatched without another review.

Administrators can filter audit history by category or acting member and page through events. Access changes show the previous and new role/status and whether sessions were revoked. Passwords, provider keys, and private business prose are excluded from this view. Audit history is read-only.

## Configure models

Open **Manage → Model settings**. Administrators can add or edit a connection:

1. Choose **DeepSeek**, **OpenAI-compatible**, or **Fixture demo**.
2. Enter a display name and the provider's model identifier. Custom endpoints also require an approved HTTPS base URL.
3. Choose the purpose: **Reasoning** handles conversation, proposal planning, and next-step recommendations; **Extraction** identifies candidate facts from evidence.
4. Enter the provider credential. A blank credential during an edit keeps the saved value when the provider and endpoint are unchanged.
5. Save, run **Test connection**, and activate the tested revision. Only one connection per purpose can be active. Test requests use the configured provider and may incur usage charges.

Editing a connection disables it and clears its previous test result. Test and activate the new revision before using it. Configure both purposes to use real inference throughout the planning flow. The deterministic Fixture provider is explicitly labeled and does not call an external model.

If credentials cannot be saved, ask the deployment administrator to configure encryption. If a custom hostname is rejected, it must be added to the deployment allowlist. See [Integrations](integrations.md).

## Start from the workbench

The workbench shows whether reasoning and extraction use a tested provider or a deterministic demo, with a direct link to model settings. Delivery is labeled separately as simulated or real. Administrators can configure both; other members can inspect the current model settings.

Suggested focus follows the current work records: uncertain outcomes, failed planning and overdue tasks come first, then candidate fact reviews and pending decisions. Candidate facts leave the review queue after confirmation or rejection. Customer handover transfers outstanding review visibility to the new owner. Engineers can contribute evidence to assigned customers and complete assigned tasks; sales decisions remain with authorized owners and managers.

When no work is pending, choose a customer to see the next available step in its evidence, review and feedback cycle. A recorded receipt proves delivery only; add the customer's reply as evidence when it arrives.

## Work from customer evidence

Create a customer with a contact, email address, and owner. Add meeting notes, correspondence, or customer feedback as evidence. Text imports preserve the source exactly; split documents longer than the stated limit into complete sections.

The planning record shows queued, running, review, failed, or completed status. The selected extraction model proposes facts with exact source quotes; candidate facts require human confirmation. A candidate is not a verified customer commitment. Reject unsupported facts with a reason rather than deleting their history. Repeated analysis preserves existing reviews of identical source statements; new evidence remains available for a fresh review.

The assistant has a private conversation history for each member. It can use recent authorized turns and current records, cite sources, and offer links to review work. Large histories use a bounded selection; ask for missing evidence explicitly when necessary. Messages in the same conversation are processed one at a time so each answer can use the preceding turn. Repeating a completed request returns its saved result. Managers do not gain access to other members' private conversations. Losing customer access also removes access to related conversations.

## Review actions and outcomes

Open a draft from the customer workspace, workbench, or Action center. Check its recipient, content, sources, revision, and delivery mode before approving. Editing creates a new revision and clears approval. Approval does not itself prove delivery.

Cancel an undispatched action with a reason when it should not proceed. Cancellation closes its open commitments and retains the original draft and audit history. Executing or uncertain actions must be reconciled, not cancelled. Managers can take over an eligible action after its original initiator becomes unavailable; takeover requires a new approval.

In real gateway mode, the delivery attempt is recorded before contacting the gateway. A confirmed response or signed event creates a real receipt. A timeout or ambiguous response leaves the outcome uncertain and prevents automatic resend. An administrator or manager must verify the external outcome and record a traceable reference. Confirmed non-delivery creates a new operation identifier and requires another approval.

Signed customer replies become new evidence and start another planning cycle. A delivery receipt does not imply the customer read, accepted, signed, or paid for a proposal.

## Advance opportunities

An opportunity has its own amount, stage, expected closing date, forecast category, owner, and next step. Customer communication status is separate from opportunity stage.

To request a next-step proposal, choose a confirmed fact, state an internal goal, and set a deadline. The assistant receives the source, current opportunity, prior proposal decisions, and recorded outcomes. Review its recommendation before applying it. Applying a proposal updates only the next step and deadline. Dismiss a proposal with a reason when it does not fit. Stale opportunity or fact revisions require a new review.

Managers can assign intervention tasks. The assignee or a manager records completion with a result; managers can also reschedule, reassign, cancel, or reopen tasks. Completing a task does not automatically resolve a business risk or close a sale.

Use **Transfer customer** to move a customer, open opportunities, open tasks, and eligible pending work together. Ownership cannot be changed through ordinary customer editing. Existing approvals are invalidated, and the former owner loses access unless their current role grants workspace-wide access. Historical contract and payment attribution remains with the original owner.

## Contracts, collections, and corrections

Administrators and managers register signed contracts with an amount, signing date, unique reference, and installments. Registration marks an opportunity as won and fixes historical ownership. Installments must total the contract amount.

Record payments using actual evidence and unique references. Amounts cannot exceed the remaining installment balance. Repeating an identical reference and payload returns the original entry.

Use **Financial corrections and refunds** to:

- Reverse an incorrectly entered payment with supporting customer evidence and a reason.
- Record a partial or full refund that has already occurred, with its date, reference, evidence, and reason. Refunds reduce net collections and reopen the installment balance.
- Reverse an incorrect refund entry when doing so would not overpay the installment. Correct any replacement payments first.
- Cancel a contract registration after its payments have been corrected or fully refunded. Cancellation reopens the opportunity for review; historical records remain available.

These operations do not move money. They append an audit trail and retain the original amounts. Current totals reflect corrections; refunds affect the month of their actual refund date. Saved forecast snapshots never change.

## Management and recovery

The Business overview shows targets, bookings, net collections, forecasts, owner contributions, and transparent risk rules. Forecasts are sums of recorded categories, not model-generated probabilities. Missing targets remain visibly unset. Capture a snapshot to preserve a period's forecast for later comparison.

Administrators can open **Delivery and runtime** to inspect database availability, worker heartbeats, pending events, stalled planning, and uncertain actions. Restore the worker or provider first. Select a stalled run and explain the recovery reason to create a new attempt. Recovery is available only after five minutes, only before an action exists, and never redispatches an uncertain delivery.

## AI request availability

Interactive generation and model tests share workspace limits: two simultaneous requests and twenty starts per minute per member, with eight simultaneous requests and 120 starts per minute per workspace. If capacity is reached, wait a minute before retrying. Reload the record after an interrupted request to check whether its result was saved. A process interruption releases reserved capacity after three minutes. These controls bound request volume; they do not measure tokens or enforce a provider spending budget.
