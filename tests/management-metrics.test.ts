import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ForecastItem, ForecastSnapshot, ManagementData, Opportunity, OpportunityTask,
  PaymentRecord, Receivable, SalesContract, SalesTarget,
} from '../packages/contracts/src/management.js';
import { calculateManagementOverview } from '../packages/domain/src/management-metrics.js';

const now = '2026-10-28T04:00:00.000Z';
const opts = {period: '2026-10', asOfDate: '2026-10-28', generatedAt: now, target: null, latestSnapshot: null};
const member = (id: string) => ({id, name: `销售 ${id}`, email: `${id}@example.test`, role: 'sales' as const, active: true, revision: 1});
const data = (overrides: Partial<ManagementData> = {}): ManagementData => ({
  opportunities: [], contracts: [], receivables: [], payments: [], tasks: [], members: [member('a'), member('b')], ...overrides,
});
function opportunity(id: string, overrides: Partial<Opportunity> = {}): Opportunity {
  return {id, title: `商机 ${id}`, customerId: 'customer', customerName: '客户', ownerId: 'a', ownerName: '销售 a',
    amountCents: 10_000, expectedCloseDate: '2026-10-31', stage: 'proposal', forecastCategory: 'pipeline',
    nextStep: '确认采购计划', nextStepDueDate: '2026-10-30', evidenceId: 'evidence', lostReason: null,
    currency: 'CNY', revision: 1, stageEnteredAt: '2026-10-20T00:00:00.000Z', closedDate: null, createdAt: now, updatedAt: now, ...overrides};
}
function contract(id: string, opportunityId: string, overrides: Partial<SalesContract> = {}): SalesContract {
  return {id, opportunityId, customerId: 'customer', ownerId: 'a', amountCents: 10_000, currency: 'CNY',
    signedDate: '2026-10-10', reference: `contract-${id}`, createdAt: now, ...overrides};
}
function receivable(id: string, contractId: string, opportunityId: string, overrides: Partial<Receivable> = {}): Receivable {
  return {id, contractId, opportunityId, ownerId: 'a', dueDate: '2026-10-31', amountCents: 10_000,
    paidCents: 0, remainingCents: 10_000, ...overrides};
}
function payment(id: string, r: Receivable, amountCents: number, paidDate: string): PaymentRecord {
  return {id, receivableId: r.id, contractId: r.contractId, opportunityId: r.opportunityId,
    ownerId: r.ownerId, amountCents, paidDate, reference: `payment-${id}`, createdAt: now};
}
function task(id: string, opportunityId: string, overrides: Partial<OpportunityTask> = {}): OpportunityTask {
  return {id, opportunityId, title: '协调方案评审', assigneeId: 'a', assigneeName: '销售 a', dueDate: '2026-10-27',
    status: 'open', completionNote: null, revision: 1, createdAt: now, completedAt: null, ...overrides};
}
function item(value: Opportunity): ForecastItem {
  const {id, title, customerName, amountCents, stage, forecastCategory, expectedCloseDate, ownerId} = value;
  return {id, title, customerName, amountCents, stage, forecastCategory, expectedCloseDate, ownerId};
}
function target(overrides: Partial<SalesTarget> = {}): SalesTarget {
  return {period: '2026-10', ownerId: null, bookingsTargetCents: 400_000, collectionTargetCents: 100_000, revision: 1, updatedAt: now, ...overrides};
}

