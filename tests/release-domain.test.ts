import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Database, type Connection } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { IntentService, ProductService, ModelSettingsService, DeliveryService, DomainError } from '../packages/domain/src/index.js';
import { IdentityService } from '../packages/domain/src/identity.js';
import { FixtureModel } from '../packages/harness/src/index.js';
import type { Actor } from '../packages/contracts/src/index.js';

class MeasuredDatabase extends Database {
    queries = 0;
    override transaction<T>(work: (connection: Connection) => Promise<T>): Promise<T> {
        return super.transaction(tx => work({ query: new Proxy(tx.query, {
            apply: (target, _self, args) => { this.queries++; return Reflect.apply(target, tx, args); },
        }) }));
    }
}

test('large action reads use bounded query counts and preserve receipts and tenant scope', { skip: !process.env.DATABASE_URL }, async t => {
    const db = new MeasuredDatabase(process.env.DATABASE_URL!);
    const tenantId = `volume_${randomUUID()}`, foreignId = `${tenantId}_other`;
    const actor: Actor = { tenantId, memberId: 'sales', role: 'sales' };
    const service = new IntentService(db), product = new ProductService(db);
    const count = 1000;
    try {
        await migrate(db);
        for (const tenant of [tenantId, foreignId]) {
            await db.query('INSERT INTO tenants(id,name) VALUES($1,$1)', [tenant]);
            await db.query("INSERT INTO members(tenant_id,id,name,email,role) VALUES($1,'sales','Sales','sales@example.test','sales'),($1,'other','Other','other@example.test','sales')", [tenant]);
            await db.query("INSERT INTO customers(tenant_id,id,name,industry,contact,email,owner_id) VALUES($1,'visible','Visible','Services','Buyer','buyer@example.test','sales'),($1,'hidden','Hidden','Services','Private','private@example.test','other')", [tenant]);
            await db.query("INSERT INTO evidence(tenant_id,id,customer_id,kind,title,body,source_digest) VALUES($1,'source','visible','meeting','Source','Customer requested an implementation timeline.',repeat('a',64)),($1,'private','hidden','meeting','Private source','Private customer evidence.',repeat('b',64))", [tenant]);
            await db.query("INSERT INTO planning_runs(tenant_id,id,customer_id,evidence_id,actor_id,status) SELECT $1,'run_'||i,'visible','source','sales','waiting_approval' FROM generate_series(1,$2) i", [tenant, tenant === tenantId ? count : 1]);
            await db.query("INSERT INTO actions(tenant_id,id,customer_id,run_id,status,recipient,subject,body,operation_id) SELECT $1,'action_'||i,'visible','run_'||i,CASE WHEN i%2=0 THEN 'succeeded' ELSE 'draft' END,'buyer@example.test','Follow up','Preserved source and message',$1||'_operation_'||i FROM generate_series(1,$2) i", [tenant, tenant === tenantId ? count : 1]);
            if (tenant === foreignId) await db.query("UPDATE actions SET status='succeeded' WHERE tenant_id=$1", [tenant]);
            await db.query("INSERT INTO receipts(tenant_id,id,action_id,operation_id,reference,simulated) SELECT tenant_id,'receipt_'||id,id,operation_id,'Verified '||operation_id,false FROM actions WHERE tenant_id=$1 AND status='succeeded'", [tenant]);
            await db.query("INSERT INTO planning_runs(tenant_id,id,customer_id,evidence_id,actor_id) VALUES($1,'private-run','hidden','private','other')", [tenant]);
            await db.query("INSERT INTO actions(tenant_id,id,customer_id,run_id,recipient,subject,body,operation_id) VALUES($1,'private-action','hidden','private-run','private@example.test','Private subject','Private body',$1||'_private-operation')", [tenant]);
        }
        for (const [name, read] of [
            ['Action center', () => service.listActions(actor)],
            ['Customer context', async () => (await service.getCustomer(actor, 'visible')).actions],
            ['Work inbox', async () => (await product.getWorkInbox(actor)).actions],
        ] as const) {
            db.queries = 0;
            const started = performance.now(), actions = await read(), elapsed = performance.now() - started;
            assert.equal(actions.length, name === 'Work inbox' ? count / 2 : count);
            assert.ok(db.queries <= 10, `${name} issued ${db.queries} queries`);
            assert.ok(actions.every(action => action.customerId === 'visible'));
            for (const action of actions) {
                if (action.status === 'draft') { assert.equal(action.receipt, null); continue; }
                assert.equal(action.receipt?.operationId, action.operationId);
                assert.equal(action.receipt?.reference, `Verified ${tenantId}_operation_${action.id.slice('action_'.length)}`);
                assert.ok(action.receipt?.recordedAt.endsWith('Z'));
                assert.equal(action.receipt?.simulated, false);
            }
            t.diagnostic(`${name}: ${actions.length} records, ${db.queries} queries, ${elapsed.toFixed(1)} ms (local measurement, not a production SLO).`);
        }
    } finally {
        for (const tenant of [tenantId, foreignId]) for (const table of ['receipts', 'actions', 'planning_runs', 'evidence', 'customers', 'members', 'tenants'])
            await db.query(`DELETE FROM ${table} WHERE ${table === 'tenants' ? 'id' : 'tenant_id'}=$1`, [tenant]);
        await db.close();
    }
});

