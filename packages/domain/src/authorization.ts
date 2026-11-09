import type { Actor } from '@intent/contracts';
import type { Connection } from '@intent/database';
import { DomainError } from './index.js';

export async function currentActor(tx: Connection, ctx: Actor, lock: 'SHARE' | 'UPDATE' = 'SHARE'): Promise<Actor> {
    const row = (await tx.query(`SELECT role,authorization_version FROM members WHERE tenant_id=$1 AND id=$2 AND active=true FOR ${lock}`, [ctx.tenantId, ctx.memberId])).rows[0];
    if (!row || ctx.authorizationVersion !== undefined && ctx.authorizationVersion !== row.authorization_version)
        throw new DomainError('UNAUTHENTICATED', 401, 'Your access changed. Sign in again to continue.');
    return { tenantId: ctx.tenantId, memberId: ctx.memberId, role: row.role, authorizationVersion: row.authorization_version };
}
