import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { evidenceInput, actionEditInput, approvalInput, reconcileInput, memberInput, memberUpdateInput, modelInput, fieldInput, fieldValuesInput, planSchema, workspaceUpdateInput, actionResolutionInput, inboundEventInput, runtimeRecoveryInput, type RuntimeDiagnostics, type Actor, type Member, type Customer, type CustomerDetail, type Evidence, type IntentAction, type Fact, type Commitment, type FieldDefinition, type ModelConnection, type PlanningRun, type PlanningContext, type Plan, type OutboxEvent, type Bootstrap, type FieldValue, type WorkspaceSettings } from '@intent/contracts';
import type { DeliveryEnvelope, DeliveryResult } from './delivery.js';
import type { Database, Connection } from '@intent/database';
import { selectedModel, publicModel, decryptSecret, validateEndpoint } from './model-settings.js';
import { currentActor } from './authorization.js';
import { withActionReceipts } from './action-receipts.js';
import { auditQuery, type AuditEntry, type AuditPage } from '@intent/contracts';
export class DomainError extends Error {
    constructor(public readonly code: string, public readonly status: number, message: string, public readonly retryAfter?: number) { super(message); this.name = 'DomainError'; }
}
const fail = (code: string, status: number, message: string): never => { throw new DomainError(code, status, message); };
const uid = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const cast = <T>(row: Record<string, unknown>): T => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'tenant_id' && k !== 'source_digest').map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v instanceof Date ? v.toISOString() : v])) as T;
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (result.success)
    return result.data; return fail('VALIDATION', 400, "Invalid input. Check required fields and data types."); };