test('monthly bookings, cash flow, installment collections and cross-period arrears remain distinct', () => {
  const old = opportunity('old', {stage: 'won', closedDate: '2026-09-10', ownerId: 'b', amountCents: 100_000});
  const won = opportunity('won', {stage: 'won', closedDate: '2026-10-10', ownerId: 'b', amountCents: 200_000});
  const r1 = receivable('september', 'old-contract', old.id, {dueDate: '2026-09-30', amountCents: 40_000});
  const r2 = receivable('october-old', 'old-contract', old.id, {amountCents: 60_000});
  const r3 = receivable('october-new', 'new-contract', won.id, {dueDate: '2026-10-20', amountCents: 100_000});
  const r4 = receivable('november', 'new-contract', won.id, {dueDate: '2026-11-20', amountCents: 100_000});
  const result = calculateManagementOverview(data({
    opportunities: [old, won,
      opportunity('commit', {amountCents: 30_000, forecastCategory: 'commit', stage: 'negotiation'}),
      opportunity('best', {amountCents: 40_000, forecastCategory: 'best_case'}),
      opportunity('pipeline', {amountCents: 50_000, forecastCategory: 'pipeline', stage: 'qualified'}),
      opportunity('excluded', {amountCents: 60_000, forecastCategory: 'excluded', stage: 'discovery'}),
      opportunity('next-month', {amountCents: 70_000, forecastCategory: 'commit', expectedCloseDate: '2026-11-15'}),
      opportunity('lost', {amountCents: 80_000, stage: 'lost', closedDate: '2026-10-15', lostReason: '预算取消'})],
    contracts: [contract('old-contract', old.id, {amountCents: 100_000, signedDate: '2026-09-10'}), contract('new-contract', won.id, {amountCents: 200_000})],
    receivables: [r1, r2, r3, r4],
    payments: [payment('p1', r1, 15_000, '2026-09-15'), payment('p2', r1, 5_000, '2026-10-05'),
      payment('p3', r2, 20_000, '2026-09-25'), payment('p4', r2, 10_000, '2026-10-15'),
      payment('p5', r3, 40_000, '2026-10-20'), payment('p6', r4, 25_000, '2026-10-25')],
  }), {...opts, target: target()});

  assert.deepEqual(result.metrics, {
    bookedCents: 200_000, collectedCents: 80_000, dueCents: 160_000, dueCollectedCents: 70_000, overdueCents: 80_000,
    commitCents: 30_000, bestCaseCents: 40_000, pipelineCents: 50_000, forecastCents: 230_000, upsideCents: 270_000,
    bookingAttainment: 0.5, collectionAttainment: 0.8, forecastGapCents: 170_000,
    openCount: 4, wonCount: 1, lostCount: 1, winRate: 0.5,
  });
  assert.deepEqual(result.receivables.map(r => [r.id, r.paidCents, r.remainingCents]), [
    ['september', 20_000, 20_000], ['october-new', 40_000, 60_000], ['october-old', 30_000, 30_000],
  ]);
  assert.deepEqual(result.stages.map(s => [s.stage, s.count, s.amountCents]), [
    ['discovery', 1, 60_000], ['qualified', 1, 50_000], ['proposal', 1, 40_000], ['negotiation', 1, 30_000],
  ]);
  assert.deepEqual(result.owners, [{ownerId: 'a', name: '销售 a', bookedCents: 200_000, openCents: 180_000, commitCents: 30_000, atRiskCents: 0, openCount: 4}]);
});

test('contract and payment credit stay with the historical owner after the current opportunity owner changes', () => {
  const won = opportunity('won', {stage: 'won', ownerId: 'b', ownerName: '销售 b', closedDate: '2026-10-10'});
  const r = receivable('r', 'c', won.id, {dueDate: '2026-10-20'});
  const source = data({opportunities: [won, opportunity('new', {ownerId: 'b', forecastCategory: 'commit'})],
    contracts: [contract('c', won.id)], receivables: [r], payments: [payment('p', r, 4_000, '2026-10-21')],
    members: [{...member('a'), active: false}, member('b')]});
  const a = calculateManagementOverview(source, {...opts, ownerId: 'a'});
  const b = calculateManagementOverview(source, {...opts, ownerId: 'b'});
  assert.equal(a.metrics.bookedCents, 10_000);
  assert.equal(a.metrics.collectedCents, 4_000);
  assert.equal(a.metrics.overdueCents, 6_000);
  assert.equal(a.metrics.wonCount, 1);
  assert.equal(a.metrics.openCount, 0);
  assert.equal(b.metrics.bookedCents, 0);
  assert.equal(b.metrics.collectedCents, 0);
  assert.equal(b.metrics.wonCount, 0);
  assert.equal(b.metrics.commitCents, 10_000);
  assert.equal(b.receivables.length, 0);
});

test('as-of cutoff recalculates partial payment balance and includes future installments of signed contracts', () => {
  const won = opportunity('won', {stage: 'won', closedDate: '2026-10-10'});
  const r = receivable('r', 'c', won.id, {dueDate: '2026-10-31', paidCents: 8_000, remainingCents: 2_000});
  const source = data({opportunities: [won], contracts: [contract('c', won.id)], receivables: [r],
    payments: [payment('early', r, 3_000, '2026-10-15'), payment('later', r, 5_000, '2026-10-30')]});
  const result = calculateManagementOverview(source, opts);
  assert.equal(result.metrics.collectedCents, 3_000);
  assert.equal(result.metrics.dueCents, 10_000);
  assert.equal(result.metrics.dueCollectedCents, 3_000);
  assert.equal(result.metrics.overdueCents, 0);
  assert.equal(result.receivables[0]!.remainingCents, 7_000);
  assert.equal(source.receivables[0]!.paidCents, 8_000);
});

