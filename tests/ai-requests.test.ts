import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { AiRequestService, DomainError } from '../packages/domain/src/index.js';
import type { Actor } from '../packages/contracts/src/index.js';
import { createApi } from '../apps/api/src/index.js';
import { FixtureModel } from '../packages/harness/src/index.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

test('AI admission is durable, tenant-scoped, bounded, and recoverable', { skip: !process.env.DATABASE_URL }, async t => {
    const db = createDatabase(process.env.DATABASE_URL!);
    const first = new AiRequestService(db), second = new AiRequestService(db);
    const tenantId = `ai_${randomUUID()}`;
    const actor: Actor = { tenantId, memberId: 'member', role: 'admin', authorizationVersion: 1 };
    const foreign: Actor = { ...actor, tenantId: `${tenantId}_other` };
    const reset = () => db.query('DELETE FROM ai_requests WHERE tenant_id=$1', [tenantId]);
    try {
        await migrate(db);
        for (const workspace of [actor, foreign]) {
            await db.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [workspace.tenantId, 'AI admission acceptance']);
            await db.query("INSERT INTO members(tenant_id,id,name,email,role) VALUES($1,'member','Owner','owner@example.test','admin')", [workspace.tenantId]);
        }
        await t.test('a second service cannot duplicate an in-flight request or monopolize member capacity', async () => {
            const started = deferred(), release = deferred(), otherStarted = deferred();
            const running = first.run(actor, 'private-request', async () => { started.resolve(); await release.promise; return 'saved'; });
            await started.promise;
            try {
                await assert.rejects(second.run(actor, 'private-request', async () => assert.fail('duplicate inference')), code('AI_REQUEST_IN_PROGRESS'));
                assert.equal(await second.run(foreign, 'private-request', async () => 'isolated'), 'isolated');
                const other = second.run(actor, 'another-request', async () => { otherStarted.resolve(); await release.promise; });
                await otherStarted.promise;
                await assert.rejects(first.run(actor, 'third', async () => assert.fail('over capacity')), code('AI_CAPACITY_REACHED'));
                const stored = JSON.stringify((await db.query('SELECT * FROM ai_requests WHERE tenant_id=$1', [tenantId])).rows);
                assert.ok(!stored.includes('private-request'));
                release.resolve();
                await other;
            } finally { release.resolve(); await running; }
            assert.equal(await first.run(actor, 'private-request', async () => 'available again'), 'available again');
        });
        await t.test('provider failure and expired process leases release capacity without accepting stale authority', async () => {
            await reset();
            await assert.rejects(first.run(actor, 'failed', async () => { throw new Error('provider failed'); }), /provider failed/);
            assert.equal(await second.run(actor, 'failed', async () => 'recovered'), 'recovered');
            await db.query("UPDATE ai_requests SET finished_at=NULL,expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=(SELECT id FROM ai_requests WHERE tenant_id=$1 LIMIT 1)", [tenantId]);
            assert.equal(await second.run(actor, 'failed', async () => 'after restart'), 'after restart');
            await assert.rejects(first.run({ ...actor, authorizationVersion: 2 }, 'stale', async () => assert.fail('stale authority')), code('UNAUTHENTICATED'));
        });
        await t.test('rolling request limits include completed and failed requests', async () => {
            await reset();
            for (let n = 0; n < 20; n++) await first.run(actor, `request-${n}`, async () => n);
            await assert.rejects(second.run(actor, 'too-many', async () => assert.fail('burst exceeded')), code('AI_CAPACITY_REACHED'));
            await db.query("UPDATE ai_requests SET started_at=now()-interval '61 seconds' WHERE tenant_id=$1", [tenantId]);
            assert.equal(await second.run(actor, 'next-window', async () => true), true);
        });
    } finally {
        for (const id of [tenantId, foreign.tenantId]) {
            await db.query('DELETE FROM ai_requests WHERE tenant_id=$1', [id]);
            await db.query('DELETE FROM members WHERE tenant_id=$1', [id]);
            await db.query('DELETE FROM tenants WHERE id=$1', [id]);
        }
        await db.close();
    }
});

test('HTTP duplicate conversation requests invoke the model once and replay the stored result', { skip: !process.env.DATABASE_URL }, async () => {
    const keys = ['NODE_ENV', 'INTENT_AUTH_MODE', 'INTENT_PUBLIC_ORIGIN'] as const;
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { NODE_ENV: 'test', INTENT_AUTH_MODE: 'password', INTENT_PUBLIC_ORIGIN: 'http://localhost:5173' });
    const server = await createApi();
    const originalReply = FixtureModel.prototype.reply;
    const entered = deferred(), release = deferred();
    let calls = 0;
    const tenantId = `ai_http_${randomUUID()}`, password = randomUUID() + randomUUID();
    try {
        await migrate(server.db);
        await server.identity.bootstrapWorkspace({ workspaceId: tenantId, workspaceName: 'AI request acceptance', adminName: 'Owner', email: 'owner@example.test', password });
        await server.app.listen(0, '127.0.0.1');
        const base = await server.app.getUrl();
        let cookie = '';
        const request = async (path: string, body: unknown) => {
            const response = await fetch(`${base}/api${path}`, { method: 'POST', headers: { cookie, origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify(body) });
            return { status: response.status, headers: response.headers, data: await response.json() };
        };
        const login = await request('/auth/login', { workspaceId: tenantId, email: 'owner@example.test', password });
        cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        const customer = (await request('/customers', { name: 'Acme', industry: 'Services', contact: 'Buyer', email: 'buyer@example.test', ownerId: login.data.user.id })).data;
        const conversation = (await request('/conversations', { customerId: customer.id, title: 'Requirements' })).data;
        FixtureModel.prototype.reply = (async function (this: FixtureModel, ...args: Parameters<typeof originalReply>) { calls++; entered.resolve(); await release.promise; return originalReply.apply(this, args); }) as unknown as typeof originalReply;
        const input = { requestId: randomUUID(), message: 'What should I do next?' };
        const first = request(`/conversations/${conversation.id}/messages`, input);
        await entered.promise;
        const duplicate = await request(`/conversations/${conversation.id}/messages`, input);
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.data.code, 'AI_REQUEST_IN_PROGRESS');
        const competing = await request(`/conversations/${conversation.id}/messages`, { requestId: randomUUID(), message: 'A second question in the same conversation' });
        assert.equal(competing.status, 409);
        assert.equal(competing.data.code, 'AI_REQUEST_IN_PROGRESS');
        release.resolve();
        const saved = await first;
        assert.equal(saved.status, 201);
        const replay = await request(`/conversations/${conversation.id}/messages`, input);
        assert.equal(replay.data.id, saved.data.id);
        assert.equal(calls, 1);
        assert.equal((await request(`/conversations/${conversation.id}/messages`, { ...input, message: 'Different message' })).status, 409);
        await server.db.query(`INSERT INTO ai_requests(tenant_id,id,member_id,request_key,finished_at)
            SELECT $1,gen_random_uuid(),$2,'limit-'||i,now() FROM generate_series(1,20) i`, [tenantId, login.data.user.id]);
        const limited = await request('/chat', { customerId: customer.id, message: 'A further request' });
        assert.equal(limited.status, 429);
        assert.equal(limited.headers.get('retry-after'), '60');
        assert.equal(calls, 1);
    } finally {
        release.resolve();
        FixtureModel.prototype.reply = originalReply;
        await server.app.close(); await server.db.close();
        for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    }
});
