import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed } from '../packages/database/src/seed.js';

test('management HTTP loop: scoped forecast, intervention, contract and idempotent collection', { skip: !process.env.DATABASE_URL }, async () => {
  const previous = { auth: process.env.INTENT_DEV_AUTH, mode: process.env.NODE_ENV };
  process.env.INTENT_DEV_AUTH = 'true'; process.env.NODE_ENV = 'test';
  const { app, db } = await createApi();
  try {
    await migrate(db); await seed(db); await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function request(path: string, method = 'GET', body?: unknown, token?: string, expected = 200) {
      const response = await fetch(`${base}/api${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json();
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    }
    const admin = (await request('/dev/session', 'POST', {}, undefined, 201)).token;
    const sales = (await request('/dev/session', 'POST', { memberId: 'usr_zhaoshan' }, undefined, 201)).token;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const period = today.slice(0, 7);
    const next = new Date(`${period}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
    const nextMonthDate = next.toISOString().slice(0, 10);
    const path = `/management/overview?period=${period}&ownerId=usr_zhaoshan`;
    await request(path, 'GET', undefined, sales, 403);
    await request(`${path}&tenantId=tenant_isolation`, 'GET', undefined, admin, 400);
    await request('/opportunities?customerId=cus_isolation', 'GET', undefined, admin, 404);
    const before = await request(path, 'GET', undefined, admin);
    const input = { title: `HTTP 验收商机 ${randomUUID()}`, customerId: 'cus_lanhai', ownerId: 'usr_zhaoshan', amountCents: 1_000_000, expectedCloseDate: today, stage: 'proposal', forecastCategory: 'commit', nextStep: '确认采购计划', nextStepDueDate: today, evidenceId: null, lostReason: null };
    await request('/opportunities', 'POST', { ...input, expectedCloseDate: '0000-01-01' }, sales, 400);
    await request('/opportunities', 'POST', { ...input, expectedCloseDate: '2026-02-30' }, sales, 400);
    const opportunity = await request('/opportunities', 'POST', input, sales, 201);
    await request(`/opportunities/${opportunity.id}`, 'PATCH', { ...input, stage: 'won', expectedRevision: 1, note: '不能绕过合同登记' }, admin, 400);
    await request(`/opportunities/${opportunity.id}`, 'PATCH', { ...input, expectedRevision: 99, note: '旧版本不得覆盖' }, admin, 409);
    const target = await request('/management/targets', 'POST', { period, ownerId: 'usr_zhaoshan', bookingsTargetCents: 50_000_000, collectionTargetCents: 20_000_000, expectedRevision: before.target?.revision ?? 0 }, admin, 201);
    await request('/management/targets', 'POST', { period, ownerId: 'usr_zhaoshan', bookingsTargetCents: 50_000_000, collectionTargetCents: 20_000_000, expectedRevision: target.revision - 1 }, admin, 409);
    const snapshot = await request('/management/snapshots', 'POST', { period, ownerId: 'usr_zhaoshan' }, admin, 201);
    assert.equal(snapshot.metrics.forecastCents, before.metrics.forecastCents + input.amountCents);
    await request(`/opportunities/${opportunity.id}`, 'PATCH', { ...input, expectedCloseDate: nextMonthDate, expectedRevision: 1, note: '采购时间移至下月' }, sales);
    const slipped = await request(path, 'GET', undefined, admin);
    assert.equal(slipped.snapshotDeltaCents, -input.amountCents);
    const moved = slipped.snapshotChanges.find((change: { opportunityId: string }) => change.opportunityId === opportunity.id);
    assert.equal(moved.kind, 'removed'); assert.equal(moved.after.expectedCloseDate, nextMonthDate);
    const task = await request(`/opportunities/${opportunity.id}/tasks`, 'POST', { title: '确认延期原因并记录客户回复', assigneeId: 'usr_zhaoshan', dueDate: today }, admin, 201);
    await request(`/opportunity-tasks/${task.id}/complete`, 'POST', { expectedRevision: 1, completionNote: '已确认采购排期；客户尚未签约' }, sales, 201);
    const intervened = await request(`/opportunities/${opportunity.id}`, 'GET', undefined, sales);
    assert.equal(intervened.opportunity.stage, 'proposal'); assert.equal(intervened.tasks[0].status, 'completed');
    assert.equal(intervened.history.length, 2); assert.equal(intervened.history.find((h: { revision: number }) => h.revision === 2).before.expectedCloseDate, today);
    const contract = { expectedRevision: 2, amountCents: 1_234_500, signedDate: today, reference: `HTTP-CONTRACT-${randomUUID()}`, installments: [{ dueDate: today, amountCents: 800_000 }, { dueDate: nextMonthDate, amountCents: 434_500 }] };
    await request(`/opportunities/${opportunity.id}/contract`, 'POST', contract, sales, 403);
    await request(`/opportunities/${opportunity.id}/contract`, 'POST', { ...contract, amountCents: 1_234_501 }, admin, 400);
    const signed = await request(`/opportunities/${opportunity.id}/contract`, 'POST', contract, admin, 201);
    assert.equal(signed.opportunity.stage, 'won'); assert.equal(signed.opportunity.amountCents, contract.amountCents);
    const due = signed.receivables.find((item: { dueDate: string }) => item.dueDate === today);
    const payment = { amountCents: 300_000, paidDate: today, reference: `HTTP-PAYMENT-${randomUUID()}` };
    const paid = await request(`/receivables/${due.id}/payments`, 'POST', payment, admin, 201);
    const replay = await request(`/receivables/${due.id}/payments`, 'POST', payment, admin, 201);
    assert.equal(replay.id, paid.id);
    await request(`/receivables/${due.id}/payments`, 'POST', { ...payment, amountCents: 1 }, admin, 409);
    await request(`/receivables/${due.id}/payments`, 'POST', { ...payment, reference: `OVERPAY-${randomUUID()}`, amountCents: 500_001 }, admin, 409);
    const after = await request(path, 'GET', undefined, admin);
    assert.equal(after.metrics.bookedCents - before.metrics.bookedCents, contract.amountCents);
    assert.equal(after.metrics.collectedCents - before.metrics.collectedCents, payment.amountCents);
    assert.equal(after.metrics.dueCents - before.metrics.dueCents, 800_000);
    assert.equal(after.receivables.find((item: { id: string }) => item.id === due.id).remainingCents, 500_000);
    assert.equal(after.metrics.forecastCents - before.metrics.forecastCents, contract.amountCents);
    const snapshots = await request(`/management/snapshots?period=${period}&ownerId=usr_zhaoshan`, 'GET', undefined, admin);
    assert.deepEqual(snapshots.find((item: { id: string }) => item.id === snapshot.id), snapshot);
  } finally {
    await app.close(); await db.close();
    for (const [key, value] of [['INTENT_DEV_AUTH', previous.auth], ['NODE_ENV', previous.mode]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