test('cross-month and year boundaries use calendar dates, not string prefixes of different scopes', () => {
  const dec = opportunity('dec', {stage: 'won', closedDate: '2025-12-31'});
  const jan = opportunity('jan', {stage: 'won', closedDate: '2026-01-01'});
  const r = receivable('r', 'dec-contract', dec.id, {dueDate: '2025-12-31'});
  const result = calculateManagementOverview(data({opportunities: [dec, jan], contracts: [
    contract('dec-contract', dec.id, {signedDate: '2025-12-31'}), contract('jan-contract', jan.id, {signedDate: '2026-01-01'})],
    receivables: [r], payments: [payment('p', r, 2_000, '2026-01-01')],
  }), {...opts, period: '2026-01', asOfDate: '2026-01-01'});
  assert.equal(result.metrics.bookedCents, 10_000);
  assert.equal(result.metrics.collectedCents, 2_000);
  assert.equal(result.metrics.dueCents, 0);
  assert.equal(result.metrics.overdueCents, 8_000);
  assert.equal(result.metrics.wonCount, 1);
});

test('risk rules inspect cross-period open opportunities and deduplicate owner amount across rules', () => {
  const stale = opportunity('stale', {ownerId: 'b', amountCents: 40_000, expectedCloseDate: '2026-09-30',
    nextStep: '   ', nextStepDueDate: null, stageEnteredAt: '2026-09-01T00:00:00Z', evidenceId: null});
  const source = data({opportunities: [stale, opportunity('healthy')], tasks: [task('done', stale.id, {status: 'completed', completionNote: '已安排会议', completedAt: now})]});
  const result = calculateManagementOverview(source, opts);
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.metrics.openCount, 1);
  assert.deepEqual(new Set(result.risks.map(r => r.kind)), new Set(['close_overdue', 'next_step_missing', 'stage_stalled', 'evidence_missing']));
  assert.equal(new Set(result.risks.map(r => r.id)).size, 4);
  assert.equal(result.owners.find(o => o.ownerId === 'b')!.atRiskCents, 40_000);
  assert.equal(result.owners.find(o => o.ownerId === 'b')!.openCount, 0);
  assert.equal(result.tasks[0]!.status, 'completed');
  const filtered = calculateManagementOverview(source, {...opts, ownerId: 'a'});
  assert.equal(filtered.risks.length, 0);
  assert.equal(filtered.tasks.length, 0);
});

test('14-day stall threshold follows Asia/Shanghai dates; a deadline today is not overdue', () => {
  const old = opportunity('exactly14', {stageEnteredAt: '2026-10-14T15:30:00.000Z', expectedCloseDate: '2026-10-28', nextStepDueDate: '2026-10-28'});
  const fresh = opportunity('only13', {stageEnteredAt: '2026-10-14T16:30:00.000Z'});
  const result = calculateManagementOverview(data({opportunities: [old, fresh]}), opts);
  assert.deepEqual(result.risks.map(r => [r.opportunityId, r.kind]), [['exactly14', 'stage_stalled']]);
  assert.match(result.risks[0]!.reason, /14 calendar days/);
});

test('overdue next step requires an actual step; missing date and missing text are one risk', () => {
  const result = calculateManagementOverview(data({opportunities: [
    opportunity('late', {nextStepDueDate: '2026-10-27'}),
    opportunity('missing', {nextStep: '', nextStepDueDate: '2026-10-27'}),
    opportunity('both-missing', {nextStep: '', nextStepDueDate: null}),
    opportunity('closed', {stage: 'lost', closedDate: '2026-10-27', nextStep: '', evidenceId: null, expectedCloseDate: '2026-10-01'}),
  ]}), opts);
  assert.deepEqual(result.risks.map(r => [r.opportunityId, r.kind]), [
    ['late', 'next_step_overdue'], ['both-missing', 'next_step_missing'], ['missing', 'next_step_missing'],
  ]);
});

