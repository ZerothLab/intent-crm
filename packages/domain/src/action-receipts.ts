import type { IntentAction } from '@intent/contracts';
import type { Connection } from '@intent/database';

export async function withActionReceipts(tx: Connection, tenantId: string, actions: Omit<IntentAction, 'receipt'>[]): Promise<IntentAction[]> {
    if (!actions.length) return [];
    const rows = (await tx.query('SELECT id,action_id,operation_id,reference,recorded_at,simulated FROM receipts WHERE tenant_id=$1 AND action_id=ANY($2::text[])', [tenantId, actions.map(action => action.id)])).rows;
    const receipts = new Map(rows.map(row => [row.action_id, {
        id: row.id, operationId: row.operation_id, reference: row.reference,
        recordedAt: row.recorded_at.toISOString(), simulated: row.simulated,
    }]));
    return actions.map(action => ({ ...action, receipt: receipts.get(action.id) ?? null }));
}
