import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { customerInput, customerUpdateInput, customerHandoverInput, factReviewInput, retryRunInput, conversationInput, conversationQuery, conversationDetailQuery, conversationMessageInput, type Actor, type Customer, type Fact, type FactReview, type ProductRun, type WorkInbox, type IntentAction, type OpportunityTask, type Conversation, type ConversationPage, type ConversationDetail, type ChatTurn, type ChatReply, } from '@intent/contracts';
import type { Connection, Database } from '@intent/database';
import { DomainError } from './index.js';
import { currentActor } from './authorization.js';
import { withActionReceipts } from './action-receipts.js';
const uid = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const fail = (code: string, status: number, message: string): never => { throw new DomainError(code, status, message); };
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
    const result = schema.safeParse(input);
    return result.success ? result.data : fail('VALIDATION', 400, "Invalid input. Check required fields and data types.");
};
const elevated = (actor: Actor) => actor.role === 'admin' || actor.role === 'manager';
const mapped = <T>(row: Record<string, unknown>): T => Object.fromEntries(Object.entries(row)
    .filter(([key]) => !['tenant_id', 'source_digest'].includes(key))
    .map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value instanceof Date ? value.toISOString() : value])) as T;
const runSelect = 'SELECT r.*,(SELECT s.id FROM planning_runs s WHERE s.tenant_id=r.tenant_id AND s.parent_run_id=r.id) AS successor_run_id FROM planning_runs r';
const conversationColumns = 'id,customer_id,title,created_at,updated_at';
const turnColumns = 'id,request_id,message,reply,created_at';
const replySchema = z.object({
    text: z.string().min(1).max(20000), model: z.string().min(1).max(160),
    sources: z.array(z.object({ id: z.string().min(1).max(100), title: z.string().min(1).max(200), quote: z.string().min(1).max(2000) }).strict()).max(20),
    cards: z.array(z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(500), description: z.string().max(4000), label: z.string().min(1).max(200), href: z.string().min(1).max(500), tone: z.enum(['neutral', 'attention', 'success']) }).strict()).max(30),
}).strict();
export class ProductService {
    constructor(readonly db: Database) { }
    private async scoped<T>(ctx: Actor, work: (tx: Connection, actor: Actor) => Promise<T>): Promise<T> {
        try {
            return await this.db.transaction(async (tx) => {
                return work(tx, await currentActor(tx, ctx));
            });
        }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && ['23505', '40001', '40P01'].includes(String(error.code))) {
                return fail('CONFLICT', 409, "The record already exists or is changing. Reload and try again.");
            }
            throw error;
        }
    }
    private async customer(tx: Connection, actor: Actor, id: string, update = false): Promise<Customer> {
        const row = (await tx.query(`SELECT * FROM customers WHERE tenant_id=$1 AND id=$2 AND ($3 OR owner_id=$4) FOR ${update ? 'UPDATE' : 'SHARE'}`, [actor.tenantId, id, elevated(actor), actor.memberId])).rows[0];
        return row ? mapped<Customer>(row) : fail('NOT_FOUND', 404, "The customer does not exist or is outside your access scope.");
    }
    private writable(actor: Actor) {
        if (actor.role === 'engineer')
            fail('FORBIDDEN', 403, "Engineers cannot edit customers, review facts or retry planning.");
    }
    private revision(actual: number, expected: number) {
        if (actual !== expected)
            fail('CONFLICT', 409, "The content revision changed. Reload and try again.");
    }
    private async audit(tx: Connection, actor: Actor, event: string, entityId: string, details: Record<string, unknown> = {}) {
        await tx.query('INSERT INTO audit_events(tenant_id,id,actor_id,event,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)', [actor.tenantId, uid('aud'), actor.memberId, event, entityId, JSON.stringify(details)]);
    }
    private async owner(tx: Connection, actor: Actor, id: string) {
        if (!elevated(actor) && id !== actor.memberId)
            fail('FORBIDDEN', 403, "Sales representatives can create and maintain only customers they own.");
        if (!(await tx.query('SELECT id FROM members WHERE tenant_id=$1 AND id=$2 AND active=true FOR SHARE', [actor.tenantId, id])).rowCount)
            fail('VALIDATION', 400, "The customer owner does not exist or is disabled.");
    }
    async createCustomer(ctx: Actor, input: z.input<typeof customerInput>): Promise<Customer> {
        const data = parse(customerInput, input);
        return this.scoped(ctx, async (tx, actor) => {
            this.writable(actor);
            await this.owner(tx, actor, data.ownerId);
            const row = (await tx.query('INSERT INTO customers(tenant_id,id,name,industry,contact,email,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [actor.tenantId, uid('cus'), data.name, data.industry, data.contact, data.email, data.ownerId])).rows[0]!;
            await this.audit(tx, actor, 'customer.created', row.id, { ownerId: data.ownerId });
            return mapped<Customer>(row);
        });
    }
    async updateCustomer(ctx: Actor, id: string, input: z.input<typeof customerUpdateInput>): Promise<Customer> {
        const data = parse(customerUpdateInput, input);
        return this.scoped(ctx, async (tx, actor) => {
            this.writable(actor);
            const before = await this.customer(tx, actor, id, true);
            this.revision(before.revision, data.expectedRevision);
            await this.owner(tx, actor, data.ownerId);
            if (data.ownerId !== before.ownerId)
                fail('CONFLICT', 409, 'Use customer handover to change ownership and review pending work.');
            const row = (await tx.query('UPDATE customers SET name=$3,industry=$4,contact=$5,email=$6,owner_id=$7,revision=revision+1 WHERE tenant_id=$1 AND id=$2 RETURNING *', [actor.tenantId, id, data.name, data.industry, data.contact, data.email, data.ownerId])).rows[0]!;
            await this.audit(tx, actor, 'customer.updated', id, { revision: row.revision, note: data.note, before, after: mapped<Customer>(row) });
            return mapped<Customer>(row);
        });
    }
    async handoverCustomer(ctx: Actor, id: string, input: z.input<typeof customerHandoverInput>): Promise<Customer> {
        const data = parse(customerHandoverInput, input);
        return this.scoped(ctx, async (tx, actor) => {
            if (!elevated(actor))
                fail('FORBIDDEN', 403, 'Customer handover requires a manager or administrator.');
            const before = await this.customer(tx, actor, id, true);
            this.revision(before.revision, data.expectedRevision);
            const next = (await tx.query('SELECT id,role,name FROM members WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE', [actor.tenantId, data.ownerId])).rows[0];
            if (!next || next.role === 'engineer')
                fail('VALIDATION', 400, 'Select an active sales member, manager or administrator.');
            if (before.ownerId === data.ownerId)
                fail('CONFLICT', 409, 'The selected member already owns this customer.');
            const opportunities = (await tx.query("SELECT o.*,c.name AS customer_name,m.name AS owner_name FROM opportunities o JOIN customers c ON c.tenant_id=o.tenant_id AND c.id=o.customer_id JOIN members m ON m.tenant_id=o.tenant_id AND m.id=o.owner_id WHERE o.tenant_id=$1 AND o.customer_id=$2 AND o.stage NOT IN ('won','lost') ORDER BY o.id FOR UPDATE OF o", [actor.tenantId, id])).rows;
            for (const row of opportunities) {
                const previous = { ...mapped<Record<string, unknown>>(row), amountCents: Number(row.amount_cents) };
                const updated = (await tx.query('UPDATE opportunities SET owner_id=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [actor.tenantId, row.id, data.ownerId])).rows[0]!;
                const after = { ...mapped<Record<string, unknown>>(updated), amountCents: Number(updated.amount_cents), customerName: before.name, ownerName: next.name };
                await tx.query('INSERT INTO opportunity_history(tenant_id,id,opportunity_id,revision,actor_id,note,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [actor.tenantId, uid('history'), row.id, updated.revision, actor.memberId, data.note, JSON.stringify(previous), JSON.stringify(after)]);
            }
            const tasks = (await tx.query("UPDATE opportunity_tasks t SET assignee_id=$3,revision=t.revision+1,change_note=$4 FROM opportunities o WHERE o.tenant_id=t.tenant_id AND o.id=t.opportunity_id AND o.customer_id=$2 AND t.tenant_id=$1 AND t.status='open' RETURNING t.id", [actor.tenantId, id, data.ownerId, data.note])).rows;
            const actions = (await tx.query("UPDATE actions SET execution_actor_id=$3,status='draft',revision=revision+1,approved_revision=NULL,approved_by=NULL,resolution_note=$4,updated_at=now() WHERE tenant_id=$1 AND customer_id=$2 AND status IN ('draft','approved') RETURNING id,run_id,revision", [actor.tenantId, id, data.ownerId, data.note])).rows;
            for (const action of actions)
                await tx.query("INSERT INTO outbox(tenant_id,id,type,aggregate_id,payload) VALUES($1,$2,'action.reconciled',$3,$4)", [actor.tenantId, uid('evt'), action.run_id, JSON.stringify({ runId: action.run_id, revision: action.revision })]);
            await tx.query("UPDATE planning_runs SET execution_actor_id=$3 WHERE tenant_id=$1 AND customer_id=$2 AND action_id IS NULL AND status IN ('queued','planning')", [actor.tenantId, id, data.ownerId]);
            const row = (await tx.query('UPDATE customers SET owner_id=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2 RETURNING *', [actor.tenantId, id, data.ownerId])).rows[0]!;
            await this.audit(tx, actor, 'customer.handed_over', id, { from: before.ownerId, to: data.ownerId, note: data.note, opportunities: opportunities.map(o => o.id), tasks: tasks.map(t => t.id), actions: actions.map(a => a.id) });
            return mapped<Customer>(row);
        });
    }
    async reviewFact(ctx: Actor, id: string, input: z.input<typeof factReviewInput>): Promise<Fact> {
        const data = parse(factReviewInput, input);
        return this.scoped(ctx, async (tx, actor) => {
            this.writable(actor);
            const link = (await tx.query('SELECT customer_id FROM facts WHERE tenant_id=$1 AND id=$2', [actor.tenantId, id])).rows[0];
            if (!link) return fail('NOT_FOUND', 404, 'The fact does not exist or is outside your access scope.');
            await this.customer(tx, actor, link.customer_id);
            const row = (await tx.query('SELECT * FROM facts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [actor.tenantId, id])).rows[0];
            if (!row)
                return fail('NOT_FOUND', 404, "The fact does not exist or is outside your access scope.");
            await this.customer(tx, actor, row.customer_id);
            this.revision(row.revision, data.expectedRevision);
            if (row.status === data.status)
                fail('CONFLICT', 409, "This fact already has the requested review status.");
            const updated = (await tx.query('UPDATE facts SET status=$3,revision=revision+1,reviewed_by=$4,review_note=$5,reviewed_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [actor.tenantId, id, data.status, actor.memberId, data.note])).rows[0]!;
            await tx.query('INSERT INTO fact_reviews(tenant_id,id,fact_id,revision,from_status,to_status,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [actor.tenantId, uid('review'), id, updated.revision, row.status, data.status, data.note, actor.memberId]);
            await this.audit(tx, actor, 'fact.reviewed', id, { revision: updated.revision, fromStatus: row.status, toStatus: data.status, note: data.note });
            return mapped<Fact>(updated);
        });
    }
    async listFactReviews(ctx: Actor, id: string): Promise<FactReview[]> {
        return this.scoped(ctx, async (tx, actor) => {
            const fact = (await tx.query('SELECT customer_id FROM facts WHERE tenant_id=$1 AND id=$2', [actor.tenantId, id])).rows[0];
            if (!fact)
                return fail('NOT_FOUND', 404, "The fact does not exist or is outside your access scope.");
            await this.customer(tx, actor, fact.customer_id);
            return (await tx.query('SELECT r.*,m.name AS actor_name FROM fact_reviews r JOIN members m ON m.tenant_id=r.tenant_id AND m.id=r.actor_id WHERE r.tenant_id=$1 AND r.fact_id=$2 ORDER BY r.revision DESC', [actor.tenantId, id])).rows.map(r => mapped<FactReview>(r));
        });
    }
    private async run(tx: Connection, tenantId: string, id: string): Promise<ProductRun> {
        const row = (await tx.query(`${runSelect} WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId, id])).rows[0];
        return row ? mapped<ProductRun>(row) : fail('NOT_FOUND', 404, "Planning run not found.");
    }
    async listRuns(ctx: Actor, customerId: string): Promise<ProductRun[]> {
        return this.scoped(ctx, async (tx, actor) => {
            await this.customer(tx, actor, customerId);
            return (await tx.query(`${runSelect} WHERE r.tenant_id=$1 AND r.customer_id=$2 ORDER BY r.created_at DESC,r.id DESC`, [actor.tenantId, customerId])).rows.map(r => mapped<ProductRun>(r));
        });
    }
    async retryRun(ctx: Actor, id: string, input: z.input<typeof retryRunInput>): Promise<ProductRun> {
        const data = parse(retryRunInput, input);
        return this.scoped(ctx, async (tx, actor) => {
            this.writable(actor);
            const link = (await tx.query('SELECT customer_id FROM planning_runs WHERE tenant_id=$1 AND id=$2', [actor.tenantId, id])).rows[0];
            if (!link) return fail('NOT_FOUND', 404, 'Planning run not found.');
            await this.customer(tx, actor, link.customer_id);
            const row = (await tx.query('SELECT * FROM planning_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [actor.tenantId, id])).rows[0];
            if (!row)
                return fail('NOT_FOUND', 404, "Planning run not found.");
            await this.customer(tx, actor, row.customer_id);
            if (row.status !== 'failed' || row.action_id || (await tx.query('SELECT 1 FROM actions WHERE tenant_id=$1 AND run_id=$2', [actor.tenantId, id])).rowCount)
                fail('CONFLICT', 409, "Only failed planning runs without an action can be retried. Handle existing actions and uncertain delivery in action details.");
            const child = (await tx.query('SELECT id FROM planning_runs WHERE tenant_id=$1 AND parent_run_id=$2', [actor.tenantId, id])).rows[0];
            if (child)
                return this.run(tx, actor.tenantId, child.id);
            const models = (await tx.query("SELECT purpose FROM model_connections WHERE tenant_id=$1 AND enabled=true AND purpose IN ('reasoning','extraction') FOR SHARE", [actor.tenantId])).rows;
            if (new Set(models.map(m => m.purpose)).size !== 2)
                fail('MODEL_DISABLED', 409, "Enable both reasoning and extraction models before retrying planning.");
            const runId = uid('run');
            await tx.query('INSERT INTO planning_runs(tenant_id,id,customer_id,evidence_id,actor_id,parent_run_id,attempt,retry_reason,locale) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [actor.tenantId, runId, row.customer_id, row.evidence_id, actor.memberId, id, row.attempt + 1, data.reason, row.locale]);
            await tx.query("INSERT INTO outbox(tenant_id,id,type,aggregate_id,payload) VALUES($1,$2,'plan.requested',$3,$4)", [actor.tenantId, uid('evt'), runId, JSON.stringify({ runId })]);
            await this.audit(tx, actor, 'run.retried', runId, { parentRunId: id, attempt: row.attempt + 1, reason: data.reason });
            return this.run(tx, actor.tenantId, runId);
        });
    }
    async getWorkInbox(ctx: Actor): Promise<WorkInbox> {
        return this.scoped(ctx, async (tx, actor) => {
            const accessible = (await tx.query('SELECT id,name FROM customers WHERE tenant_id=$1 AND ($2 OR owner_id=$3) FOR SHARE', [actor.tenantId, elevated(actor), actor.memberId])).rows;
            const ids = accessible.map(c => c.id);
            const tasks = (await tx.query(`SELECT t.*,m.name AS assignee_name,o.title AS opportunity_title,o.customer_id FROM opportunity_tasks t
        JOIN opportunities o ON o.tenant_id=t.tenant_id AND o.id=t.opportunity_id
        JOIN members m ON m.tenant_id=t.tenant_id AND m.id=t.assignee_id
        WHERE t.tenant_id=$1 AND t.assignee_id=$2 AND t.status='open' AND o.customer_id=ANY($3::text[]) ORDER BY t.due_date,t.id`, [actor.tenantId, actor.memberId, ids])).rows.map(r => mapped<OpportunityTask & {
                opportunityTitle: string;
                customerId: string;
            }>(r));
            const actions: IntentAction[] = [];
            if (actor.role !== 'engineer') {
                const rows = (await tx.query("SELECT * FROM actions WHERE tenant_id=$1 AND customer_id=ANY($2::text[]) AND status IN ('draft','approved','unknown') ORDER BY updated_at DESC,id", [actor.tenantId, ids])).rows;
                actions.push(...await withActionReceipts(tx, actor.tenantId, rows.map(row => mapped<IntentAction>(row))));
            }
            const runs = (await tx.query(`${runSelect} WHERE r.tenant_id=$1 AND r.customer_id=ANY($2::text[]) AND r.status IN ('queued','planning','failed') AND NOT EXISTS(SELECT 1 FROM planning_runs s WHERE s.tenant_id=r.tenant_id AND s.parent_run_id=r.id) ORDER BY r.created_at DESC,r.id DESC`, [actor.tenantId, ids])).rows.map(r => mapped<ProductRun>(r));
            const advancements: WorkInbox['advancements'] = actor.role === 'engineer' ? [] : (await tx.query(`SELECT p.*,o.title AS opportunity_title FROM advancement_proposals p
        JOIN opportunities o ON o.tenant_id=p.tenant_id AND o.id=p.opportunity_id
        WHERE p.tenant_id=$1 AND p.customer_id=ANY($2::text[]) AND p.status='pending' AND ($3 OR o.owner_id=$4)
        ORDER BY p.created_at DESC,p.id DESC`, [actor.tenantId, ids, elevated(actor), actor.memberId])).rows.map(r => mapped<WorkInbox['advancements'][number]>(r));
            const facts: WorkInbox['facts'] = actor.role === 'engineer' ? [] : (await tx.query(
                "SELECT * FROM facts WHERE tenant_id=$1 AND customer_id=ANY($2::text[]) AND status='candidate' ORDER BY customer_id,id",
                [actor.tenantId, ids])).rows.map(row => mapped<WorkInbox['facts'][number]>(row));
            const referenced = new Set([...tasks, ...actions, ...runs, ...advancements, ...facts].map(item => item.customerId));
            return { asOf: new Date().toISOString(), tasks, actions, runs, advancements, facts, customers: accessible.filter(c => referenced.has(c.id)).map(c => ({ id: c.id, name: c.name })) };
        });
    }
    private async conversation(tx: Connection, actor: Actor, id: string, lock = false): Promise<Conversation> {
        const row = (await tx.query(`SELECT ${conversationColumns} FROM conversations WHERE tenant_id=$1 AND id=$2 AND member_id=$3${lock ? ' FOR UPDATE' : ''}`, [actor.tenantId, id, actor.memberId])).rows[0];
        if (!row)
            return fail('NOT_FOUND', 404, "The conversation does not exist or is outside your access scope.");
        await this.customer(tx, actor, row.customer_id);
        return mapped<Conversation>(row);
    }
    async createConversation(ctx: Actor, input: z.input<typeof conversationInput>): Promise<Conversation> {
        const data = parse(conversationInput, input);
        return this.scoped(ctx, async (tx, actor) => {
            await this.customer(tx, actor, data.customerId);
            const row = (await tx.query(`INSERT INTO conversations(tenant_id,id,customer_id,member_id,title) VALUES($1,$2,$3,$4,$5) RETURNING ${conversationColumns}`, [actor.tenantId, uid('conv'), data.customerId, actor.memberId, data.title])).rows[0]!;
            await this.audit(tx, actor, 'conversation.created', row.id, { customerId: data.customerId });
            return mapped<Conversation>(row);
        });
    }
    async listConversations(ctx: Actor, input: z.input<typeof conversationQuery>): Promise<ConversationPage> {
        const data = parse(conversationQuery, input);
        return this.scoped(ctx, async (tx, actor) => {
            if (data.customerId)
                await this.customer(tx, actor, data.customerId);
            let cursor: Conversation | null = null;
            if (data.cursor) {
                cursor = await this.conversation(tx, actor, data.cursor);
                if (data.customerId && cursor.customerId !== data.customerId)
                    fail('NOT_FOUND', 404, "The page cursor is outside the selected customer conversation scope.");
            }
            const rows = (await tx.query(`SELECT v.id,v.customer_id,v.title,v.created_at,v.updated_at FROM conversations v JOIN customers c ON c.tenant_id=v.tenant_id AND c.id=v.customer_id
        WHERE v.tenant_id=$1 AND v.member_id=$2 AND ($3 OR c.owner_id=$2) AND ($4::text IS NULL OR v.customer_id=$4)
        AND ($5::text IS NULL OR (v.updated_at,v.id)<(SELECT p.updated_at,p.id FROM conversations p WHERE p.tenant_id=$1 AND p.id=$5)) ORDER BY v.updated_at DESC,v.id DESC LIMIT 51`, [actor.tenantId, actor.memberId, elevated(actor), data.customerId ?? null, cursor?.id ?? null])).rows;
            const items = rows.slice(0, 50).map(r => mapped<Conversation>(r));
            return { items, nextCursor: rows.length > 50 ? items.at(-1)!.id : null };
        });
    }
    async getConversation(ctx: Actor, id: string, input: z.input<typeof conversationDetailQuery> = {}): Promise<ConversationDetail> {
        const data = parse(conversationDetailQuery, input);
        return this.scoped(ctx, async (tx, actor) => {
            const conversation = await this.conversation(tx, actor, id);
            let cursor: Record<string, unknown> | undefined;
            if (data.before) {
                cursor = (await tx.query('SELECT id,created_at FROM conversation_turns WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3', [actor.tenantId, id, data.before])).rows[0];
                if (!cursor)
                    fail('NOT_FOUND', 404, "The message cursor does not belong to this conversation.");
            }
            const rows = (await tx.query(`SELECT ${turnColumns} FROM conversation_turns WHERE tenant_id=$1 AND conversation_id=$2 AND ($3::text IS NULL OR (created_at,id)<(SELECT p.created_at,p.id FROM conversation_turns p WHERE p.tenant_id=$1 AND p.conversation_id=$2 AND p.id=$3)) ORDER BY created_at DESC,id DESC LIMIT 51`, [actor.tenantId, id, cursor?.id ?? null])).rows;
            const turns = rows.slice(0, 50).reverse().map(r => mapped<ChatTurn>(r));
            return { conversation, turns, olderCursor: rows.length > 50 ? turns[0]!.id : null };
        });
    }
    async getTurnByRequest(ctx: Actor, id: string, requestId: string): Promise<ChatTurn | null> {
        const request = parse(conversationMessageInput.shape.requestId, requestId);
        return this.scoped(ctx, async (tx, actor) => {
            await this.conversation(tx, actor, id);
            const row = (await tx.query(`SELECT ${turnColumns} FROM conversation_turns WHERE tenant_id=$1 AND conversation_id=$2 AND request_id=$3`, [actor.tenantId, id, request])).rows[0];
            return row ? mapped<ChatTurn>(row) : null;
        });
    }
    private async validateReply(tx: Connection, actor: Actor, customerId: string, reply: ChatReply) {
        const evidence = (await tx.query('SELECT id,title,body FROM evidence WHERE tenant_id=$1 AND customer_id=$2', [actor.tenantId, customerId])).rows;
        for (const source of reply.sources) {
            const record = evidence.find(e => e.id === source.id);
            if (!record || record.title !== source.title || !record.body.includes(source.quote))
                fail('VALIDATION', 400, "The answer cites evidence outside this customer or quotes text not found in the source.");
        }
        const customerPath = `/customers/${encodeURIComponent(customerId)}`;
        const allowed = new Set([customerPath, `${customerPath}?focus=fields`, `${customerPath}?focus=facts`, `${customerPath}?focus=runs`]);
        const actions = (await tx.query('SELECT id FROM actions WHERE tenant_id=$1 AND customer_id=$2', [actor.tenantId, customerId])).rows;
        for (const action of actions)
            allowed.add(`${customerPath}?action=${encodeURIComponent(action.id)}`);
        const opportunities = (await tx.query('SELECT id FROM opportunities WHERE tenant_id=$1 AND customer_id=$2', [actor.tenantId, customerId])).rows;
        for (const opportunity of opportunities) {
            const path = `/opportunities/${encodeURIComponent(opportunity.id)}`;
            allowed.add(path);
            allowed.add(`${path}?tab=finance`);
            allowed.add(`${path}?tab=tasks`);
            allowed.add(`${path}?focus=advance`);
        }
        if (reply.cards.some(card => !allowed.has(card.href)))
            fail('VALIDATION', 400, "The answer contains an unauthorized page link.");
    }
    async saveTurn(ctx: Actor, id: string, input: z.input<typeof conversationMessageInput>, rawReply: ChatReply): Promise<ChatTurn> {
        const data = parse(conversationMessageInput, input);
        return this.scoped(ctx, async (tx, actor) => {
            const conversation = await this.conversation(tx, actor, id, true);
            const existing = (await tx.query(`SELECT ${turnColumns} FROM conversation_turns WHERE tenant_id=$1 AND conversation_id=$2 AND request_id=$3`, [actor.tenantId, id, data.requestId])).rows[0];
            if (existing) {
                if (existing.message !== data.message)
                    fail('CONFLICT', 409, "This request ID has already been used for a different message.");
                return mapped<ChatTurn>(existing);
            }
            const reply = parse(replySchema, rawReply);
            await this.validateReply(tx, actor, conversation.customerId, reply);
            const row = (await tx.query(`INSERT INTO conversation_turns(tenant_id,id,conversation_id,request_id,message,reply) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${turnColumns}`, [actor.tenantId, uid('turn'), id, data.requestId, data.message, JSON.stringify(reply)])).rows[0]!;
            await tx.query('UPDATE conversations SET updated_at=now() WHERE tenant_id=$1 AND id=$2', [actor.tenantId, id]);
            await this.audit(tx, actor, 'conversation.turn.saved', row.id, { conversationId: id, requestId: data.requestId });
            return mapped<ChatTurn>(row);
        });
    }
}