test('snapshot comparison preserves evidence for moved, closed, reassigned and unavailable items', () => {
  const unchanged = opportunity('unchanged', {forecastCategory: 'commit'});
  const changed = opportunity('changed', {amountCents: 20_000, forecastCategory: 'commit'});
  const moved = opportunity('moved', {expectedCloseDate: '2026-11-15'});
  const won = opportunity('won', {amountCents: 15_000, stage: 'won', closedDate: '2026-10-10'});
  const reassigned = opportunity('reassigned', {ownerId: 'b'});
  const added = opportunity('added', {amountCents: 30_000, forecastCategory: 'commit'});
  const previousMetrics = {...calculateManagementOverview(data(), opts).metrics, forecastCents: 500_000};
  const snapshot: ForecastSnapshot = {id: 'snapshot', period: opts.period, ownerId: 'a', capturedAt: '2026-10-20T00:00:00Z', capturedBy: 'manager', metrics: previousMetrics,
    items: [item(unchanged), item(opportunity('changed')), item(opportunity('moved')), item(opportunity('won')), item(opportunity('reassigned')), item(opportunity('missing'))]};
  const previous = structuredClone(snapshot);
  const result = calculateManagementOverview(data({opportunities: [unchanged, changed, moved, won, reassigned, added], contracts: [contract('c', won.id, {amountCents: 15_000})]}), {...opts, ownerId: 'a', latestSnapshot: snapshot});
  assert.equal(result.snapshotDeltaCents, -425_000);
  const changes = new Map(result.snapshotChanges.map(c => [c.opportunityId, c]));
  assert.equal(changes.has('unchanged'), false);
  assert.equal(changes.get('changed')!.kind, 'changed');
  assert.equal(changes.get('changed')!.before!.amountCents, 10_000);
  assert.equal(changes.get('changed')!.after!.amountCents, 20_000);
  assert.equal(changes.get('moved')!.kind, 'removed');
  assert.equal(changes.get('moved')!.after!.expectedCloseDate, '2026-11-15');
  assert.equal(changes.get('won')!.after!.stage, 'won');
  assert.equal(changes.get('reassigned')!.after!.ownerId, 'b');
  assert.equal(changes.get('missing')!.after, null);
  assert.equal(changes.get('added')!.kind, 'added');
  assert.equal(changes.get('added')!.before, null);
  result.latestSnapshot!.items[0]!.amountCents = 999;
  changes.get('moved')!.before!.title = '修改输出';
  assert.deepEqual(snapshot, previous);
});

test('no target, no closed deals and zero denominator remain null instead of misleading percentages', () => {
  const empty = calculateManagementOverview(data(), opts);
  assert.equal(empty.target, null);
  assert.equal(empty.metrics.bookingAttainment, null);
  assert.equal(empty.metrics.collectionAttainment, null);
  assert.equal(empty.metrics.forecastGapCents, null);
  assert.equal(empty.metrics.winRate, null);
  assert.equal(empty.snapshotDeltaCents, null);
  assert.deepEqual(empty.stages.map(s => [s.count, s.amountCents]), [[0, 0], [0, 0], [0, 0], [0, 0]]);
  const zero = calculateManagementOverview(data(), {...opts, target: target({bookingsTargetCents: 0, collectionTargetCents: 0})});
  assert.equal(zero.metrics.bookingAttainment, null);
  assert.equal(zero.metrics.collectionAttainment, null);
  assert.equal(zero.metrics.forecastGapCents, 0);
});

test('exceeding a target does not create a negative forecast gap or cap attainment at 100 percent', () => {
  const won = opportunity('won', {stage: 'won', closedDate: '2026-10-10', amountCents: 50_000});
  const result = calculateManagementOverview(data({opportunities: [won], contracts: [contract('c', won.id, {amountCents: 50_000})]}), {...opts, target: target({bookingsTargetCents: 10_000})});
  assert.equal(result.metrics.bookingAttainment, 5);
  assert.equal(result.metrics.forecastGapCents, 0);
});

test('forecast excludes signed and lost opportunities and keeps mutually exclusive category totals', () => {
  const won = opportunity('won', {stage: 'won', forecastCategory: 'commit', closedDate: '2026-10-10'});
  const result = calculateManagementOverview(data({opportunities: [
    opportunity('commit', {forecastCategory: 'commit'}), opportunity('best', {forecastCategory: 'best_case'}),
    opportunity('pipeline'), opportunity('excluded', {forecastCategory: 'excluded'}),
    opportunity('lost', {stage: 'lost', forecastCategory: 'commit', closedDate: '2026-10-10'}), won,
  ], contracts: [contract('c', won.id)]}), opts);
  assert.equal(result.metrics.commitCents, 10_000);
  assert.equal(result.metrics.bestCaseCents, 10_000);
  assert.equal(result.metrics.pipelineCents, 10_000);
  assert.equal(result.metrics.forecastCents, 20_000);
  assert.equal(result.metrics.upsideCents, 30_000);
  assert.equal(result.metrics.openCount, 4);
  assert.equal(result.owners[0]!.openCents, 40_000);
});