const elevated = (actor: Actor) => actor.role === 'admin' || actor.role === 'manager';
export class IntentService {
    constructor(readonly db: Database) { }
    private actor(tx: Connection, memberId: string, tenantId: string): Promise<Actor> { return currentActor(tx, { memberId, tenantId, role: 'sales' }); }
    async getActor(memberId: string, tenantId: string): Promise<Actor> { return this.db.transaction(tx => this.actor(tx, memberId, tenantId)); }
    private async scoped<T>(ctx: Actor, work: (tx: Connection, actor: Actor) => Promise<T>): Promise<T> { return this.db.transaction(async tx => work(tx, await currentActor(tx, ctx))); }
    private admin(actor: Actor) { if (actor.role !== 'admin')
        fail('FORBIDDEN', 403, "Workspace administrator permission is required."); }
    private seller(actor: Actor) { if (actor.role === 'engineer')
        fail('FORBIDDEN', 403, "Engineers cannot approve or edit outbound messages."); }
    private async customer(tx: Connection, actor: Actor, id: string, lock = false): Promise<Customer> {
        const row = (await tx.query(`SELECT * FROM customers WHERE tenant_id=$1 AND id=$2 AND ($3 OR owner_id=$4)${lock ? ' FOR UPDATE' : ' FOR SHARE'}`, [actor.tenantId, id, elevated(actor), actor.memberId])).rows[0];
        if (!row)
            return fail('NOT_FOUND', 404, "The customer does not exist or is outside your access scope.");
        return cast<Customer>(row);
    }
    private async audit(tx: Connection, tenantId: string, actorId: string | null, event: string, entityId: string, details: Record<string, unknown> = {}) { await tx.query('INSERT INTO audit_events(tenant_id,id,actor_id,event,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)', [tenantId, uid('aud'), actorId, event, entityId, JSON.stringify(details)]); }
    private async outbox(tx: Connection, tenantId: string, type: OutboxEvent['type'], runId: string, revision?: number) { await tx.query('INSERT INTO outbox(tenant_id,id,type,aggregate_id,payload) VALUES($1,$2,$3,$4,$5)', [tenantId, uid('evt'), type, runId, JSON.stringify({ runId, ...(revision === undefined ? {} : { revision }) })]); }
    private async action(tx: Connection, tenantId: string, id: string, lock = false): Promise<IntentAction> {
        const row = (await tx.query(`SELECT * FROM actions WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [tenantId, id])).rows[0];
        if (!row)
            return fail('NOT_FOUND', 404, "Action not found.");
        const receipt = (await tx.query('SELECT id,operation_id,reference,recorded_at,simulated FROM receipts WHERE tenant_id=$1 AND action_id=$2', [tenantId, id])).rows[0];
        return { ...cast<IntentAction>(row), receipt: receipt ? cast(receipt) : null };
    }
    private async authorizedAction(tx: Connection, actor: Actor, id: string): Promise<IntentAction> {
        const link = (await tx.query('SELECT customer_id FROM actions WHERE tenant_id=$1 AND id=$2', [actor.tenantId, id])).rows[0];
        if (!link) return fail('NOT_FOUND', 404, 'Action not found.');
        await this.customer(tx, actor, link.customer_id, true);
        return this.action(tx, actor.tenantId, id, true);
    }
    private revision(actual: number, expected: number) { if (actual !== expected)
        fail('CONFLICT', 409, "The content revision changed. Reload and review again."); }
    private async fields(tx: Connection, tenantId: string): Promise<FieldDefinition[]> { return (await tx.query('SELECT * FROM field_definitions WHERE tenant_id=$1 ORDER BY key', [tenantId])).rows.map(r => cast<FieldDefinition>(r)); }
    private async values(tx: Connection, tenantId: string, customerId: string): Promise<Record<string, FieldValue>> { return Object.fromEntries((await tx.query('SELECT f.key,v.value FROM customer_field_values v JOIN field_definitions f ON f.tenant_id=v.tenant_id AND f.id=v.field_id WHERE v.tenant_id=$1 AND v.customer_id=$2', [tenantId, customerId])).rows.map(r => [r.key, r.value])); }
    private async detail(tx: Connection, actor: Actor, id: string): Promise<CustomerDetail> {
        const customer = await this.customer(tx, actor, id);
        const evidence = (await tx.query('SELECT * FROM evidence WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC,id', [actor.tenantId, id])).rows.map(r => cast<Evidence>(r));
        const facts = (await tx.query('SELECT * FROM facts WHERE tenant_id=$1 AND customer_id=$2 ORDER BY id', [actor.tenantId, id])).rows.map(r => cast<Fact>(r));
        const rows = (await tx.query('SELECT * FROM actions WHERE tenant_id=$1 AND customer_id=$2 ORDER BY updated_at DESC,id', [actor.tenantId, id])).rows;
        const actions = await withActionReceipts(tx, actor.tenantId, rows.map(row => cast<IntentAction>(row)));
        const commitments = (await tx.query('SELECT * FROM commitments WHERE tenant_id=$1 AND customer_id=$2 ORDER BY id', [actor.tenantId, id])).rows.map(r => cast<Commitment>(r));
        return { customer, evidence, facts, actions, commitments, fields: await this.fields(tx, actor.tenantId), fieldValues: await this.values(tx, actor.tenantId, id) };
    }
    async bootstrap(ctx: Actor): Promise<Bootstrap> {
        return this.scoped(ctx, async (tx, a) => {
            const user = cast<Member>((await tx.query('SELECT id,name,email,role,active,revision FROM members WHERE tenant_id=$1 AND id=$2', [a.tenantId, a.memberId])).rows[0]);
            const rows = (await tx.query('SELECT a.status,count(*)::int AS count FROM actions a JOIN customers c ON c.tenant_id=a.tenant_id AND c.id=a.customer_id WHERE a.tenant_id=$1 AND ($2 OR c.owner_id=$3) GROUP BY a.status', [a.tenantId, elevated(a), a.memberId])).rows;
            const counts = Object.fromEntries(rows.map(r => [r.status, r.count]));
            const workspace = (await tx.query('SELECT name FROM tenants WHERE id=$1', [a.tenantId])).rows[0]!;
            return { workspace: { name: workspace.name, tagline: "The AI-native CRM. Understand intent. Move business forward.", assistantName: "Intent" }, user, execution: { workflow: 'temporal', model: (await tx.query("SELECT 1 FROM model_connections WHERE tenant_id=$1 AND enabled AND provider<>'fixture'", [a.tenantId])).rowCount ? 'configured' : 'fixture', transport: (await tx.query('SELECT mode FROM delivery_settings WHERE tenant_id=$1', [a.tenantId])).rows[0]?.mode ?? 'simulated' }, stats: { decisions: (counts.draft ?? 0) + (counts.approved ?? 0), active: (counts.executing ?? 0) + (counts.unknown ?? 0) + (counts.approved ?? 0), completed: counts.succeeded ?? 0 } };
        });
    }
    private async workspace(tx: Connection, tenantId: string, lock = false): Promise<WorkspaceSettings> {
        const row = (await tx.query(`SELECT id,name,revision FROM tenants WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [tenantId])).rows[0];
        if (!row)
            return fail('NOT_FOUND', 404, "Workspace not found.");
        const counts = (await tx.query('SELECT count(*)::int AS member_count,count(*) FILTER (WHERE active)::int AS active_member_count FROM members WHERE tenant_id=$1', [tenantId])).rows[0]!;
        return cast<WorkspaceSettings>({ ...row, ...counts });
    }
    async getWorkspace(ctx: Actor): Promise<WorkspaceSettings> { return this.scoped(ctx, (tx, a) => this.workspace(tx, a.tenantId)); }
    async updateWorkspace(ctx: Actor, input: z.input<typeof workspaceUpdateInput>): Promise<WorkspaceSettings> {
        const data = parse(workspaceUpdateInput, input);
        return this.adminScoped(ctx, async (tx, a) => {
            const before = await this.workspace(tx, a.tenantId, true);
            if (before.revision !== data.expectedRevision)
                fail('CONFLICT', 409, "Another administrator changed the workspace. Reload before saving.");
            if (before.name === data.name)
                return before;
            await tx.query('UPDATE tenants SET name=$2,revision=revision+1 WHERE id=$1', [a.tenantId, data.name]);
            const after = { ...before, name: data.name, revision: before.revision + 1 };
            await this.audit(tx, a.tenantId, a.memberId, 'workspace.updated', a.tenantId, { before: { name: before.name, revision: before.revision }, after: { name: after.name, revision: after.revision } });
            return after;
        });
    }
    async listCustomers(ctx: Actor): Promise<Customer[]> { return this.scoped(ctx, async (tx, a) => (await tx.query('SELECT * FROM customers WHERE tenant_id=$1 AND ($2 OR owner_id=$3) ORDER BY id', [a.tenantId, elevated(a), a.memberId])).rows.map(r => cast<Customer>(r))); }
    async getCustomer(ctx: Actor, id: string): Promise<CustomerDetail> { return this.scoped(ctx, (tx, a) => this.detail(tx, a, id)); }
    async addEvidence(ctx: Actor, id: string, input: z.input<typeof evidenceInput>): Promise<{
        evidence: Evidence;
        runId: string;
    }> {
        const data = parse(evidenceInput, input);
        return this.scoped(ctx, async (tx, a) => {
            await this.customer(tx, a, id, true);
            const digest = createHash('sha256').update([data.kind, data.title, data.body].map(value => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('')).digest('hex');
            const existing = (await tx.query('SELECT * FROM evidence WHERE tenant_id=$1 AND customer_id=$2 AND source_digest=$3', [a.tenantId, id, digest])).rows[0];
            if (existing) {
                const run = (await tx.query('SELECT id FROM planning_runs WHERE tenant_id=$1 AND customer_id=$2 AND evidence_id=$3 ORDER BY attempt DESC,created_at DESC,id DESC LIMIT 1', [a.tenantId, id, existing.id])).rows[0];
                if (!run)
                    fail('CONFLICT', 409, "This evidence has no related planning run. Contact your administrator.");
                return { evidence: cast<Evidence>(existing), runId: run.id };
            }
            const evidenceId = uid('ev'), runId = uid('run');
            const row = (await tx.query('INSERT INTO evidence(tenant_id,id,customer_id,kind,title,body,source_digest) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [a.tenantId, evidenceId, id, data.kind, data.title, data.body, digest])).rows[0];
            await tx.query('INSERT INTO planning_runs(tenant_id,id,customer_id,evidence_id,actor_id,locale) VALUES($1,$2,$3,$4,$5,$6)', [a.tenantId, runId, id, evidenceId, a.memberId, data.locale]);
            await this.outbox(tx, a.tenantId, 'plan.requested', runId);
            await this.audit(tx, a.tenantId, a.memberId, 'evidence.added', evidenceId, { customerId: id, runId });
            return { evidence: cast<Evidence>(row), runId };
        });
    }
    async getRun(ctx: Actor, id: string): Promise<PlanningRun> { return this.scoped(ctx, async (tx, a) => { const row = (await tx.query('SELECT * FROM planning_runs WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0]; if (!row)
        return fail('NOT_FOUND', 404, "Planning run not found."); await this.customer(tx, a, row.customer_id); return cast<PlanningRun>(row); }); }
    async listActions(ctx: Actor): Promise<IntentAction[]> {
        return this.scoped(ctx, async (tx, actor) => {
            const rows = (await tx.query('SELECT a.* FROM actions a JOIN customers c ON c.tenant_id=a.tenant_id AND c.id=a.customer_id WHERE a.tenant_id=$1 AND ($2 OR c.owner_id=$3) ORDER BY a.updated_at DESC,a.id FOR SHARE OF c', [actor.tenantId, elevated(actor), actor.memberId])).rows;
            return withActionReceipts(tx, actor.tenantId, rows.map(row => cast<IntentAction>(row)));
        });
    }
    async updateAction(ctx: Actor, id: string, input: z.input<typeof actionEditInput>): Promise<IntentAction> {
        const data = parse(actionEditInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.seller(a);
            const action = await this.authorizedAction(tx, a, id);
            this.revision(action.revision, data.expectedRevision);
            if (!['draft', 'approved'].includes(action.status))
                fail('CONFLICT', 409, "Only drafts and approved actions that have not executed can be edited.");
            const customer = await this.customer(tx, a, action.customerId);
            if (data.recipient !== customer.email)
                fail('VALIDATION', 400, "The recipient must match the current customer contact email.");
            await tx.query("UPDATE actions SET recipient=$3,subject=$4,body=$5,revision=revision+1,status='draft',approved_revision=NULL,approved_by=NULL,last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2", [a.tenantId, id, data.recipient, data.subject, data.body]);
            await this.audit(tx, a.tenantId, a.memberId, 'action.edited', id, { revision: action.revision + 1 });
            return this.action(tx, a.tenantId, id);
        });
    }
    async approveAction(ctx: Actor, id: string, input: z.input<typeof approvalInput>): Promise<IntentAction> {
        const data = parse(approvalInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.seller(a);
            const action = await this.authorizedAction(tx, a, id);
            this.revision(action.revision, data.expectedRevision);
            if (action.status === 'approved' && action.approvedRevision === action.revision)
                return action;
            if (action.status !== 'draft')
                fail('CONFLICT', 409, "This action cannot be approved in its current state.");
            await this.model(tx, a.tenantId);
            const delivery = (await tx.query('SELECT revision,mode FROM delivery_settings WHERE tenant_id=$1 FOR SHARE', [a.tenantId])).rows[0];
            const responsible = (await tx.query('SELECT m.authorization_version FROM planning_runs r JOIN members m ON m.tenant_id=r.tenant_id AND m.id=COALESCE($3,r.actor_id) WHERE r.tenant_id=$1 AND r.id=$2 FOR SHARE OF m', [a.tenantId, action.runId, action.executionActorId ?? null])).rows[0]!;
            await tx.query("UPDATE actions SET status='approved',approved_revision=revision,approved_by=$3,transport=$4,delivery_revision=$5,approved_actor_version=$6,approved_execution_version=$7,updated_at=now() WHERE tenant_id=$1 AND id=$2", [a.tenantId, id, a.memberId, delivery?.mode ?? 'simulated', delivery?.revision ?? 0, a.authorizationVersion, responsible.authorization_version]);
            await this.outbox(tx, a.tenantId, 'action.approved', action.runId, action.revision);
            await this.audit(tx, a.tenantId, a.memberId, 'action.approved', id, { revision: action.revision });
            return this.action(tx, a.tenantId, id);
        });
    }
    async cancelAction(ctx: Actor, id: string, input: z.input<typeof actionResolutionInput>): Promise<IntentAction> {
        const data = parse(actionResolutionInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.seller(a);
            const action = await this.authorizedAction(tx, a, id);
            if (action.status === 'cancelled' && action.revision === data.expectedRevision + 1 && action.resolutionNote === data.note)
                return action;
            this.revision(action.revision, data.expectedRevision);
            if (!['draft', 'approved', 'failed'].includes(action.status))
                fail('CONFLICT', 409, 'Only an action that has not been dispatched can be cancelled. Reconcile uncertain outcomes first.');
            await tx.query("UPDATE actions SET status='cancelled',revision=revision+1,approved_revision=NULL,approved_by=NULL,resolution_note=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [a.tenantId, id, data.note]);
            await tx.query("UPDATE commitments SET status='cancelled' WHERE tenant_id=$1 AND action_id=$2 AND status='open'", [a.tenantId, id]);
            await tx.query("UPDATE planning_runs SET status='completed',error=NULL WHERE tenant_id=$1 AND id=$2", [a.tenantId, action.runId]);
            await this.outbox(tx, a.tenantId, 'action.reconciled', action.runId, action.revision + 1);
            await this.audit(tx, a.tenantId, a.memberId, 'action.cancelled', id, { revision: action.revision, note: data.note });
            return this.action(tx, a.tenantId, id);
        });
    }
    async takeOverAction(ctx: Actor, id: string, input: z.input<typeof actionResolutionInput>): Promise<IntentAction> {
        const data = parse(actionResolutionInput, input);
        return this.scoped(ctx, async (tx, a) => {
            if (!elevated(a))
                fail('FORBIDDEN', 403, 'A manager or administrator must accept responsibility for this action.');
            const action = await this.authorizedAction(tx, a, id);
            this.revision(action.revision, data.expectedRevision);
            if (!['draft', 'approved', 'failed'].includes(action.status))
                fail('CONFLICT', 409, 'Dispatched or closed actions cannot be taken over.');
            await tx.query("UPDATE actions SET execution_actor_id=$3,status='draft',revision=revision+1,approved_revision=NULL,approved_by=NULL,last_error=NULL,resolution_note=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2", [a.tenantId, id, a.memberId, data.note]);
            await this.audit(tx, a.tenantId, a.memberId, 'action.taken_over', id, { previousActor: action.executionActorId, note: data.note, revision: action.revision + 1 });
            await this.outbox(tx, a.tenantId, 'action.reconciled', action.runId, action.revision + 1);
            return this.action(tx, a.tenantId, id);
        });
    }
    private async delivered(tx: Connection, tenantId: string, action: IntentAction, reference: string, actorId: string | null) {
        const receiptId = uid('rcpt');
        await tx.query('INSERT INTO receipts(tenant_id,id,action_id,operation_id,reference,simulated) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(operation_id) DO NOTHING', [tenantId, receiptId, action.id, action.operationId, reference, action.transport !== 'webhook']);
        const receipt = (await tx.query('SELECT id FROM receipts WHERE tenant_id=$1 AND operation_id=$2', [tenantId, action.operationId])).rows[0];
        await tx.query("UPDATE actions SET status='succeeded',last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, action.id]);
        await tx.query("UPDATE commitments SET status='fulfilled',completion_receipt_id=$3 WHERE tenant_id=$1 AND action_id=$2", [tenantId, action.id, receipt.id]);
        await tx.query("UPDATE customers SET stage='awaiting_review',revision=revision+1 WHERE tenant_id=$1 AND id=$2", [tenantId, action.customerId]);
        await tx.query("UPDATE planning_runs SET status='completed',error=NULL WHERE tenant_id=$1 AND id=$2", [tenantId, action.runId]);
        await tx.query("UPDATE dispatch_attempts SET status='delivered',reference=$3,updated_at=now() WHERE tenant_id=$1 AND operation_id=$2", [tenantId, action.operationId, reference]);
        await this.audit(tx, tenantId, actorId, action.transport === 'webhook' ? 'dispatch.receipted' : 'dispatch.simulated.receipted', action.id, { operationId: action.operationId, receiptId: receipt.id });
    }
    async reconcileAction(ctx: Actor, id: string, input: z.input<typeof reconcileInput>): Promise<IntentAction> {
        const data = parse(reconcileInput, input);
        return this.scoped(ctx, async (tx, a) => {
            if (!elevated(a))
                fail('FORBIDDEN', 403, "Reconciliation requires an administrator or manager.");
            const action = await this.authorizedAction(tx, a, id);
            await this.customer(tx, a, action.customerId, true);
            this.revision(action.revision, data.expectedRevision);
            if (action.status !== 'unknown')
                fail('CONFLICT', 409, "Only actions with uncertain outcomes can be reconciled.");
            if (data.outcome === 'delivered')
                await this.delivered(tx, a.tenantId, action, `reconciled:${data.reference}`, a.memberId);
            else {
                await tx.query("UPDATE dispatch_attempts SET status='not_delivered',reference=$3,updated_at=now() WHERE tenant_id=$1 AND operation_id=$2", [a.tenantId, action.operationId, data.reference]);
                await tx.query("UPDATE actions SET status='draft',revision=revision+1,operation_id=$3,approved_revision=NULL,approved_by=NULL,last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2", [a.tenantId, id, uid('op')]);
                await tx.query("UPDATE planning_runs SET status='waiting_approval',error=NULL WHERE tenant_id=$1 AND id=$2", [a.tenantId, action.runId]);
            }
            await this.audit(tx, a.tenantId, a.memberId, 'action.reconciled', id, { outcome: data.outcome, reference: data.reference });
            const updated = await this.action(tx, a.tenantId, id);
            await this.outbox(tx, a.tenantId, 'action.reconciled', action.runId, updated.revision);
            return updated;
        });
    }
    private async adminScoped<T>(ctx: Actor, work: (tx: Connection, actor: Actor) => Promise<T>): Promise<T> { return this.db.transaction(async (tx) => { await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`members:${ctx.tenantId}`]); const a = await currentActor(tx, ctx); this.admin(a); return work(tx, a); }); }
    async listMembers(ctx: Actor): Promise<Member[]> { return this.scoped(ctx, async (tx, a) => (await tx.query('SELECT id,name,email,role,active,revision FROM members WHERE tenant_id=$1 ORDER BY id', [a.tenantId])).rows.map(r => cast<Member>(r))); }
    async listAudit(ctx: Actor, input: z.input<typeof auditQuery>): Promise<AuditPage> {
        const data = parse(auditQuery, input);
        return this.scoped(ctx, async (tx, actor) => {
            this.admin(actor);
            if (data.cursor && !(await tx.query('SELECT 1 FROM audit_events WHERE tenant_id=$1 AND id=$2', [actor.tenantId, data.cursor])).rowCount)
                fail('NOT_FOUND', 404, 'Audit page cursor not found.');
            const patterns = { all: ['%'], access: ['identity.%', 'member.%', 'customer.handed_over', 'approval.invalidated'], models: ['model.%'], delivery: ['delivery.%', 'dispatch.%', 'action.reconciled'], workspace: ['workspace.%', 'field.%'] }[data.category];
            const rows = (await tx.query(`SELECT e.id,e.actor_id,m.name AS actor_name,e.event,e.entity_id,e.created_at,e.details FROM audit_events e
                LEFT JOIN members m ON m.tenant_id=e.tenant_id AND m.id=e.actor_id
                WHERE e.tenant_id=$1 AND e.event LIKE ANY($2::text[]) AND ($3::text IS NULL OR e.actor_id=$3)
                AND ($4::text IS NULL OR (e.created_at,e.id)<(SELECT p.created_at,p.id FROM audit_events p WHERE p.tenant_id=$1 AND p.id=$4))
                ORDER BY e.created_at DESC,e.id DESC LIMIT 51`, [actor.tenantId, patterns, data.actorId ?? null, data.cursor ?? null])).rows;
            const items = rows.slice(0, 50).map(row => {
                const { details, ...metadata } = row;
                // Project only access changes; business prose and credentials never enter this view.
                const change = row.event === 'member.updated' && details.before && details.after ? {
                    before: { role: details.before.role, active: details.before.active },
                    after: { role: details.after.role, active: details.after.active }, sessionsRevoked: details.sessionsRevoked === true,
                } : null;
                return { ...cast<Omit<AuditEntry, 'accessChange'>>(metadata), accessChange: change };
            });
            return { items, nextCursor: rows.length > 50 ? items.at(-1)!.id : null };
        });
    }
    async createMember(ctx: Actor, input: z.input<typeof memberInput>): Promise<Member> {
        const data = parse(memberInput, input);
        return this.adminScoped(ctx, async (tx, a) => {
            const id = uid('usr');
            const row = (await tx.query('INSERT INTO members(tenant_id,id,name,email,role,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,active,revision', [a.tenantId, id, data.name, data.email.toLowerCase(), data.role, data.active])).rows[0];
            await this.audit(tx, a.tenantId, a.memberId, 'member.created', id, { role: data.role, active: data.active });
            return cast<Member>(row);
        });
    }
    async updateMember(ctx: Actor, id: string, input: z.input<typeof memberUpdateInput>): Promise<Member> {
        const data = parse(memberUpdateInput, input);
        return this.adminScoped(ctx, async (tx, a) => {
            const member = (await tx.query('SELECT * FROM members WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
            if (!member)
                return fail('NOT_FOUND', 404, "Member not found.");
            this.revision(member.revision, data.expectedRevision);
            if (member.active && member.role === 'admin' && (!data.active || data.role !== 'admin')) {
                const { rows } = await tx.query("SELECT count(*)::int AS count FROM members WHERE tenant_id=$1 AND role='admin' AND active=true", [a.tenantId]);
                if (rows[0].count <= 1)
                    fail('CONFLICT', 409, "The workspace must retain at least one active administrator.");
            }
            const accessChanged = member.role !== data.role || member.active !== data.active || member.email.toLowerCase() !== data.email.toLowerCase();
            const row = (await tx.query('UPDATE members SET name=$3,email=$4,role=$5,active=$6,revision=revision+1,authorization_version=authorization_version+$7 WHERE tenant_id=$1 AND id=$2 RETURNING id,name,email,role,active,revision', [a.tenantId, id, data.name, data.email.toLowerCase(), data.role, data.active, accessChanged ? 1 : 0])).rows[0];
            if (accessChanged)
                await tx.query('UPDATE identity_sessions SET revoked_at=now() WHERE tenant_id=$1 AND member_id=$2 AND revoked_at IS NULL', [a.tenantId, id]);
            await this.audit(tx, a.tenantId, a.memberId, 'member.updated', id, { before: { role: member.role, active: member.active, email: member.email }, after: { role: data.role, active: data.active, email: row.email }, revision: row.revision, sessionsRevoked: accessChanged });
            return cast<Member>(row);
        });
    }
    async listModels(ctx: Actor): Promise<ModelConnection[]> { return this.scoped(ctx, async (tx, a) => (await tx.query('SELECT * FROM model_connections WHERE tenant_id=$1 ORDER BY id', [a.tenantId])).rows.map(publicModel)); }
    async updateModel(ctx: Actor, id: string, input: z.input<typeof modelInput>): Promise<ModelConnection> {
        const data = parse(modelInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.admin(a);
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`models:${a.tenantId}`]);
            const before = (await tx.query('SELECT * FROM model_connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
            if (!before)
                fail('NOT_FOUND', 404, 'Model connection not found.');
            if(before.provider!=='fixture'&&data.expectedRevision===undefined) fail('CONFLICT',409,'Reload the model settings before changing the selection.');
            if (data.expectedRevision !== undefined)
                this.revision(before.revision, data.expectedRevision);
            if (data.enabled && before.provider !== 'fixture' && (before.tested_revision !== before.revision || before.test_error))
                fail('MODEL_UNTESTED', 409, 'Test the current connection settings before enabling this model.');
            if (data.enabled)
                await tx.query('UPDATE model_connections SET enabled=false WHERE tenant_id=$1 AND purpose=$2 AND id<>$3', [a.tenantId, before.purpose, id]);
            const row = (await tx.query('UPDATE model_connections SET enabled=$3 WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, id, data.enabled])).rows[0];
            await this.audit(tx, a.tenantId, a.memberId, 'model.updated', id, { enabled: data.enabled, revision: row.revision });
            return publicModel(row);
        });
    }
    async listFields(ctx: Actor): Promise<FieldDefinition[]> { return this.scoped(ctx, (tx, a) => this.fields(tx, a.tenantId)); }
    async createField(ctx: Actor, input: z.input<typeof fieldInput>): Promise<FieldDefinition> {
        const data = parse(fieldInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.admin(a);
            const id = uid('fld');
            const row = (await tx.query('INSERT INTO field_definitions(tenant_id,id,key,label,type,required,enabled,options) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [a.tenantId, id, data.key, data.label, data.type, data.required, data.enabled, JSON.stringify(data.options)])).rows[0];
            await this.audit(tx, a.tenantId, a.memberId, 'field.created', id, { key: data.key });
            return cast<FieldDefinition>(row);
        });
    }
    async updateField(ctx: Actor, id: string, input: z.input<typeof fieldInput>): Promise<FieldDefinition> {
        const data = parse(fieldInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.admin(a);
            const old = (await tx.query('SELECT * FROM field_definitions WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
            if (!old)
                return fail('NOT_FOUND', 404, "Field not found.");
            if (data.key !== old.key)
                fail('CONFLICT', 409, "Field identifiers cannot change after creation.");
            const used = (await tx.query('SELECT 1 FROM customer_field_values WHERE tenant_id=$1 AND field_id=$2 AND value IS NOT NULL AND value <> \'null\'::jsonb LIMIT 1', [a.tenantId, id])).rows.length > 0;
            if (used && (data.type !== old.type || JSON.stringify(data.options) !== JSON.stringify(old.options)))
                fail('CONFLICT', 409, "A field with existing values cannot change its type or options. Disable it and create another field.");
            const row = (await tx.query('UPDATE field_definitions SET label=$3,type=$4,required=$5,enabled=$6,options=$7 WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, id, data.label, data.type, data.required, data.enabled, JSON.stringify(data.options)])).rows[0];
            await this.audit(tx, a.tenantId, a.memberId, 'field.updated', id, { enabled: data.enabled });
            return cast<FieldDefinition>(row);
        });
    }
    async updateFieldValues(ctx: Actor, id: string, input: z.input<typeof fieldValuesInput>): Promise<CustomerDetail> {
        const data = parse(fieldValuesInput, input);
        return this.scoped(ctx, async (tx, a) => {
            if (a.role === 'engineer')
                fail('FORBIDDEN', 403, "Engineers cannot change customer information.");
            const customer = await this.customer(tx, a, id, true);
            this.revision(customer.revision, data.expectedRevision);
            const fields = (await tx.query('SELECT * FROM field_definitions WHERE tenant_id=$1 ORDER BY id FOR SHARE', [a.tenantId])).rows.map(r => cast<FieldDefinition>(r));
            const updates = Object.fromEntries(Object.entries(data.values).map(([key, value]) => [key, typeof value === 'string' && value.trim() === '' ? null : value]));
            const values = { ...await this.values(tx, a.tenantId, id), ...updates };
            for (const key of Object.keys(data.values)) {
                const field = fields.find(f => f.key === key);
                if (!field || !field.enabled)
                    fail('VALIDATION', 400, "The request contains an unknown or disabled field.");
            }
            for (const f of fields.filter(f => f.enabled)) {
                const value = Object.hasOwn(values, f.key) ? values[f.key] : undefined, empty = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
                if (empty) {
                    if (f.required)
                        fail('VALIDATION', 400, "Required field missing: " + f.label + "");
                    continue;
                }
                if (f.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
                    fail('VALIDATION', 400, "Invalid numeric field: " + f.label + "");
                if (f.type !== 'number' && typeof value !== 'string')
                    fail('VALIDATION', 400, "Invalid text field: " + f.label + "");
                if (f.type === 'select' && !f.options.includes(String(value)))
                    fail('VALIDATION', 400, "Invalid option: " + f.label + "");
                if (f.type === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value))
                    fail('VALIDATION', 400, "Invalid date field: " + f.label + "");
            }
            for (const [key, value] of Object.entries(updates)) {
                const field = fields.find(f => f.key === key)!;
                await tx.query('INSERT INTO customer_field_values(tenant_id,customer_id,field_id,value) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,customer_id,field_id) DO UPDATE SET value=excluded.value', [a.tenantId, id, field.id, JSON.stringify(value)]);
            }
            await tx.query('UPDATE customers SET revision=revision+1 WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]);
            await this.audit(tx, a.tenantId, a.memberId, 'customer.fields.updated', id, { keys: Object.keys(data.values), revision: customer.revision + 1 });
            return this.detail(tx, a, id);
        });
    }
    private model(tx: Connection, tenantId: string, purpose: ModelConnection['purpose'] = 'reasoning'): Promise<ModelConnection> { return selectedModel(tx, tenantId, purpose); }
    async getPlanningContext(tenantId: string, runId: string): Promise<PlanningContext> {
        return this.db.transaction(async (tx) => {
            const row = (await tx.query('SELECT * FROM planning_runs WHERE tenant_id=$1 AND id=$2', [tenantId, runId])).rows[0];
            if (!row)
                return fail('NOT_FOUND', 404, "Planning run not found.");
            const actor = await this.actor(tx, row.execution_actor_id ?? row.actor_id, tenantId);
            const detail = await this.detail(tx, actor, row.customer_id);
            await this.model(tx, tenantId, 'extraction');
            return { run: cast<PlanningRun>(row), customer: detail.customer, evidence: detail.evidence, fields: detail.fields, fieldValues: detail.fieldValues, facts: detail.facts, actions: detail.actions, locale: row.locale, model: await this.model(tx, tenantId), extractionModel: await this.model(tx, tenantId, 'extraction') };
        });
    }
    async acceptPlan(tenantId: string, runId: string, input: Plan, bindings?: ModelConnection[]): Promise<IntentAction> {
        const plan = parse(planSchema, input);
        return this.db.transaction(async (tx) => {
            const link = (await tx.query('SELECT customer_id,COALESCE(execution_actor_id,actor_id) AS execution_actor FROM planning_runs WHERE tenant_id=$1 AND id=$2', [tenantId, runId])).rows[0];
            if (!link) return fail('NOT_FOUND', 404, 'Planning run not found.');
            await tx.query('SELECT id FROM members WHERE tenant_id=$1 AND id=$2 FOR SHARE', [tenantId, link.execution_actor]);
            await tx.query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, link.customer_id]);
            const row = (await tx.query('SELECT * FROM planning_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, runId])).rows[0];
            if (!row)
                return fail('NOT_FOUND', 404, "Planning run not found.");
            const actor = await this.actor(tx, row.execution_actor_id ?? row.actor_id, tenantId);
            const customer = await this.customer(tx, actor, row.customer_id);
            await this.model(tx, tenantId);
            await this.model(tx, tenantId, 'extraction');
            if (bindings)
                for (const binding of bindings) {
                    const current = await this.model(tx, tenantId, binding.purpose);
                    if (current.id !== binding.id || current.revision !== binding.revision)
                        fail('CONFLICT', 409, 'Model configuration changed during planning.');
                }
            if (row.action_id)
                return this.action(tx, tenantId, row.action_id);
            if (row.status === 'failed')
                fail('CONFLICT', 409, "A failed run cannot create an action.");
            const evidence = (await tx.query('SELECT id,body FROM evidence WHERE tenant_id=$1 AND customer_id=$2', [tenantId, customer.id])).rows as {
                id: string;
                body: string;
            }[];
            const sources = new Map(evidence.map(e => [e.id, e.body]));
            if (plan.proposal.recipient !== customer.email || plan.proposal.evidenceIds.some(id => !sources.has(id)) || !plan.proposal.evidenceIds.includes(row.evidence_id))
                fail('VALIDATION', 400, "The proposal recipient or evidence is outside the current customer context.");
            for (const fact of plan.facts) {
                const source = sources.get(fact.evidenceId);
                if (!source || !source.includes(fact.quote) || !fact.quote.includes(fact.value))
                    fail('VALIDATION', 400, "Candidate facts must quote original evidence, and each value must occur in its quote.");
            }
            const actionId = uid('act');
            await tx.query('INSERT INTO actions(tenant_id,id,customer_id,run_id,recipient,subject,body,evidence_ids,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [tenantId, actionId, customer.id, runId, plan.proposal.recipient, plan.proposal.subject, plan.proposal.body, JSON.stringify([...new Set(plan.proposal.evidenceIds)]), uid('op')]);
            if (row.execution_actor_id)
                await tx.query('UPDATE actions SET execution_actor_id=$3 WHERE tenant_id=$1 AND id=$2', [tenantId, actionId, row.execution_actor_id]);
            let insertedFacts = 0;
            for (const fact of plan.facts) {
                // The customer lock serializes planning so reviewed evidence cannot reappear as a new candidate.
                const inserted = await tx.query(`INSERT INTO facts(tenant_id,id,customer_id,key,value,evidence_id,quote)
                    SELECT $1,$2,$3,$4,$5,$6,$7 WHERE NOT EXISTS (
                        SELECT 1 FROM facts WHERE tenant_id=$1 AND customer_id=$3 AND key=$4 AND value=$5 AND evidence_id=$6 AND quote=$7
                    )`, [tenantId, uid('fact'), customer.id, fact.key, fact.value, fact.evidenceId, fact.quote]);
                insertedFacts += inserted.rowCount ?? 0;
            }
            await tx.query('INSERT INTO commitments(tenant_id,id,customer_id,action_id,title,evidence_id) VALUES($1,$2,$3,$4,$5,$6)', [tenantId, uid('commit'), customer.id, actionId, "Submit the reviewed proposal to the customer", row.evidence_id]);
            await tx.query("UPDATE planning_runs SET status='waiting_approval',action_id=$3,error=NULL,model=$4 WHERE tenant_id=$1 AND id=$2", [tenantId, runId, actionId, bindings?.find(m => m.purpose === 'reasoning')?.model ?? 'fixture-v1']);
            await this.audit(tx, tenantId, actor.memberId, 'plan.accepted', runId, { actionId, factCount: insertedFacts });
            return this.action(tx, tenantId, actionId);
        });
    }
    async failRun(tenantId: string, runId: string, _message: string): Promise<void> { await this.db.transaction(async (tx) => { const updated = await tx.query("UPDATE planning_runs SET status='failed',error='Planning failed. Check permissions, model settings and service health.' WHERE tenant_id=$1 AND id=$2 AND action_id IS NULL AND status NOT IN ('completed','failed') RETURNING id", [tenantId, runId]); if (updated.rowCount)
        await this.audit(tx, tenantId, null, 'run.failed', runId); }); }
    async getActionForRun(tenantId: string, runId: string): Promise<IntentAction | null> { return this.db.transaction(async (tx) => { const row = (await tx.query('SELECT id FROM actions WHERE tenant_id=$1 AND run_id=$2', [tenantId, runId])).rows[0]; return row ? this.action(tx, tenantId, row.id) : null; }); }
    async executeAction(tenantId: string, runId: string, expectedRevision: number, deliver?: (envelope: DeliveryEnvelope) => Promise<DeliveryResult>): Promise<'succeeded' | 'unknown' | 'waiting_approval'> {
        const claim = await this.db.transaction(async (tx): Promise<'succeeded' | 'unknown' | 'waiting_approval' | DeliveryEnvelope> => {
            const link = (await tx.query('SELECT a.customer_id,a.approved_by,COALESCE(a.execution_actor_id,r.actor_id) AS execution_actor FROM actions a JOIN planning_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id WHERE a.tenant_id=$1 AND a.run_id=$2', [tenantId, runId])).rows[0];
            if (!link) return fail('NOT_FOUND', 404, 'Action not found.');
            await tx.query('SELECT id FROM members WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE', [tenantId, [link.execution_actor, link.approved_by].filter(Boolean)]);
            await tx.query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, link.customer_id]);
            const row = (await tx.query('SELECT a.*,r.actor_id FROM actions a JOIN planning_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id WHERE a.tenant_id=$1 AND a.run_id=$2 FOR UPDATE OF a', [tenantId, runId])).rows[0];
            if (!row)
                return fail('NOT_FOUND', 404, "Action not found.");
            const action = cast<IntentAction>(row);
            if (action.status === 'succeeded' || action.status === 'cancelled')
                return 'succeeded';
            if (action.status === 'unknown' || action.status === 'executing') {
                await tx.query("UPDATE actions SET status='unknown',last_error='Delivery outcome requires reconciliation.',updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, action.id]);
                await tx.query("UPDATE planning_runs SET status='waiting_reconciliation' WHERE tenant_id=$1 AND id=$2", [tenantId, runId]);
                return 'unknown';
            }
            if (action.status !== 'approved' || action.revision !== expectedRevision || action.approvedRevision !== action.revision || !action.approvedBy)
                return 'waiting_approval';
            const delivery = (await tx.query('SELECT * FROM delivery_settings WHERE tenant_id=$1 FOR SHARE', [tenantId])).rows[0];
            try {
                if ((delivery?.revision ?? 0) !== row.delivery_revision)
                    fail('CONFLICT', 409, 'Delivery settings changed. Review the action again.');
                if (action.transport === 'webhook') validateEndpoint(delivery?.endpoint ?? '', 'DELIVERY');
                const initiator = await this.actor(tx, row.execution_actor_id ?? row.actor_id, tenantId);
                await this.customer(tx, initiator, action.customerId, true);
                const approver = await this.actor(tx, action.approvedBy, tenantId);
                this.seller(approver);
                if (approver.authorizationVersion !== row.approved_actor_version || initiator.authorizationVersion !== row.approved_execution_version)
                    fail('CONFLICT', 409, 'Member access changed after approval. Review the action again.');
                const customer = await this.customer(tx, approver, action.customerId);
                await this.model(tx, tenantId);
                if (action.recipient !== customer.email)
                    fail('CONFLICT', 409, "The customer contact changed.");
            }
            catch (error) {
                if (!(error instanceof DomainError))
                    throw error;
                await tx.query("UPDATE actions SET status='draft',approved_revision=NULL,approved_by=NULL,revision=revision+1,last_error='Permissions, contact or model settings changed before execution. Review again.',updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, action.id]);
                await tx.query("UPDATE planning_runs SET status='waiting_approval' WHERE tenant_id=$1 AND id=$2", [tenantId, runId]);
                await this.audit(tx, tenantId, null, 'approval.invalidated', action.id, { reason: error.code });
                return 'waiting_approval';
            }
            if (action.transport === 'webhook' && !deliver)
                fail('DELIVERY_UNAVAILABLE', 503, 'The worker has no delivery adapter.');
            await tx.query("UPDATE actions SET status='executing',updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, action.id]);
            await this.audit(tx, tenantId, action.approvedBy, action.transport === 'webhook' ? 'dispatch.claimed' : 'dispatch.simulated.claimed', action.id, { operationId: action.operationId, revision: action.revision });
            if (action.transport === 'webhook') {
                await tx.query("INSERT INTO dispatch_attempts(tenant_id,operation_id,action_id,revision,status) VALUES($1,$2,$3,$4,'claimed')", [tenantId, action.operationId, action.id, action.revision]);
                return { action, endpoint: delivery.endpoint, sender: delivery.sender, apiKey: decryptSecret(delivery.credential, `${tenantId}:delivery`) };
            }
            // The fixture transport has no network side effect; claim and terminal ledger commit atomically.
            if (process.env.INTENT_TRANSPORT_OUTCOME === 'unknown') {
                await tx.query("UPDATE actions SET status='unknown',last_error='Simulated delivery is uncertain. Reconcile the outcome; automatic redispatch is blocked.',updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, action.id]);
                await tx.query("UPDATE planning_runs SET status='waiting_reconciliation' WHERE tenant_id=$1 AND id=$2", [tenantId, runId]);
                await this.audit(tx, tenantId, action.approvedBy, 'dispatch.simulated.unknown', action.id, { operationId: action.operationId });
                return 'unknown';
            }
            await this.delivered(tx, tenantId, action, `simulated:${action.operationId}`, action.approvedBy);
            return 'succeeded';
        });
        if (typeof claim === 'string')
            return claim;
        let outcome: DeliveryResult;
        try {
            outcome = await deliver!(claim);
        }
        catch {
            outcome = { outcome: 'unknown' };
        }
        return this.db.transaction(async (tx) => {
            await tx.query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, claim.action.customerId]);
            const action = await this.action(tx, tenantId, claim.action.id, true);
            if (action.operationId !== claim.action.operationId) {
                await this.audit(tx,tenantId,null,'dispatch.late_response',action.id,{operationId:claim.action.operationId,outcome:outcome.outcome,reference:outcome.reference??null});
                if(outcome.outcome==='delivered') await tx.query("UPDATE actions SET last_error='A previous dispatch reported late delivery. Review the delivery history before taking further action.',updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,action.id]);
                return 'unknown';
            }
            if(action.status==='succeeded') return 'succeeded';
            if (outcome.outcome === 'delivered' && outcome.reference) {
                await this.delivered(tx, tenantId, action, outcome.reference, null);
                return 'succeeded';
            }
            await tx.query("UPDATE actions SET status='unknown',last_error='Delivery outcome requires reconciliation. Automatic redispatch is blocked.',updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, action.id]);
            await tx.query("UPDATE dispatch_attempts SET status='unknown',updated_at=now() WHERE tenant_id=$1 AND operation_id=$2", [tenantId, action.operationId]);
            await tx.query("UPDATE planning_runs SET status='waiting_reconciliation' WHERE tenant_id=$1 AND id=$2", [tenantId, runId]);
            await this.audit(tx, tenantId, null, 'dispatch.unknown', action.id, { operationId: action.operationId });
            return 'unknown';
        });
    }
    async receiveIntegrationEvent(tenantId: string, input: z.input<typeof inboundEventInput>): Promise<{
        ok: true;
        runId?: string;
    }> {
        const data = parse(inboundEventInput, input);
        const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
        return this.db.transaction(async (tx) => {
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`inbound:${tenantId}:${data.eventId}`]);
            const prior = (await tx.query('SELECT digest,result FROM inbound_events WHERE tenant_id=$1 AND event_id=$2', [tenantId, data.eventId])).rows[0];
            if (prior) {
                if (prior.digest !== digest)
                    fail('CONFLICT', 409, 'The event ID belongs to different content.');
                return prior.result;
            }
            const attempt = (await tx.query('SELECT * FROM dispatch_attempts WHERE tenant_id=$1 AND operation_id=$2', [tenantId, data.operationId])).rows[0];
            if (!attempt)
                fail('NOT_FOUND', 404, 'Dispatch attempt not found.');
            await tx.query('SELECT c.id FROM customers c JOIN actions a ON a.tenant_id=c.tenant_id AND a.customer_id=c.id WHERE a.tenant_id=$1 AND a.id=$2 FOR UPDATE OF c', [tenantId, attempt.action_id]);
            const action = await this.action(tx, tenantId, attempt.action_id, true);
            let result: {
                ok: true;
                runId?: string;
            } = { ok: true };
            if (data.type === 'delivery') {
                if (action.operationId !== data.operationId) {
                    await this.audit(tx, tenantId, null, 'dispatch.late_event', action.id, { operationId: data.operationId, outcome: data.outcome, reference: data.reference });
                    await tx.query("UPDATE actions SET last_error='A late delivery event conflicts with a previously reconciled attempt. Review the delivery history.',updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, action.id]);
                }
                else if (data.outcome === 'delivered') {
                    if (action.status !== 'succeeded')
                        await this.delivered(tx, tenantId, action, data.reference, null);
                    await this.outbox(tx, tenantId, 'action.reconciled', action.runId, action.revision);
                }
                else if (action.status === 'succeeded') {
                    await this.audit(tx,tenantId,null,'dispatch.conflicting_event',action.id,{operationId:data.operationId,outcome:data.outcome,reference:data.reference});
                    await tx.query("UPDATE actions SET last_error='A delivery receipt already exists. Review conflicting provider events.',updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,action.id]);
                }
                else {
                    await tx.query("UPDATE dispatch_attempts SET status='not_delivered',reference=$3,updated_at=now() WHERE tenant_id=$1 AND operation_id=$2", [tenantId, data.operationId, data.reference]);
                    await tx.query("UPDATE actions SET status='draft',revision=revision+1,operation_id=$3,approved_revision=NULL,approved_by=NULL,last_error='The gateway confirmed non-delivery. Review and approve before another attempt.',updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, action.id, uid('op')]);
                    await tx.query("UPDATE planning_runs SET status='waiting_approval' WHERE tenant_id=$1 AND id=$2", [tenantId, action.runId]);
                    await this.outbox(tx, tenantId, 'action.reconciled', action.runId, action.revision + 1);
                }
            }
            else {
                const customer = (await tx.query('SELECT * FROM customers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, action.customerId])).rows[0]!;
                if (data.sender.toLowerCase() !== action.recipient.toLowerCase())
                    fail('VALIDATION', 400, 'The reply sender does not match the dispatched recipient.');
                const evidenceId = uid('ev'), runId = uid('run');
                await tx.query("INSERT INTO evidence(tenant_id,id,customer_id,kind,title,body,source_digest) VALUES($1,$2,$3,'reply',$4,$5,$6)", [tenantId, evidenceId, customer.id, data.title, data.body,createHash('sha256').update(`gateway:${data.eventId}`).digest('hex')]);
                await tx.query('INSERT INTO planning_runs(tenant_id,id,customer_id,evidence_id,actor_id) VALUES($1,$2,$3,$4,$5)', [tenantId, runId, customer.id, evidenceId, customer.owner_id]);
                await this.outbox(tx, tenantId, 'plan.requested', runId);
                result = { ok: true, runId };
                await this.audit(tx, tenantId, null, 'customer.reply.received', evidenceId, { operationId: data.operationId, runId });
            }
            await tx.query('INSERT INTO inbound_events(tenant_id,event_id,digest,result) VALUES($1,$2,$3,$4)', [tenantId, data.eventId, digest, JSON.stringify(result)]);
            return result;
        });
    }
    async heartbeat(id: string): Promise<void> { await this.db.query("DELETE FROM runtime_heartbeats WHERE heartbeat_at<now()-interval '1 day'"); await this.db.query('INSERT INTO runtime_heartbeats(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now()', [id]); }
    async runtimeDiagnostics(ctx: Actor): Promise<RuntimeDiagnostics> {
        return this.scoped(ctx, async (tx, a) => {
            this.admin(a);
            const heartbeat = (await tx.query('SELECT max(heartbeat_at) AS at FROM runtime_heartbeats')).rows[0]?.at as Date | null;
            const pending = (await tx.query('SELECT count(*)::int AS count,min(created_at) AS oldest FROM outbox WHERE tenant_id=$1 AND published_at IS NULL', [a.tenantId])).rows[0]!;
            const stalled = (await tx.query("SELECT count(*)::int AS count FROM planning_runs WHERE tenant_id=$1 AND status IN ('queued','planning') AND created_at<now()-interval '5 minutes'", [a.tenantId])).rows[0]!.count;
            const uncertain = (await tx.query("SELECT count(*)::int AS count FROM actions WHERE tenant_id=$1 AND status IN ('unknown','executing')", [a.tenantId])).rows[0]!.count;
            const stalledItems=(await tx.query("SELECT r.id,r.customer_id,c.name AS customer_name,r.created_at FROM planning_runs r JOIN customers c ON c.tenant_id=r.tenant_id AND c.id=r.customer_id WHERE r.tenant_id=$1 AND r.status IN ('queued','planning') AND r.action_id IS NULL AND r.created_at<now()-interval '5 minutes' ORDER BY r.created_at LIMIT 100",[a.tenantId])).rows.map(row=>({id:row.id,customerId:row.customer_id,customerName:row.customer_name,createdAt:row.created_at.toISOString()}));
            return { stalledItems, database: 'ok', worker: heartbeat && Date.now() - heartbeat.getTime() < 30000 ? 'healthy' : 'unavailable', lastHeartbeat: heartbeat?.toISOString() ?? null, pendingEvents: pending.count, oldestPendingAt: pending.oldest?.toISOString() ?? null, stalledRuns: stalled, uncertainActions: uncertain };
        });
    }
    async recoverRun(ctx: Actor, input: z.input<typeof runtimeRecoveryInput>): Promise<void> {
        const data = parse(runtimeRecoveryInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.admin(a);
            const row = (await tx.query('SELECT * FROM planning_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, data.runId])).rows[0];
            if (!row)
                fail('NOT_FOUND', 404, 'Planning run not found.');
            if (row.action_id || !['queued', 'planning', 'failed'].includes(row.status) || Date.now() - new Date(row.created_at).getTime() < 300000)
                fail('CONFLICT', 409, 'Only a planning run stalled for at least five minutes with no action can be recovered.');
            await tx.query("UPDATE planning_runs SET status='failed',error='An administrator recovered this stalled planning run.' WHERE tenant_id=$1 AND id=$2", [a.tenantId, row.id]);
            await this.audit(tx, a.tenantId, a.memberId, 'run.recovered', row.id, { note: data.note });
        });
    }
    async listOutbox(limit = 50, excludedIds: readonly string[] = []): Promise<OutboxEvent[]> { const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50)); const rows = (await this.db.query('SELECT id,tenant_id,type,aggregate_id,payload FROM outbox WHERE published_at IS NULL AND NOT(id=ANY($2::text[])) ORDER BY created_at,id LIMIT $1', [safeLimit, excludedIds])).rows; return rows.map(row => ({ ...cast<OutboxEvent>(row), tenantId: row.tenant_id })); }
    async markOutboxPublished(id: string): Promise<void> { await this.db.transaction(async (tx) => { const row = (await tx.query('UPDATE outbox SET published_at=now() WHERE id=$1 AND published_at IS NULL RETURNING tenant_id,aggregate_id', [id])).rows[0]; if (row)
        await this.audit(tx, row.tenant_id, null, 'outbox.published', id, { runId: row.aggregate_id }); }); }
    async recordWorkflowState(tenantId: string, runId: string, status: PlanningRun['status']): Promise<void> {
        await this.db.transaction(async (tx) => {
            const row = (await tx.query('SELECT * FROM planning_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, runId])).rows[0];
            if (!row || ['completed', 'failed'].includes(row.status))
                return;
            if (row.action_id) {
                const action = (await tx.query('SELECT status FROM actions WHERE tenant_id=$1 AND id=$2', [tenantId, row.action_id])).rows[0];
                status = action?.status === 'succeeded' || action?.status === 'cancelled' ? 'completed' : action?.status === 'unknown' ? 'waiting_reconciliation' : 'waiting_approval';
            }
            else if (!['queued', 'planning', 'failed'].includes(status))
                return;
            if (status !== row.status) {
                await tx.query('UPDATE planning_runs SET status=$3 WHERE tenant_id=$1 AND id=$2', [tenantId, runId, status]);
                await this.audit(tx, tenantId, null, 'run.state_changed', runId, { status });
            }
        });
    }
}
export { CommercialService } from './commercial.js';
export { ProductService } from './product.js';
export { ModelSettingsService } from './model-settings.js';
export { AiRequestService } from './ai-requests.js';
export { DeliveryService, type DeliveryEnvelope, type DeliveryResult } from './delivery.js';
