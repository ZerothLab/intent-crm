import type { ActionStatus } from '@intent/contracts';

export type WorkflowInput = { tenantId: string; runId: string };
export type ActionSnapshot = { actionId: string; revision: number; approvedRevision: number | null; status: ActionStatus };
export type RevisionSignal = { revision: number };
export type RuntimeState = 'planning' | 'waiting_approval' | 'executing' | 'waiting_reconciliation' | 'completed';
export interface IntentActivities {
  plan(input: WorkflowInput): Promise<ActionSnapshot>;
  readAction(input: WorkflowInput): Promise<ActionSnapshot>;
  execute(input: WorkflowInput & { expectedRevision: number }): Promise<'succeeded' | 'unknown' | 'waiting_approval'>;
}

export const APPROVAL_SIGNAL = 'approval';
export const RECONCILIATION_SIGNAL = 'reconciliation';
export const RUNTIME_STATE_QUERY = 'runtimeState';