test('invalid monetary input and aggregate overflow fail loudly without rounding', () => {
  for (const amountCents of [0.5, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculateManagementOverview(data({opportunities: [opportunity('x', {amountCents})]}), opts), RangeError);
  }
  assert.throws(() => calculateManagementOverview(data({opportunities: [
    opportunity('x', {amountCents: Number.MAX_SAFE_INTEGER}), opportunity('y', {amountCents: 1}),
  ]}), opts), /aggregate exceeds/);
  const won = opportunity('won', {amountCents: Number.MAX_SAFE_INTEGER, stage: 'won', closedDate: '2026-10-10'});
  assert.throws(() => calculateManagementOverview(data({opportunities: [won, opportunity('commit', {amountCents: 1, forecastCategory: 'commit'})],
    contracts: [contract('c', won.id, {amountCents: Number.MAX_SAFE_INTEGER})],
  }), opts), /aggregate exceeds/);
});

test('inconsistent relationships, duplicate rows and overpayments cannot silently distort metrics', () => {
  const o = opportunity('o', {stage: 'won', closedDate: '2026-10-10'});
  const r = receivable('r', 'c', o.id);
  const base = data({opportunities: [o], contracts: [contract('c', o.id)], receivables: [r]});
  assert.throws(() => calculateManagementOverview({...base, opportunities: [o, o]}, opts), /Duplicate opportunity/);
  assert.throws(() => calculateManagementOverview({...base, payments: [payment('p', r, 10_001, '2026-10-20')]}, opts), /exceed receivable/);
  assert.throws(() => calculateManagementOverview({...base, payments: [{...payment('p', r, 100, '2026-10-20'), contractId: 'other'}]}, opts), /relationship is invalid/);
  assert.throws(() => calculateManagementOverview({...base, tasks: [task('t', 'missing')]}, opts), /absent opportunity/);
});

test('mismatched target or snapshot scopes are rejected rather than compared across owners or months', () => {
  const snapshot: ForecastSnapshot = {id: 's', period: '2026-09', ownerId: null, capturedAt: now, capturedBy: 'manager', metrics: calculateManagementOverview(data(), opts).metrics, items: []};
  assert.throws(() => calculateManagementOverview(data(), {...opts, target: target({ownerId: 'a'})}), /Target scope/);
  assert.throws(() => calculateManagementOverview(data(), {...opts, latestSnapshot: snapshot}), /Snapshot scope/);
  assert.throws(() => calculateManagementOverview(data(), {...opts, period: '2026-13'}), /period/);
  assert.throws(() => calculateManagementOverview(data(), {...opts, asOfDate: '2026-02-30'}), /calendar date/);
  assert.throws(() => calculateManagementOverview(data({opportunities: [opportunity('ambiguous', {stageEnteredAt: '2026-10-14T12:00:00'})]}), opts), /explicit timezone/);
});

test('calculation is deterministic and detached output mutations do not change business inputs', () => {
  const source = data({opportunities: [opportunity('o')], tasks: [task('t', 'o')]});
  const saved = structuredClone(source);
  const first = calculateManagementOverview(source, opts);
  assert.deepEqual(calculateManagementOverview(source, opts), first);
  first.opportunities[0]!.amountCents = 1;
  first.tasks[0]!.title = 'mutated output';
  assert.deepEqual(source, saved);
});

test('refunds affect their own cash-flow month and preserve historical attribution after contract cancellation',()=>{
 const o=opportunity('refunded',{stage:'negotiation',ownerId:'b'});const c=contract('refunded-contract',o.id,{signedDate:'2026-09-10',cancelledAt:now});const r=receivable('refunded-installment',c.id,o.id);const p=payment('original',r,10000,'2026-09-12');
 const refund={...p,id:'refund',paymentId:p.id,amountCents:10000,refundedDate:'2026-10-20',reference:'refund-reference',evidenceId:'evidence',actorId:'manager',note:'Refund confirmed by the gateway.'};
 const source=data({opportunities:[o],contracts:[c],receivables:[r],payments:[p],refunds:[refund]});
 const september=calculateManagementOverview(source,{...opts,period:'2026-09'});const october=calculateManagementOverview(source,opts);
 assert.equal(september.metrics.collectedCents,10000);assert.equal(october.metrics.collectedCents,-10000);assert.equal(october.metrics.bookedCents,0);assert.equal(october.metrics.dueCents,0);assert.equal(october.receivables.length,0);
 assert.equal(calculateManagementOverview(source,{...opts,ownerId:'a'}).metrics.collectedCents,-10000);assert.equal(calculateManagementOverview(source,{...opts,ownerId:'b'}).metrics.collectedCents,0);
 assert.throws(()=>calculateManagementOverview({...source,refunds:[{...refund,amountCents:10001}]},opts),/Refunds exceed/);
});
