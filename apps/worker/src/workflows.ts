import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import { APPROVAL_SIGNAL, RECONCILIATION_SIGNAL, RUNTIME_STATE_QUERY, type IntentActivities, type RevisionSignal, type RuntimeState, type WorkflowInput } from './types.js';

export const approvalSignal = defineSignal<[RevisionSignal]>(APPROVAL_SIGNAL);
export const reconciliationSignal = defineSignal<[RevisionSignal]>(RECONCILIATION_SIGNAL);
export const runtimeStateQuery = defineQuery<RuntimeState>(RUNTIME_STATE_QUERY);

const activities = proxyActivities<IntentActivities>({
  startToCloseTimeout: '3 minutes',
  retry: { initialInterval: '1 second', maximumInterval: '1 minute' },
});

/** History contains identifiers and statuses; evidence and proposal bodies stay in Activities/SQL. */
export async function intentWorkflow(input: WorkflowInput): Promise<{ actionId: string; status: 'completed' }> {
  let state: RuntimeState = 'planning';
  const approvals: number[] = [];
  const seenApprovals = new Set<number>();
  let reconciliationPending = false;
  const validRevision = (revision: number) => Number.isSafeInteger(revision) && revision > 0;

  setHandler(runtimeStateQuery, () => state);
  setHandler(approvalSignal, ({ revision }) => {
    if (validRevision(revision) && !seenApprovals.has(revision)) {
      seenApprovals.add(revision);
      approvals.push(revision);
    }
  });
  setHandler(reconciliationSignal, ({ revision }) => {
    // A not-delivered reconciliation and a later delivered reconciliation can share a revision.
    // Coalesce wakeups; re-reading SQL is safe and never dispatches an effect.
    if (validRevision(revision)) reconciliationPending = true;
  });

  let action = await activities.plan(input);
  for (;;) {
    if ((action.status === 'succeeded' || action.status === 'cancelled')) {
      state = 'completed';
      return { actionId: action.actionId, status: 'completed' };
    }
    if (action.status === 'unknown') {
      state = 'waiting_reconciliation';
      await condition(() => reconciliationPending);
      reconciliationPending = false;
      action = await activities.readAction(input);
      continue;
    }
    state = 'waiting_approval';
    await condition(() => approvals.length > 0 || reconciliationPending);
    if (reconciliationPending) {
      reconciliationPending = false;
      action = await activities.readAction(input);
      continue;
    }
    // Consuming the wakeup before the Activity prevents a stale approval from spinning.
    const expectedRevision = approvals.shift()!;
    state = 'executing';
    await activities.execute({ ...input, expectedRevision });
    action = await activities.readAction(input);
  }
}
