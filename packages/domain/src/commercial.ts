import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { opportunityInput, opportunityUpdateInput, opportunityQuery, managementQuery, contractInput, paymentInput, targetInput, snapshotInput, opportunityTaskInput, taskCompletionInput, taskUpdateInput, financialCorrectionInput, refundInput, type RefundRecord, type Actor, type Member, type Opportunity, type OpportunityDetail, type OpportunityHistory, type SalesContract, type Receivable, type PaymentRecord, type OpportunityTask, type SalesTarget, type ForecastSnapshot, type ForecastItem, type ManagementData, type ManagementOverview, type Evidence } from '@intent/contracts';
import type { Database, Connection } from '@intent/database';
import { selectedModel } from './model-settings.js';
import type { ModelConnection } from '@intent/contracts';
import { DomainError } from './index.js';
import { currentActor } from './authorization.js';
import { calculateManagementOverview } from './management-metrics.js';
import { advancementInput, advancementPlanSchema, advancementDecisionInput, type AdvancementInput, type AdvancementPlan, type AdvancementContext, type AdvancementProposal, type Fact } from '@intent/contracts';
const uid = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const fail = (code: string, status: number, message: string): never => { throw new DomainError(code, status, message); };
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => { const result = schema.safeParse(input); if (result.success)
    return result.data; return fail('VALIDATION', 400, "Invalid input. Check dates, amounts and required fields."); };
const manager = (a: Actor) => a.role === 'admin' || a.role === 'manager';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format();
const integer = (value: unknown) => { const n = Number(value); if (!Number.isSafeInteger(n))
    return fail('AMOUNT_OVERFLOW', 409, "The aggregate amount exceeds the safe integer range."); return n; };
