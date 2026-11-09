import { createHash, randomUUID } from 'node:crypto';
import type { Actor } from '@intent/contracts';
import type { Database } from '@intent/database';
import { currentActor } from './authorization.js';
import { DomainError } from './index.js';

/** Shared admission limits apply across API replicas without holding a connection during inference. */
export class AiRequestService {
    constructor(private readonly db: Database) {}

    async run<T>(actor: Actor, key: string, work: () => Promise<T>): Promise<T> {
        const id = randomUUID();
        const digest = createHash('sha256').update(key).digest('hex');
        await this.db.transaction(async tx => {
            await currentActor(tx, actor);
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ai-requests:${actor.tenantId}`]);
            await tx.query("DELETE FROM ai_requests WHERE tenant_id=$1 AND started_at<now()-interval '1 hour'", [actor.tenantId]);
            await tx.query('UPDATE ai_requests SET finished_at=now() WHERE tenant_id=$1 AND finished_at IS NULL AND expires_at<=now()', [actor.tenantId]);
            const duplicate = await tx.query('SELECT 1 FROM ai_requests WHERE tenant_id=$1 AND member_id=$2 AND request_key=$3 AND finished_at IS NULL', [actor.tenantId, actor.memberId, digest]);
            if (duplicate.rowCount)
                throw new DomainError('AI_REQUEST_IN_PROGRESS', 409, 'AI work for this record is already running. Wait for it to finish, then reload before retrying.');
            const counts = (await tx.query(`SELECT
                count(*) FILTER (WHERE finished_at IS NULL)::int AS active,
                count(*) FILTER (WHERE finished_at IS NULL AND member_id=$2)::int AS member_active,
                count(*) FILTER (WHERE started_at>now()-interval '1 minute')::int AS recent,
                count(*) FILTER (WHERE started_at>now()-interval '1 minute' AND member_id=$2)::int AS member_recent
                FROM ai_requests WHERE tenant_id=$1`, [actor.tenantId, actor.memberId])).rows[0]!;
            if (counts.active >= 8 || counts.member_active >= 2 || counts.recent >= 120 || counts.member_recent >= 20)
                throw new DomainError('AI_CAPACITY_REACHED', 429, 'AI request capacity has been reached. Wait a minute and try again.');
            await tx.query('INSERT INTO ai_requests(tenant_id,id,member_id,request_key) VALUES($1,$2,$3,$4)', [actor.tenantId, id, actor.memberId, digest]);
        });
        try {
            return await work();
        } finally {
            // A lost connection must not turn a committed business result into an apparent failure.
            // The short lease also releases capacity after a process interruption.
            await this.db.query('UPDATE ai_requests SET finished_at=now() WHERE tenant_id=$1 AND id=$2', [actor.tenantId, id]).catch(() => undefined);
        }
    }
}