test('removing an allowed host revokes existing model use and invalidates delivery before dispatch', { skip: !process.env.DATABASE_URL }, async () => {
    const keys = ['INTENT_ENCRYPTION_KEY', 'INTENT_MODEL_ALLOWED_HOSTS', 'INTENT_DELIVERY_ALLOWED_HOSTS'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { INTENT_ENCRYPTION_KEY: randomBytes(32).toString('base64'), INTENT_MODEL_ALLOWED_HOSTS: 'models.example.test', INTENT_DELIVERY_ALLOWED_HOSTS: 'gateway.example.test' });
    const db = new Database(process.env.DATABASE_URL!);
    const tenantId = `policy_${randomUUID()}`;
    try {
        await migrate(db);
        const root = await new IdentityService(db).bootstrapWorkspace({ workspaceId: tenantId, workspaceName: 'Endpoint policy acceptance', adminName: 'Owner', email: 'owner@example.test', password: randomUUID() + randomUUID() });
        const actor: Actor = { tenantId, memberId: root.memberId, role: 'admin' };
        const service = new IntentService(db), product = new ProductService(db), settings = new ModelSettingsService(db);
        await new DeliveryService(db).save(actor, { expectedRevision: 0, mode: 'webhook', endpoint: 'https://gateway.example.test/send', sender: 'sender@example.test', apiKey: 'test-only-gateway-key', webhookSecret: randomBytes(32).toString('hex') });
        const customer = await product.createCustomer(actor, { name: 'Release acceptance customer', industry: 'Services', contact: 'Buyer', email: 'buyer@example.test', ownerId: actor.memberId });
        const source = await service.addEvidence(actor, customer.id, { title: 'Customer request', body: 'The customer requested an implementation timeline for review.' });
        const action = await service.acceptPlan(tenantId, source.runId, await new FixtureModel().plan(await service.getPlanningContext(tenantId, source.runId)));
        await service.approveAction(actor, action.id, { expectedRevision: action.revision });
        process.env.INTENT_DELIVERY_ALLOWED_HOSTS = '';
        let dispatches = 0;
        assert.equal(await service.executeAction(tenantId, source.runId, action.revision, async () => { dispatches++; return { outcome: 'delivered', reference: 'must-not-send' }; }), 'waiting_approval');
        assert.equal(dispatches, 0);
        const invalidated = (await service.getCustomer(actor, customer.id)).actions[0]!;
        assert.equal(invalidated.status, 'draft');
        assert.equal(invalidated.approvedBy, null);
        assert.equal((await db.query('SELECT 1 FROM dispatch_attempts WHERE tenant_id=$1', [tenantId])).rowCount, 0);
        process.env.INTENT_DELIVERY_ALLOWED_HOSTS = 'gateway.example.test';
        await service.approveAction(actor, action.id, { expectedRevision: invalidated.revision });
        assert.equal(await service.executeAction(tenantId, source.runId, invalidated.revision, async () => { dispatches++; return { outcome: 'delivered', reference: 'local-stub-receipt' }; }), 'succeeded');
        assert.equal(dispatches, 1);
        const model = await settings.save(actor, { name: 'Custom provider', provider: 'openai-compatible', model: 'compatible-model', purpose: 'reasoning', baseUrl: 'https://models.example.test/v1', apiKey: 'test-only-model-key' });
        await settings.recordTest(actor, model.id, model.revision!, null);
        await service.updateModel(actor, model.id, { enabled: true, expectedRevision: model.revision! });
        const enabled = await settings.forActor(actor);
        process.env.INTENT_MODEL_ALLOWED_HOSTS = '';
        const rejected = (error: unknown) => error instanceof DomainError && error.code === 'ENDPOINT_NOT_ALLOWED';
        await assert.rejects(settings.forActor(actor), rejected);
        await assert.rejects(settings.forTest(actor, model.id, enabled.connection.revision!), rejected);
        await assert.rejects(settings.runtime(tenantId, model.id), rejected);
        process.env.INTENT_MODEL_ALLOWED_HOSTS = 'models.example.test';
        assert.equal((await settings.forActor(actor)).connection.id, model.id);
    } finally {
        await db.close();
        for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    }
});