const mapped = <T>(row: Record<string, unknown>): T => Object.fromEntries(Object.entries(row).filter(([k]) => !['tenant_id', 'source_digest'].includes(k)).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), key.endsWith('_cents') ? integer(value) : value instanceof Date ? value.toISOString() : value])) as T;
const opportunitySelect = 'SELECT o.*,c.name AS customer_name,m.name AS owner_name FROM opportunities o JOIN customers c ON c.tenant_id=o.tenant_id AND c.id=o.customer_id JOIN members m ON m.tenant_id=o.tenant_id AND m.id=o.owner_id';
export class CommercialService {
    constructor(readonly db: Database) { }
    private async scoped<T>(ctx: Actor, work: (tx: Connection, a: Actor) => Promise<T>, consistent = false): Promise<T> {
        try {
            return await this.db.transaction(async (tx) => { if (consistent)
                await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); return work(tx, await currentActor(tx, ctx)); });
        }
        catch (e) {
            if (e && typeof e === 'object' && 'code' in e && ['23505', '40001', '40P01'].includes(String(e.code)))
                return fail('CONFLICT', 409, "The record already exists or is changing. Reload and try again.");
            throw e;
        }
    }
    private management(a: Actor) { if (!manager(a))
        fail('FORBIDDEN', 403, "Administrator or manager permission is required."); }
    private writable(a: Actor, o?: Opportunity) { if (a.role === 'engineer' || (a.role === 'sales' && o?.ownerId !== undefined && o.ownerId !== a.memberId))
        fail('FORBIDDEN', 403, "You do not have permission to modify this opportunity."); }
    private revision(actual: number, expected: number) { if (actual !== expected)
        fail('CONFLICT', 409, "The content revision changed. Reload and try again."); }
    private async customer(tx: Connection, a: Actor, id: string) { const row = (await tx.query('SELECT id,owner_id FROM customers WHERE tenant_id=$1 AND id=$2 AND ($3 OR owner_id=$4) FOR SHARE', [a.tenantId, id, manager(a), a.memberId])).rows[0]; if (!row)
        return fail('NOT_FOUND', 404, "The customer does not exist or is outside your access scope."); return row; }
    private async member(tx: Connection, tenantId: string, id: string, active = false): Promise<Member> { const row = (await tx.query(`SELECT id,name,email,role,active,revision FROM members WHERE tenant_id=$1 AND id=$2${active ? ' AND active=true' : ''} FOR SHARE`, [tenantId, id])).rows[0]; if (!row)
        return fail('VALIDATION', 400, "The owner does not exist or is unavailable."); return mapped<Member>(row); }
    private async owner(tx: Connection, a: Actor, id: string, customerId: string) { const m = await this.member(tx, a.tenantId, id, true); if (m.role === 'engineer')
        fail('VALIDATION', 400, "An engineer cannot own an opportunity."); if (a.role === 'sales' && id !== a.memberId)
        fail('FORBIDDEN', 403, "Sales representatives can assign only themselves as opportunity owners."); await this.customer(tx, { tenantId: a.tenantId, memberId: m.id, role: m.role }, customerId); }
    private async source(tx: Connection, a: Actor, customerId: string, id: string | null) { if (id && !((await tx.query('SELECT 1 FROM evidence WHERE tenant_id=$1 AND customer_id=$2 AND id=$3', [a.tenantId, customerId, id])).rowCount))
        fail('VALIDATION', 400, "Evidence must belong to this customer."); }
    private async audit(tx: Connection, a: Actor, event: string, id: string, details: Record<string, unknown> = {}) { await tx.query('INSERT INTO audit_events(tenant_id,id,actor_id,event,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)', [a.tenantId, uid('aud'), a.memberId, event, id, JSON.stringify(details)]); }
    private async opportunity(tx: Connection, a: Actor, id: string, lock = false): Promise<Opportunity> {
        const link = (await tx.query('SELECT customer_id FROM opportunities WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
        if (!link) return fail('NOT_FOUND', 404, 'The opportunity does not exist or is outside your access scope.');
        // Hold customer scope before locking dependent work, matching handover order.
        await this.customer(tx, a, link.customer_id);
        const row = (await tx.query(`${opportunitySelect} WHERE o.tenant_id=$1 AND o.id=$2 AND ($3 OR c.owner_id=$4)${lock ? ' FOR UPDATE OF o' : ''}`, [a.tenantId, id, manager(a), a.memberId])).rows[0]; if (!row)
        return fail('NOT_FOUND', 404, "The opportunity does not exist or is outside your access scope."); return mapped<Opportunity>(row); }
    private async history(tx: Connection, a: Actor, before: Opportunity | null, after: Opportunity, note: string) { await tx.query('INSERT INTO opportunity_history(tenant_id,id,opportunity_id,revision,actor_id,note,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [a.tenantId, uid('hist'), after.id, after.revision, a.memberId, note, before ? JSON.stringify(before) : null, JSON.stringify(after)]); await this.audit(tx, a, 'opportunity.changed', after.id, { revision: after.revision, note }); }
    async listOpportunities(ctx: Actor, customerId?: string): Promise<Opportunity[]> { const query = parse(opportunityQuery, customerId === undefined ? {} : { customerId }); return this.scoped(ctx, async (tx, a) => { if (query.customerId)
        await this.customer(tx, a, query.customerId); return (await tx.query(`${opportunitySelect} WHERE o.tenant_id=$1 AND ($2 OR c.owner_id=$3) AND ($4::text IS NULL OR o.customer_id=$4) ORDER BY o.updated_at DESC,o.id`, [a.tenantId, manager(a), a.memberId, query.customerId ?? null])).rows.map(r => mapped<Opportunity>(r)); }); }
    async createOpportunity(ctx: Actor, input: z.input<typeof opportunityInput>): Promise<Opportunity> {
        const data = parse(opportunityInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.writable(a);
            await this.customer(tx, a, data.customerId);
            await this.owner(tx, a, data.ownerId, data.customerId);
            await this.source(tx, a, data.customerId, data.evidenceId);
            if (['won', 'lost'].includes(data.stage))
                fail('VALIDATION', 400, "A new opportunity must start in an open stage.");
            const id = uid('opp');
            await tx.query('INSERT INTO opportunities(tenant_id,id,customer_id,owner_id,title,amount_cents,expected_close_date,stage,forecast_category,next_step,next_step_due_date,evidence_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [a.tenantId, id, data.customerId, data.ownerId, data.title, data.amountCents, data.expectedCloseDate, data.stage, data.forecastCategory, data.nextStep, data.nextStepDueDate, data.evidenceId]);
            const after = await this.opportunity(tx, a, id);
            await this.history(tx, a, null, after, "Opportunity created");
            return after;
        });
    }
    async updateOpportunity(ctx: Actor, id: string, input: z.input<typeof opportunityUpdateInput>): Promise<Opportunity> {
        const data = parse(opportunityUpdateInput, input);
        return this.scoped(ctx, async (tx, a) => {
            const before = await this.opportunity(tx, a, id, true);
            this.writable(a, before);
            this.revision(before.revision, data.expectedRevision);
            if (before.stage === 'won')
                fail('CONFLICT', 409, "Business fields on a won opportunity cannot be edited. Correct the contract registration first if necessary.");
            if (data.customerId !== before.customerId)
                fail('CONFLICT', 409, "An opportunity cannot change customers after creation.");
            if (data.stage === 'won')
                fail('VALIDATION', 400, "Register the signed contract to mark this opportunity as won.");
            if (data.stage === 'lost' && !data.lostReason)
                fail('VALIDATION', 400, "A loss reason is required to close an opportunity as lost.");
            await this.customer(tx, a, before.customerId);
            await this.owner(tx, a, data.ownerId, data.customerId);
            await this.source(tx, a, before.customerId, data.evidenceId);
            const closedDate = data.stage === 'lost' ? (before.stage === 'lost' ? before.closedDate : today()) : null;
            await tx.query('UPDATE opportunities SET owner_id=$3,title=$4,amount_cents=$5,expected_close_date=$6,stage=$7,forecast_category=$8,next_step=$9,next_step_due_date=$10,evidence_id=$11,lost_reason=$12,closed_date=$13,stage_entered_at=CASE WHEN stage<>$7 THEN now() ELSE stage_entered_at END,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, id, data.ownerId, data.title, data.amountCents, data.expectedCloseDate, data.stage, data.forecastCategory, data.nextStep, data.nextStepDueDate, data.evidenceId, data.stage === 'lost' ? data.lostReason : null, closedDate]);
            const after = await this.opportunity(tx, a, id);
            await this.history(tx, a, before, after, data.note);
            return after;
        });
    }
    private async tasks(tx: Connection, tenantId: string, opportunityId?: string): Promise<OpportunityTask[]> { return (await tx.query('SELECT t.*,m.name AS assignee_name FROM opportunity_tasks t JOIN members m ON m.tenant_id=t.tenant_id AND m.id=t.assignee_id WHERE t.tenant_id=$1 AND ($2::text IS NULL OR t.opportunity_id=$2) ORDER BY t.created_at DESC,t.id', [tenantId, opportunityId ?? null])).rows.map(r => mapped<OpportunityTask>(r)); }
    private async receivables(tx: Connection, tenantId: string, opportunityId?: string, includeCancelled=false): Promise<Receivable[]> { return (await tx.query('SELECT r.*,COALESCE((SELECT sum(p.amount_cents) FROM payments p WHERE p.tenant_id=r.tenant_id AND p.receivable_id=r.id AND p.reversed_at IS NULL),0)-COALESCE((SELECT sum(f.amount_cents) FROM payment_refunds f WHERE f.tenant_id=r.tenant_id AND f.receivable_id=r.id AND f.reversed_at IS NULL),0) AS paid_cents FROM receivables r WHERE ($3 OR EXISTS (SELECT 1 FROM sales_contracts c WHERE c.tenant_id=r.tenant_id AND c.id=r.contract_id AND c.cancelled_at IS NULL)) AND r.tenant_id=$1 AND ($2::text IS NULL OR r.opportunity_id=$2) ORDER BY r.due_date,r.id', [tenantId, opportunityId ?? null, includeCancelled])).rows.map(row => { const value = mapped<Receivable>(row); return { ...value, remainingCents: integer(value.amountCents - value.paidCents) }; }); }
    private async detail(tx: Connection, a: Actor, id: string): Promise<OpportunityDetail> {
        const opportunity = await this.opportunity(tx, a, id);
        const history = (await tx.query('SELECT h.id,h.opportunity_id,h.revision,h.actor_id,m.name AS actor_name,h.note,h.before_state AS before,h.after_state AS after,h.created_at FROM opportunity_history h JOIN members m ON m.tenant_id=h.tenant_id AND m.id=h.actor_id WHERE h.tenant_id=$1 AND h.opportunity_id=$2 ORDER BY h.revision DESC', [a.tenantId, id])).rows.map(r => mapped<OpportunityHistory>(r));
        const evidence = (await tx.query('SELECT * FROM evidence WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC,id', [a.tenantId, opportunity.customerId])).rows.map(r => mapped<Evidence>(r));
        const contract = (await tx.query('SELECT * FROM sales_contracts WHERE tenant_id=$1 AND opportunity_id=$2 AND cancelled_at IS NULL', [a.tenantId, id])).rows[0];
        const payments = (await tx.query('SELECT * FROM payments WHERE tenant_id=$1 AND opportunity_id=$2 ORDER BY paid_date DESC,id', [a.tenantId, id])).rows.map(r => mapped<PaymentRecord>(r));
        const cancelledContracts = (await tx.query('SELECT * FROM sales_contracts WHERE tenant_id=$1 AND opportunity_id=$2 AND cancelled_at IS NOT NULL ORDER BY created_at', [a.tenantId, id])).rows.map(r => mapped<SalesContract>(r));
        const corrections = (await tx.query('SELECT f.* FROM financial_corrections f JOIN sales_contracts c ON c.tenant_id=f.tenant_id AND c.id=f.contract_id WHERE f.tenant_id=$1 AND c.opportunity_id=$2 ORDER BY f.created_at DESC', [a.tenantId, id])).rows.map(r => mapped<{
            id: string;
            kind: string;
            note: string;
            evidenceId: string;
            actorId: string;
            createdAt: string;
        }>(r));
        const refunds = (await tx.query('SELECT * FROM payment_refunds WHERE tenant_id=$1 AND opportunity_id=$2 ORDER BY refunded_date DESC,id',[a.tenantId,id])).rows.map(r=>mapped<RefundRecord>(r));
        return { opportunity, history, evidence, cancelledContracts, corrections, refunds, contract: contract ? mapped<SalesContract>(contract) : null, receivables: await this.receivables(tx, a.tenantId, id), payments, tasks: await this.tasks(tx, a.tenantId, id) };
    }
    async getOpportunity(ctx: Actor, id: string): Promise<OpportunityDetail> { return this.scoped(ctx, (tx, a) => this.detail(tx, a, id), true); }
    private advancementModel(tx: Connection, a: Actor) { return selectedModel(tx, a.tenantId); }
    private async advancementSource(tx: Connection, a: Actor, o: Opportunity, factId: string, factRevision: number) {
        const row = (await tx.query('SELECT * FROM facts WHERE tenant_id=$1 AND customer_id=$2 AND id=$3 FOR SHARE', [a.tenantId, o.customerId, factId])).rows[0];
        if (!row)
            return fail('NOT_FOUND', 404, "The source fact does not exist or belongs to another customer.");
        const fact = mapped<Fact>(row);
        if (fact.status !== 'confirmed' || !fact.reviewedBy || fact.revision !== factRevision)
            fail('CONFLICT', 409, "The source fact is not verified or its reviewed revision changed. Review it again.");
        const source = (await tx.query('SELECT * FROM evidence WHERE tenant_id=$1 AND customer_id=$2 AND id=$3 FOR SHARE', [a.tenantId, o.customerId, fact.evidenceId])).rows[0];
        if (!source || !fact.quote.trim() || !source.body.includes(fact.quote))
            return fail('CONFLICT', 409, "The source quote no longer matches the original evidence. Review the customer fact first.");
        return { fact, evidence: mapped<Evidence>(source) };
    }
    private async advancementReplay(tx: Connection, a: Actor, id: string, data: AdvancementInput) {
        const row = (await tx.query('SELECT * FROM advancement_proposals WHERE tenant_id=$1 AND created_by=$2 AND request_id=$3', [a.tenantId, a.memberId, data.requestId])).rows[0];
        if (!row)
            return null;
        const p = mapped<AdvancementProposal>(row);
        if (p.opportunityId !== id || p.opportunityRevision !== data.expectedRevision || p.factId !== data.factId || p.factRevision !== data.factRevision || p.goal !== data.goal || p.dueDate !== data.dueDate)
            fail('CONFLICT', 409, "This request ID has already been used for a different proposal.");
        return p;
    }
    private async advancementContext(tx: Connection, a: Actor, o: Opportunity, data: AdvancementInput): Promise<AdvancementContext> {
        this.revision(o.revision, data.expectedRevision);
        if (['won', 'lost'].includes(o.stage))
            fail('CONFLICT', 409, "Only open opportunities can generate or apply next-step proposals.");
        if (data.dueDate < today())
            fail('CONFLICT', 409, "The deadline has passed. Set a new deadline and generate another proposal.");
        await this.advancementModel(tx, a);
        const previousDecisions=(await tx.query('SELECT * FROM advancement_proposals WHERE tenant_id=$1 AND opportunity_id=$2 ORDER BY created_at DESC LIMIT 10',[a.tenantId,o.id])).rows.map(r=>mapped<AdvancementProposal>(r));
        const outcomes=await this.detail(tx,a,o.id);
        const actions=(await tx.query('SELECT a.id,a.status,a.resolution_note,a.updated_at,(SELECT row_to_json(r) FROM receipts r WHERE r.tenant_id=a.tenant_id AND r.action_id=a.id) AS receipt FROM actions a WHERE a.tenant_id=$1 AND a.customer_id=$2 ORDER BY a.updated_at DESC LIMIT 10',[a.tenantId,o.customerId])).rows.map(r=>mapped<NonNullable<AdvancementContext['outcomes']>['actions'][number]>(r));
        return { previousDecisions, outcomes:{actions,tasks:outcomes.tasks,contract:outcomes.contract,payments:outcomes.payments,refunds:outcomes.refunds}, opportunity: o, ...await this.advancementSource(tx, a, o, data.factId, data.factRevision), goal: data.goal, dueDate: data.dueDate };
    }
    async prepareAdvancement(ctx: Actor, id: string, input: AdvancementInput): Promise<{
        kind: 'existing';
        proposal: AdvancementProposal;
    } | {
        kind: 'context';
        context: AdvancementContext;
    }> {
        const data = parse(advancementInput, input);
        return this.scoped(ctx, async (tx, a) => {
            const o = await this.opportunity(tx, a, id);
            this.writable(a, o);
            await this.customer(tx, a, o.customerId);
            const prior = await this.advancementReplay(tx, a, id, data);
            if (prior)
                return { kind: 'existing', proposal: prior };
            return { kind: 'context', context: await this.advancementContext(tx, a, o, data) };
        });
    }
    async saveAdvancement(ctx: Actor, id: string, input: AdvancementInput, rawPlan: AdvancementPlan, binding?: ModelConnection): Promise<AdvancementProposal> {
        const data = parse(advancementInput, input);
        const plan = parse(advancementPlanSchema, rawPlan);
        return this.scoped(ctx, async (tx, a) => {
            // Serialize retries by the initiating actor and request, including requests for different opportunities.
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`advancement:${a.tenantId}:${a.memberId}:${data.requestId}`]);
            const o = await this.opportunity(tx, a, id, true);
            this.writable(a, o);
            await this.customer(tx, a, o.customerId);
            const prior = await this.advancementReplay(tx, a, id, data);
            if (prior)
                return prior;
            const context = await this.advancementContext(tx, a, o, data);
            const model = await this.advancementModel(tx, a);
            if (binding && (binding.id !== model.id || binding.revision !== model.revision))
                fail('CONFLICT', 409, 'Model configuration changed during generation.');
            const row = (await tx.query(`INSERT INTO advancement_proposals(tenant_id,id,opportunity_id,customer_id,request_id,created_by,opportunity_revision,fact_id,fact_revision,evidence_id,evidence_title,quote,fact_value,goal,due_date,next_step,rationale,previous_next_step,previous_due_date,model)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`, [a.tenantId, uid('advance'), id, o.customerId, data.requestId, a.memberId, o.revision, context.fact.id, context.fact.revision, context.evidence.id, context.evidence.title, context.fact.quote, context.fact.value, data.goal, data.dueDate, plan.nextStep, plan.rationale, o.nextStep, o.nextStepDueDate, binding?.model ?? 'fixture-v1'])).rows[0]!;
            await this.audit(tx, a, 'advancement.proposed', row.id, { opportunityId: id, opportunityRevision: o.revision, factId: data.factId, factRevision: data.factRevision });
            return mapped<AdvancementProposal>(row);
        });
    }
    async listAdvancements(ctx: Actor, id: string): Promise<AdvancementProposal[]> {
        return this.scoped(ctx, async (tx, a) => {
            const o = await this.opportunity(tx, a, id);
            await this.customer(tx, a, o.customerId);
            return (await tx.query('SELECT * FROM advancement_proposals WHERE tenant_id=$1 AND opportunity_id=$2 ORDER BY created_at DESC,id DESC', [a.tenantId, id])).rows.map(row => mapped<AdvancementProposal>(row));
        });
    }
    async decideAdvancement(ctx: Actor, id: string, proposalId: string, input: z.input<typeof advancementDecisionInput>): Promise<AdvancementProposal> {
        const data = parse(advancementDecisionInput, input);
        return this.scoped(ctx, async (tx, a) => {
            const before = await this.opportunity(tx, a, id, true);
            this.writable(a, before);
            await this.customer(tx, a, before.customerId);
            const row = (await tx.query('SELECT * FROM advancement_proposals WHERE tenant_id=$1 AND opportunity_id=$2 AND id=$3 FOR UPDATE', [a.tenantId, id, proposalId])).rows[0];
            if (!row)
                return fail('NOT_FOUND', 404, "Next-step proposal not found.");
            const p = mapped<AdvancementProposal>(row);
            const status = data.decision === 'apply' ? 'applied' : 'dismissed';
            if (p.status !== 'pending') {
                if (p.status === status && p.revision === data.expectedRevision + 1 && p.decidedBy === a.memberId && p.decisionNote === data.note)
                    return p;
                return fail('CONFLICT', 409, "This proposal is already resolved. Reload to view the result.");
            }
            this.revision(p.revision, data.expectedRevision);
            let appliedRevision: number | null = null;
            if (data.decision === 'apply') {
                const context = await this.advancementContext(tx, a, before, { requestId: p.requestId, expectedRevision: p.opportunityRevision, factId: p.factId, factRevision: p.factRevision, goal: p.goal, dueDate: p.dueDate });
                if (context.evidence.id !== p.evidenceId || context.fact.quote !== p.quote || context.fact.value !== p.factValue)
                    fail('CONFLICT', 409, "The supporting context changed. Generate another proposal.");
                // Applying a plan only changes the next step; its source stays with the proposal, not the deal's original evidence.
                await tx.query('UPDATE opportunities SET next_step=$3,next_step_due_date=$4,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, id, p.nextStep, p.dueDate]);
                const after = await this.opportunity(tx, a, id);
                appliedRevision = after.revision;
                await this.history(tx, a, before, after, "Applied next-step proposal " + p.id + ": " + data.note + "");
            }
            const decided = (await tx.query('UPDATE advancement_proposals SET status=$3,revision=revision+1,decided_by=$4,decided_at=now(),decision_note=$5,applied_opportunity_revision=$6 WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, p.id, status, a.memberId, data.note, appliedRevision])).rows[0]!;
            await this.audit(tx, a, `advancement.${status}`, p.id, { opportunityId: id, approvedRevision: p.revision, appliedOpportunityRevision: appliedRevision, note: data.note });
            return mapped<AdvancementProposal>(decided);
        });
    }
    async recordContract(ctx: Actor, id: string, input: z.input<typeof contractInput>): Promise<OpportunityDetail> {
        const data = parse(contractInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.management(a);
            const before = await this.opportunity(tx, a, id, true);
            this.revision(before.revision, data.expectedRevision);
            if (['won', 'lost'].includes(before.stage))
                fail('CONFLICT', 409, "Only open opportunities can register a contract.");
            if (data.signedDate > today())
                fail('VALIDATION', 400, "The signing date cannot be in the future.");
            if (integer(data.installments.reduce((sum, item) => sum + item.amountCents, 0)) !== data.amountCents)
                fail('VALIDATION', 400, "Installments must total the contract amount.");
            if (data.installments.some(i => i.dueDate < data.signedDate))
                fail('VALIDATION', 400, "An installment cannot be due before the signing date.");
            const contractId = uid('contract');
            await tx.query('INSERT INTO sales_contracts(tenant_id,id,opportunity_id,customer_id,owner_id,amount_cents,signed_date,reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [a.tenantId, contractId, id, before.customerId, before.ownerId, data.amountCents, data.signedDate, data.reference]);
            for (const installment of data.installments)
                await tx.query('INSERT INTO receivables(tenant_id,id,contract_id,opportunity_id,owner_id,due_date,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7)', [a.tenantId, uid('recv'), contractId, id, before.ownerId, installment.dueDate, installment.amountCents]);
            await tx.query("UPDATE opportunities SET stage='won',closed_date=$3,amount_cents=$4,lost_reason=NULL,revision=revision+1,stage_entered_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2", [a.tenantId, id, data.signedDate, data.amountCents]);
            const after = await this.opportunity(tx, a, id);
            await this.history(tx, a, before, after, "Contract registered: " + data.reference + "");
            await this.audit(tx, a, 'contract.recorded', contractId, { opportunityId: id, amountCents: data.amountCents });
            return this.detail(tx, a, id);
        });
    }
    async recordPayment(ctx: Actor, id: string, input: z.input<typeof paymentInput>): Promise<PaymentRecord> {
        const data = parse(paymentInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.management(a);
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment:${a.tenantId}:${data.reference}`]);
            const prior = (await tx.query('SELECT * FROM payments WHERE tenant_id=$1 AND reference=$2', [a.tenantId, data.reference])).rows[0];
            if (prior) {
                const payment = mapped<PaymentRecord>(prior);
                if (payment.receivableId !== id || payment.amountCents !== data.amountCents || payment.paidDate !== data.paidDate)
                    fail('CONFLICT', 409, "This payment reference has already been used for different details.");
                return payment;
            }
            const link=(await tx.query('SELECT contract_id FROM receivables WHERE tenant_id=$1 AND id=$2',[a.tenantId,id])).rows[0];
            if(!link) return fail('NOT_FOUND',404,'Receivable installment not found.');
            // All financial commands lock the contract before its installments.
            await tx.query('SELECT id FROM sales_contracts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,link.contract_id]);
            const row = (await tx.query('SELECT r.*,c.signed_date,c.cancelled_at FROM receivables r JOIN sales_contracts c ON c.tenant_id=r.tenant_id AND c.id=r.contract_id WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r', [a.tenantId, id])).rows[0];
            if (!row)
                return fail('NOT_FOUND', 404, "Receivable installment not found.");
            if (row.cancelled_at)
                fail('CONFLICT', 409, 'A cancelled contract cannot receive payments.');
            if (data.paidDate > today() || data.paidDate < row.signed_date)
                fail('VALIDATION', 400, "The payment date must be between signing and today.");
            const sum = integer((await tx.query('SELECT COALESCE((SELECT sum(amount_cents) FROM payments WHERE tenant_id=$1 AND receivable_id=$2 AND reversed_at IS NULL),0)-COALESCE((SELECT sum(amount_cents) FROM payment_refunds WHERE tenant_id=$1 AND receivable_id=$2 AND reversed_at IS NULL),0) AS paid', [a.tenantId, id])).rows[0].paid);
            if (data.amountCents > integer(row.amount_cents) - sum)
                fail('CONFLICT', 409, "The amount exceeds the remaining installment balance.");
            const payment = (await tx.query('INSERT INTO payments(tenant_id,id,receivable_id,contract_id,opportunity_id,owner_id,amount_cents,paid_date,reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [a.tenantId, uid('payment'), id, row.contract_id, row.opportunity_id, row.owner_id, data.amountCents, data.paidDate, data.reference])).rows[0];
            await this.audit(tx, a, 'payment.recorded', payment.id, { receivableId: id, amountCents: data.amountCents });
            return mapped<PaymentRecord>(payment);
        });
    }
    async recordRefund(ctx: Actor, paymentId: string, input: z.input<typeof refundInput>): Promise<RefundRecord> {
        const data=parse(refundInput,input);
        return this.scoped(ctx,async(tx,a)=>{
            this.management(a);
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`refund:${a.tenantId}`]);
            const payment=(await tx.query('SELECT * FROM payments WHERE tenant_id=$1 AND id=$2',[a.tenantId,paymentId])).rows[0];
            if(!payment) return fail('NOT_FOUND',404,'Payment record not found.');
            const opportunity=await this.opportunity(tx,a,payment.opportunity_id,true);
            const prior=(await tx.query('SELECT * FROM payment_refunds WHERE tenant_id=$1 AND (request_id=$2 OR reference=$3)',[a.tenantId,data.requestId,data.reference])).rows;
            if(prior.length){
                const same=prior.length===1&&prior[0].payment_id===paymentId&&integer(prior[0].amount_cents)===data.amountCents&&prior[0].refunded_date===data.refundedDate&&prior[0].reference===data.reference&&prior[0].note===data.note&&prior[0].evidence_id===data.evidenceId;
                if(!same) fail('CONFLICT',409,'This refund request or reference belongs to different details.');
                return mapped<RefundRecord>(prior[0]);
            }
            await this.source(tx,a,opportunity.customerId,data.evidenceId);
            const contract=(await tx.query('SELECT * FROM sales_contracts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,payment.contract_id])).rows[0]!;
            await tx.query('SELECT id FROM receivables WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,payment.receivable_id]);
            const current=(await tx.query('SELECT * FROM payments WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,paymentId])).rows[0]!;
            if(current.reversed_at||contract.cancelled_at) fail('CONFLICT',409,'Refunds require an active payment and contract.');
            if(data.refundedDate<current.paid_date||data.refundedDate>today()) fail('VALIDATION',400,'The refund date must be between payment and today.');
            const refunded=integer((await tx.query('SELECT COALESCE(sum(amount_cents),0) AS total FROM payment_refunds WHERE tenant_id=$1 AND payment_id=$2 AND reversed_at IS NULL',[a.tenantId,paymentId])).rows[0].total);
            if(data.amountCents>integer(current.amount_cents)-refunded) fail('CONFLICT',409,'The refund exceeds the unrefunded payment amount.');
            const result=(await tx.query('INSERT INTO payment_refunds(tenant_id,id,request_id,payment_id,contract_id,receivable_id,opportunity_id,owner_id,customer_id,evidence_id,actor_id,amount_cents,refunded_date,reference,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',[a.tenantId,uid('refund'),data.requestId,paymentId,current.contract_id,current.receivable_id,current.opportunity_id,current.owner_id,opportunity.customerId,data.evidenceId,a.memberId,data.amountCents,data.refundedDate,data.reference,data.note])).rows[0]!;
            await this.audit(tx,a,'refund.recorded',result.id,{paymentId,amountCents:data.amountCents,evidenceId:data.evidenceId,note:data.note});
            return mapped<RefundRecord>(result);
        });
    }
    async correctFinancialRecord(ctx: Actor, kind: 'contract_cancelled' | 'payment_reversed' | 'refund_reversed', id: string, input: z.input<typeof financialCorrectionInput>): Promise<OpportunityDetail> {
        const data = parse(financialCorrectionInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.management(a);
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`correction:${a.tenantId}:${data.requestId}`]);
            const previous = (await tx.query('SELECT * FROM financial_corrections WHERE tenant_id=$1 AND request_id=$2', [a.tenantId, data.requestId])).rows[0];
            const target = kind === 'contract_cancelled' ? (await tx.query('SELECT id AS contract_id,opportunity_id FROM sales_contracts WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0] : (await tx.query(`SELECT contract_id,opportunity_id FROM ${kind==='refund_reversed'?'payment_refunds':'payments'} WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id])).rows[0];
            if (!target)
                return fail('NOT_FOUND', 404, 'Financial record not found.');
            const before = await this.opportunity(tx, a, target.opportunity_id, true);
            await this.customer(tx, a, before.customerId);
            if (previous) {
                if (previous.kind !== kind || (kind === 'contract_cancelled' ? previous.contract_id : kind==='refund_reversed'?previous.refund_id:previous.payment_id) !== id || previous.note !== data.note || previous.evidence_id !== data.evidenceId)
                    fail('CONFLICT', 409, 'This request ID belongs to a different correction.');
                return this.detail(tx, a, before.id);
            }
            await this.source(tx, a, before.customerId, data.evidenceId);
            const contract = (await tx.query('SELECT * FROM sales_contracts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, target.contract_id])).rows[0]!;
            if (kind === 'contract_cancelled') {
                if (contract.cancelled_at)
                    fail('CONFLICT', 409, 'This contract is already cancelled.');
                if ((await tx.query('SELECT 1 FROM payments p WHERE p.tenant_id=$1 AND p.contract_id=$2 AND p.reversed_at IS NULL AND p.amount_cents > COALESCE((SELECT sum(f.amount_cents) FROM payment_refunds f WHERE f.tenant_id=p.tenant_id AND f.payment_id=p.id AND f.reversed_at IS NULL),0)', [a.tenantId, contract.id])).rowCount)
                    fail('CONFLICT', 409, 'Record full refunds or reverse incorrect payment entries before cancelling this contract.');
                await tx.query('UPDATE sales_contracts SET cancelled_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]);
                await tx.query("UPDATE opportunities SET stage='negotiation',closed_date=NULL,revision=revision+1,stage_entered_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2", [a.tenantId, before.id]);
                await this.history(tx, a, before, await this.opportunity(tx, a, before.id), `Contract cancelled: ${data.note}`);
            }
            else if(kind==='payment_reversed') {
                if ((await tx.query('SELECT 1 FROM payment_refunds WHERE tenant_id=$1 AND payment_id=$2 AND reversed_at IS NULL',[a.tenantId,id])).rowCount) fail('CONFLICT',409,'A payment with recorded refunds cannot be reversed. Correct its refund entries first.');
                const payment = (await tx.query('SELECT * FROM payments WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0]!;
                if (payment.reversed_at)
                    fail('CONFLICT', 409, 'This payment record is already reversed.');
                await tx.query('SELECT id FROM receivables WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, payment.receivable_id]);
                await tx.query('UPDATE payments SET reversed_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]);
            }
            else {
                if(contract.cancelled_at) fail('CONFLICT',409,'Refunds on a cancelled contract cannot be reversed.');
                const refund=(await tx.query('SELECT * FROM payment_refunds WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,id])).rows[0]!;
                if(refund.reversed_at) fail('CONFLICT',409,'This refund record is already reversed.');
                const receivable=(await this.receivables(tx,a.tenantId,before.id)).find(r=>r.id===refund.receivable_id)!;
                if(integer(refund.amount_cents)>receivable.remainingCents) fail('CONFLICT',409,'Reversing this refund would overpay the installment. Correct replacement payments first.');
                await tx.query('UPDATE payment_refunds SET reversed_at=now() WHERE tenant_id=$1 AND id=$2',[a.tenantId,id]);
            }
            const correctionId = uid('correction');
            await tx.query('INSERT INTO financial_corrections(tenant_id,id,request_id,contract_id,payment_id,actor_id,evidence_id,customer_id,kind,note,refund_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [a.tenantId, correctionId, data.requestId, contract.id, kind === 'payment_reversed' ? id : null, a.memberId, data.evidenceId, before.customerId, kind, data.note, kind==='refund_reversed'?id:null]);
            await this.audit(tx, a, kind, correctionId, { recordId: id, note: data.note, evidenceId: data.evidenceId });
            return this.detail(tx, a, before.id);
        });
    }
    async createTask(ctx: Actor, id: string, input: z.input<typeof opportunityTaskInput>): Promise<OpportunityTask> {
        const data = parse(opportunityTaskInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.management(a);
            const opportunity = await this.opportunity(tx, a, id, true);
            const assignee = await this.member(tx, a.tenantId, data.assigneeId, true);
            await this.customer(tx, { tenantId: a.tenantId, memberId: assignee.id, role: assignee.role }, opportunity.customerId);
            const taskId = uid('task');
            await tx.query('INSERT INTO opportunity_tasks(tenant_id,id,opportunity_id,title,assignee_id,due_date) VALUES($1,$2,$3,$4,$5,$6)', [a.tenantId, taskId, id, data.title, data.assigneeId, data.dueDate]);
            await this.audit(tx, a, 'opportunity.task.created', taskId, { opportunityId: id, assigneeId: data.assigneeId });
            return (await this.tasks(tx, a.tenantId, id)).find(t => t.id === taskId)!;
        });
    }
    async completeTask(ctx: Actor, id: string, input: z.input<typeof taskCompletionInput>): Promise<OpportunityTask> {
        const data = parse(taskCompletionInput, input);
        return this.scoped(ctx, async (tx, a) => {
            const link = (await tx.query('SELECT opportunity_id FROM opportunity_tasks WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
            if (!link) return fail('NOT_FOUND', 404, 'Intervention task not found.');
            await this.opportunity(tx, a, link.opportunity_id);
            const task = (await tx.query('SELECT * FROM opportunity_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
            if (!task)
                return fail('NOT_FOUND', 404, "Intervention task not found.");
            const opportunity = await this.opportunity(tx, a, task.opportunity_id);
            await this.customer(tx, a, opportunity.customerId);
            if (!manager(a) && task.assignee_id !== a.memberId)
                fail('FORBIDDEN', 403, "Only the assignee or a manager can complete this task.");
            this.revision(task.revision, data.expectedRevision);
            if (task.status !== 'open')
                fail('CONFLICT', 409, "This task is already closed.");
            await tx.query("UPDATE opportunity_tasks SET status='completed',completion_note=$3,revision=revision+1,completed_at=now() WHERE tenant_id=$1 AND id=$2", [a.tenantId, id, data.completionNote]);
            await this.audit(tx, a, 'opportunity.task.completed', id, { completionNote: data.completionNote });
            return (await this.tasks(tx, a.tenantId, task.opportunity_id)).find(t => t.id === id)!;
        });
    }
    async updateTask(ctx: Actor, id: string, input: z.input<typeof taskUpdateInput>): Promise<OpportunityTask> {
        const data = parse(taskUpdateInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.management(a);
            const link = (await tx.query('SELECT opportunity_id FROM opportunity_tasks WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
            if (!link) return fail('NOT_FOUND', 404, 'Task not found.');
            await this.opportunity(tx, a, link.opportunity_id);
            const task = (await tx.query('SELECT * FROM opportunity_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
            if (!task)
                return fail('NOT_FOUND', 404, 'Task not found.');
            this.revision(task.revision, data.expectedRevision);
            const opportunity = await this.opportunity(tx, a, task.opportunity_id);
            const assignee = await this.member(tx, a.tenantId, data.assigneeId, true);
            await this.customer(tx, { tenantId: a.tenantId, memberId: assignee.id, role: assignee.role }, opportunity.customerId);
            await tx.query('UPDATE opportunity_tasks SET assignee_id=$3,due_date=$4,status=$5,change_note=$6,revision=revision+1,completion_note=NULL,completed_at=NULL WHERE tenant_id=$1 AND id=$2', [a.tenantId, id, data.assigneeId, data.dueDate, data.status, data.note]);
            await this.audit(tx, a, 'opportunity.task.updated', id, { before: task, after: data });
            return (await this.tasks(tx, a.tenantId, task.opportunity_id)).find(t => t.id === id)!;
        });
    }
    private async target(tx: Connection, tenantId: string, period: string, ownerId: string | null): Promise<SalesTarget | null> { const row = (await tx.query('SELECT period,owner_id,bookings_target_cents,collection_target_cents,revision,updated_at FROM sales_targets WHERE tenant_id=$1 AND period=$2 AND owner_id IS NOT DISTINCT FROM $3', [tenantId, period, ownerId])).rows[0]; return row ? mapped<SalesTarget>(row) : null; }
    private async snapshots(tx: Connection, tenantId: string, period: string, ownerId: string | null): Promise<ForecastSnapshot[]> { return (await tx.query('SELECT * FROM forecast_snapshots WHERE tenant_id=$1 AND period=$2 AND owner_id IS NOT DISTINCT FROM $3 ORDER BY captured_at DESC,id DESC', [tenantId, period, ownerId])).rows.map(r => mapped<ForecastSnapshot>(r)); }
    private async overview(tx: Connection, a: Actor, query: z.infer<typeof managementQuery>): Promise<ManagementOverview> {
        this.management(a);
        const ownerId = query.ownerId ?? null;
        if (ownerId)
            await this.member(tx, a.tenantId, ownerId);
        const data: ManagementData = { opportunities: (await tx.query(`${opportunitySelect} WHERE o.tenant_id=$1 ORDER BY o.id`, [a.tenantId])).rows.map(r => mapped<Opportunity>(r)), contracts: (await tx.query('SELECT * FROM sales_contracts WHERE tenant_id=$1', [a.tenantId])).rows.map(r => mapped<SalesContract>(r)), receivables: await this.receivables(tx, a.tenantId, undefined, true), refunds: (await tx.query('SELECT * FROM payment_refunds WHERE tenant_id=$1 AND reversed_at IS NULL',[a.tenantId])).rows.map(r=>mapped<RefundRecord>(r)), payments: (await tx.query('SELECT * FROM payments WHERE tenant_id=$1 AND reversed_at IS NULL', [a.tenantId])).rows.map(r => mapped<PaymentRecord>(r)), tasks: await this.tasks(tx, a.tenantId), members: (await tx.query('SELECT id,name,email,role,active,revision FROM members WHERE tenant_id=$1', [a.tenantId])).rows.map(r => mapped<Member>(r)) };
        return calculateManagementOverview(data, { period: query.period, ownerId, asOfDate: today(), generatedAt: new Date().toISOString(), target: await this.target(tx, a.tenantId, query.period, ownerId), latestSnapshot: (await this.snapshots(tx, a.tenantId, query.period, ownerId))[0] ?? null });
    }
    async getOverview(ctx: Actor, input: z.input<typeof managementQuery>): Promise<ManagementOverview> { const query = parse(managementQuery, input); return this.scoped(ctx, (tx, a) => this.overview(tx, a, query), true); }
    async saveTarget(ctx: Actor, input: z.input<typeof targetInput>): Promise<SalesTarget> {
        const data = parse(targetInput, input);
        return this.scoped(ctx, async (tx, a) => {
            this.management(a);
            if (data.ownerId)
                await this.member(tx, a.tenantId, data.ownerId);
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`target:${a.tenantId}:${data.period}:${data.ownerId ?? ''}`]);
            const prior = await this.target(tx, a.tenantId, data.period, data.ownerId);
            this.revision(prior?.revision ?? 0, data.expectedRevision);
            if (prior)
                await tx.query('UPDATE sales_targets SET bookings_target_cents=$4,collection_target_cents=$5,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND period=$2 AND owner_id IS NOT DISTINCT FROM $3', [a.tenantId, data.period, data.ownerId, data.bookingsTargetCents, data.collectionTargetCents]);
            else
                await tx.query('INSERT INTO sales_targets(tenant_id,id,period,owner_id,bookings_target_cents,collection_target_cents) VALUES($1,$2,$3,$4,$5,$6)', [a.tenantId, uid('target'), data.period, data.ownerId, data.bookingsTargetCents, data.collectionTargetCents]);
            await this.audit(tx, a, 'sales.target.saved', `${data.period}:${data.ownerId ?? 'workspace'}`, { revision: (prior?.revision ?? 0) + 1 });
            return (await this.target(tx, a.tenantId, data.period, data.ownerId))!;
        });
    }
    async captureSnapshot(ctx: Actor, input: z.input<typeof snapshotInput>): Promise<ForecastSnapshot> {
        const data = parse(snapshotInput, input);
        return this.scoped(ctx, async (tx, a) => {
            const overview = await this.overview(tx, a, { period: data.period, ...(data.ownerId ? { ownerId: data.ownerId } : {}) });
            const id = uid('snapshot');
            const items: ForecastItem[] = overview.opportunities.map(({ id, title, customerName, amountCents, stage, forecastCategory, expectedCloseDate, ownerId }) => ({ id, title, customerName, amountCents, stage, forecastCategory, expectedCloseDate, ownerId }));
            const row = (await tx.query('INSERT INTO forecast_snapshots(tenant_id,id,period,owner_id,captured_by,metrics,items,captured_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [a.tenantId, id, data.period, data.ownerId, a.memberId, JSON.stringify(overview.metrics), JSON.stringify(items), overview.generatedAt])).rows[0];
            await this.audit(tx, a, 'forecast.snapshot.captured', id, { period: data.period, ownerId: data.ownerId });
            return mapped<ForecastSnapshot>(row);
        }, true);
    }
    async listSnapshots(ctx: Actor, input: z.input<typeof managementQuery>): Promise<ForecastSnapshot[]> { const query = parse(managementQuery, input); return this.scoped(ctx, async (tx, a) => { this.management(a); if (query.ownerId)
        await this.member(tx, a.tenantId, query.ownerId); return this.snapshots(tx, a.tenantId, query.period, query.ownerId ?? null); }, true); }
}
