import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { advancementInput, advancementPlanSchema, type Actor, type AdvancementContext, type AdvancementInput, type Opportunity } from '../packages/contracts/src/index.js';
import { createDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { CommercialService, DomainError, IntentService, ProductService } from '../packages/domain/src/index.js';
import { FixtureModel } from '../packages/harness/src/index.js';

const model = new FixtureModel();
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format();

test('advancement inputs cannot grant authority or carry model commands', () => {
  const input = { requestId: randomUUID(), expectedRevision: 1, factId: 'fact', factRevision: 2, goal: '确认试点范围', dueDate: date };
  assert.ok(advancementInput.safeParse(input).success);
  for (const extra of [{ tenantId: 'foreign' }, { role: 'admin' }, { nextStep: '直接签约' }, { dueDate: '2026-02-30' }, { goal: ' ' }]) {
    assert.equal(advancementInput.safeParse({ ...input, ...extra }).success, false);
  }
  assert.equal(advancementPlanSchema.safeParse({ nextStep: '核对预算', rationale: '来自已核实信息', stage: 'won' }).success, false);
});

test('PostgreSQL: grounded advancement proposals and exact revision decisions', { skip: !process.env.DATABASE_URL }, async t => {
  const db = createDatabase(process.env.DATABASE_URL!); const intent = new IntentService(db); const product = new ProductService(db); const commercial = new CommercialService(db);
  const tenantId = `advance_${randomUUID().replaceAll('-', '')}`; const foreignId = `foreign_${randomUUID().replaceAll('-', '')}`;
  const admin: Actor = { tenantId, memberId: 'admin', role: 'admin' }; const sales: Actor = { tenantId, memberId: 'sales', role: 'sales' };
  const engineer: Actor = { tenantId, memberId: 'engineer', role: 'engineer' }; const outsider: Actor = { tenantId: foreignId, memberId: 'outsider', role: 'admin' };
  await migrate(db);
  await db.transaction(async tx => {
    await tx.query('INSERT INTO tenants(id,name) VALUES($1,$1),($2,$2)', [tenantId, foreignId]);
    for (const [tid, id, role] of [[tenantId, 'admin', 'admin'], [tenantId, 'sales', 'sales'], [tenantId, 'engineer', 'engineer'], [foreignId, 'outsider', 'admin']]) {
      await tx.query('INSERT INTO members(tenant_id,id,name,email,role) VALUES($1,$2,$2,$3,$4)', [tid, id, `${id}@example.com`, role]);
    }
    await tx.query("INSERT INTO model_connections(tenant_id,id,name,model,purpose) VALUES($1,'reasoning','Fixture','fixture-v1','reasoning'),($1,'extraction','Fixture','fixture-v1','extraction')", [tenantId]);
  });
  async function setup(ownerId = 'sales') {
    const customer = await product.createCustomer(admin, { name: '推进测试客户', industry: '软件', contact: '客户联系人', email: 'customer@example.com', ownerId });
    const source = await intent.addEvidence(admin, customer.id, { title: '需求核实', body: '客户需要先试点统一客户资料。预算未确定，需要先确认试点范围。' });
    await intent.acceptPlan(tenantId, source.runId, await model.plan(await intent.getPlanningContext(tenantId, source.runId)));
    const candidate = (await intent.getCustomer(admin, customer.id)).facts.find(f => f.key === 'requirements')!;
    const fact = await product.reviewFact(admin, candidate.id, { expectedRevision: candidate.revision, status: 'confirmed', note: '已对照客户原文核实' });
    const opportunity = await commercial.createOpportunity(admin, { title: '试点平台', customerId: customer.id, ownerId: 'sales', amountCents: 100000, expectedCloseDate: date, stage: 'discovery', forecastCategory: 'pipeline', nextStep: '原有人工计划', nextStepDueDate: null, evidenceId: null, lostReason: null });
    const input: AdvancementInput = { requestId: randomUUID(), expectedRevision: opportunity.revision, factId: fact.id, factRevision: fact.revision, goal: '确认试点范围与验收标准', dueDate: date };
    return { customer, source, candidate, fact, opportunity, input };
  }
  const edit = (o: Opportunity) => ({ title: o.title, customerId: o.customerId, ownerId: o.ownerId, amountCents: o.amountCents, expectedCloseDate: o.expectedCloseDate, stage: o.stage, forecastCategory: o.forecastCategory, nextStep: o.nextStep, nextStepDueDate: o.nextStepDueDate, evidenceId: o.evidenceId, lostReason: o.lostReason, expectedRevision: o.revision, note: '人工调整后重新核对' });
  async function generate(id: string, input: AdvancementInput, actor = sales) {
    const prepared = await commercial.prepareAdvancement(actor, id, input);
    return prepared.kind === 'existing' ? prepared.proposal : commercial.saveAdvancement(actor, id, input, model.advance(prepared.context));
  }
  try {
    await t.test('Fixture is deterministic, keeps user intent separate, and rejects unverified/foreign evidence', async () => {
      const { opportunity, input } = await setup(); const prepared = await commercial.prepareAdvancement(sales, opportunity.id, input);
      assert.equal(prepared.kind, 'context'); if (prepared.kind !== 'context') return;
      const context = prepared.context; const before = structuredClone(context); const plan = model.advance(context);
      assert.deepEqual(model.advance(context), plan); assert.deepEqual(context, before); assert.match(plan.nextStep, /确认试点范围/); assert.match(plan.rationale, /not a customer commitment/);
      assert.match(model.advance({ ...context, goal: '确认预算' }).nextStep, /budget boundaries/);
      assert.match(model.advance({ ...context, goal: '确认采购决策' }).nextStep, /decision participants/);
      assert.match(model.advance({ ...context, goal: '确认排期' }).nextStep, /conversation time/);
      for (const altered of [{ ...context, fact: { ...context.fact, status: 'candidate' } }, { ...context, fact: { ...context.fact, customerId: 'foreign' } }, { ...context, evidence: { ...context.evidence, body: '引用不存在' } }, { ...context, opportunity: { ...context.opportunity, stage: 'won' } }]) {
        assert.throws(() => model.advance(altered as AdvancementContext));
      }
      const longQuote = '需要'.repeat(300); assert.ok(model.advance({ ...context, goal: '目标'.repeat(100), fact: { ...context.fact, quote: longQuote }, evidence: { ...context.evidence, body: longQuote } }).nextStep.length <= 500);
    });
    await t.test('proposal persists without business writes; concurrent requests and lost responses reuse it', async () => {
      const { opportunity, input, fact } = await setup(); const before = await commercial.getOpportunity(sales, opportunity.id);
      const [a, b] = await Promise.all([generate(opportunity.id, input), generate(opportunity.id, input)]);
      assert.equal(a.id, b.id); assert.equal(a.status, 'pending'); assert.equal(a.quote, fact.quote); assert.equal(a.factRevision, fact.revision);
      assert.deepEqual(await commercial.getOpportunity(sales, opportunity.id), before);
      assert.equal((await commercial.listAdvancements(sales, opportunity.id)).length, 1);
      assert.ok((await product.getWorkInbox(sales)).advancements.some(p => p.id === a.id));
      assert.equal((await product.getWorkInbox(engineer)).advancements.length, 0);
      await rejects(generate(opportunity.id, { ...input, goal: '改变目标不可重用请求' }), 'CONFLICT');
      await rejects(commercial.listAdvancements(outsider, opportunity.id), 'NOT_FOUND');
      await rejects(commercial.decideAdvancement(outsider, opportunity.id, a.id, { expectedRevision: 1, decision: 'apply', note: '越租户不能采用' }), 'NOT_FOUND');
    });
    await t.test('apply once preserves money/stage/source and records exact approval, history and decision', async () => {
      const { opportunity, input } = await setup(); const p = await generate(opportunity.id, input);
      const decision = { expectedRevision: 1, decision: 'apply' as const, note: '已核对事实和期限，适合当前试点' };
      const [a, b] = await Promise.all([commercial.decideAdvancement(sales, opportunity.id, p.id, decision), commercial.decideAdvancement(sales, opportunity.id, p.id, decision)]);
      assert.deepEqual(a, b); assert.equal(a.status, 'applied'); assert.equal(a.revision, 2); assert.equal(a.appliedOpportunityRevision, 2); assert.equal(a.decidedBy, sales.memberId);
      for (const column of ['decision_note', 'applied_opportunity_revision']) await assert.rejects(db.query(`UPDATE advancement_proposals SET ${column}=NULL WHERE tenant_id=$1 AND id=$2`, [tenantId, p.id]), (e: unknown) => (e as {code:string}).code === '23514');
      const after = await commercial.getOpportunity(sales, opportunity.id);
      assert.equal(after.opportunity.nextStep, p.nextStep); assert.equal(after.opportunity.nextStepDueDate, input.dueDate);
      for (const key of ['amountCents', 'stage', 'forecastCategory', 'evidenceId', 'stageEnteredAt', 'closedDate'] as const) assert.equal(after.opportunity[key], opportunity[key]);
      assert.equal(after.history.length, 2); assert.equal(after.history[0]?.before?.nextStep, '原有人工计划'); assert.match(after.history[0]!.note, new RegExp(p.id));
      assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND event='advancement.applied'", [tenantId, p.id])).rows[0]!.n, 1);
      assert.ok(!(await product.getWorkInbox(sales)).advancements.some(item => item.id === p.id));
      assert.deepEqual(await generate(opportunity.id, input), a);
      await rejects(commercial.decideAdvancement(sales, opportunity.id, p.id, { ...decision, decision: 'dismiss' }), 'CONFLICT');
      await rejects(commercial.decideAdvancement(sales, opportunity.id, p.id, { ...decision, expectedRevision: 2 }), 'CONFLICT');
      await commercial.updateOpportunity(sales, opportunity.id, { ...edit(after.opportunity), nextStep: '后续人工计划' });
      assert.deepEqual(await commercial.decideAdvancement(sales, opportunity.id, p.id, decision), a);
      assert.equal((await commercial.getOpportunity(sales, opportunity.id)).opportunity.nextStep, '后续人工计划');
    });
    await t.test('two different proposals for one revision cannot both apply', async () => {
      const { opportunity, input } = await setup(); const a = await generate(opportunity.id, input); const b = await generate(opportunity.id, { ...input, requestId: randomUUID(), goal: '确认采购决策流程' });
      const results = await Promise.allSettled([a, b].map(p => commercial.decideAdvancement(sales, opportunity.id, p.id, { expectedRevision: 1, decision: 'apply', note: '已核实本版推进建议' })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'CONFLICT').length, 1);
      assert.equal((await commercial.getOpportunity(sales, opportunity.id)).history.length, 2);
    });
    await t.test('fact withdrawal or opportunity edits invalidate saving and applying; stale suggestions can be dismissed', async () => {
      const { opportunity, input, fact } = await setup(); const prepared = await commercial.prepareAdvancement(sales, opportunity.id, input); assert.equal(prepared.kind, 'context'); if (prepared.kind !== 'context') return;
      const p = await generate(opportunity.id, input);
      await product.reviewFact(admin, fact.id, { expectedRevision: fact.revision, status: 'rejected', note: '客户更正了之前的信息' });
      await rejects(commercial.saveAdvancement(sales, opportunity.id, { ...input, requestId: randomUUID() }, model.advance(prepared.context)), 'CONFLICT');
      await rejects(commercial.decideAdvancement(sales, opportunity.id, p.id, { expectedRevision: 1, decision: 'apply', note: '旧事实不能继续采用' }), 'CONFLICT');
      const before = await commercial.getOpportunity(sales, opportunity.id);
      const decision = { expectedRevision: 1, decision: 'dismiss' as const, note: '来源信息已撤回，重新收集反馈' };
      const dismissed = await commercial.decideAdvancement(sales, opportunity.id, p.id, decision); assert.equal(dismissed.status, 'dismissed');
      assert.deepEqual(await commercial.decideAdvancement(sales, opportunity.id, p.id, decision), dismissed); assert.deepEqual(await commercial.getOpportunity(sales, opportunity.id), before);
      const second = await setup(); const next = await generate(second.opportunity.id, second.input);
      await commercial.updateOpportunity(sales, second.opportunity.id, { ...edit(second.opportunity), nextStep: '新人工计划' });
      await rejects(commercial.decideAdvancement(sales, second.opportunity.id, next.id, { expectedRevision: 1, decision: 'apply', note: '过时商机版本不能采用' }), 'CONFLICT');
      assert.equal((await commercial.getOpportunity(sales, second.opportunity.id)).opportunity.nextStep, '新人工计划');
    });
    await t.test('confirmed sources must match the customer; disabled models, past dates and closed deals fail closed', async () => {
      const a = await setup(); const b = await setup();
      await rejects(generate(a.opportunity.id, { ...a.input, factId: b.fact.id }), 'NOT_FOUND');
      await rejects(generate(a.opportunity.id, { ...a.input, factRevision: 1 }), 'CONFLICT');
      await rejects(generate(a.opportunity.id, { ...a.input, dueDate: '2000-01-01' }), 'CONFLICT');
      const pending = await generate(a.opportunity.id, a.input);
      await intent.updateModel(admin, 'reasoning', { enabled: false });
      await rejects(generate(b.opportunity.id, b.input), 'MODEL_DISABLED');
      await rejects(commercial.decideAdvancement(sales, a.opportunity.id, pending.id, { expectedRevision: 1, decision: 'apply', note: '模型停用后不可采用' }), 'MODEL_DISABLED');
      assert.equal((await generate(a.opportunity.id, a.input)).id, pending.id);
      await commercial.decideAdvancement(sales, a.opportunity.id, pending.id, { expectedRevision: 1, decision: 'dismiss', note: '模型停用期间撤回建议' });
      await intent.updateModel(admin, 'reasoning', { enabled: true });
      await commercial.updateOpportunity(sales, b.opportunity.id, { ...edit(b.opportunity), stage: 'lost', lostReason: '客户暂不推进' });
      await rejects(generate(b.opportunity.id, { ...b.input, expectedRevision: 2 }), 'CONFLICT');
      await assert.rejects(db.query('UPDATE advancement_proposals SET fact_id=$3 WHERE tenant_id=$1 AND id=$2', [tenantId, pending.id, b.fact.id]), (e: unknown) => (e as { code: string }).code === '23503');
    });
    await t.test('fresh roles and both customer/deal ownership govern generation, inbox and approval', async () => {
      const { opportunity, input, customer } = await setup(); const p = await generate(opportunity.id, input);
      await db.query("UPDATE members SET role='engineer' WHERE tenant_id=$1 AND id='sales'", [tenantId]);
      await rejects(generate(opportunity.id, input, { ...sales, role: 'admin' }), 'FORBIDDEN');
      await rejects(commercial.decideAdvancement({ ...sales, role: 'admin' }, opportunity.id, p.id, { expectedRevision: 1, decision: 'apply', note: '伪造角色不可通过' }), 'FORBIDDEN');
      await db.query("UPDATE members SET role='sales' WHERE tenant_id=$1 AND id='sales'", [tenantId]);
      await commercial.updateOpportunity(admin, opportunity.id, { ...edit(opportunity), ownerId: 'admin' });
      assert.ok(!(await product.getWorkInbox(sales)).advancements.some(item => item.id === p.id));
      await rejects(generate(opportunity.id, { ...input, requestId: randomUUID(), expectedRevision: 2 }), 'FORBIDDEN');
      await product.handoverCustomer(admin, customer.id, { ownerId: 'admin', expectedRevision: customer.revision, note: 'Transfer customer and opportunity responsibility.' });
      await rejects(commercial.listAdvancements(sales, opportunity.id), 'NOT_FOUND');
      await rejects(commercial.decideAdvancement(sales, opportunity.id, p.id, { expectedRevision: 1, decision: 'dismiss', note: '转交后不得处理建议' }), 'NOT_FOUND');
      await db.query("UPDATE members SET active=false WHERE tenant_id=$1 AND id='sales'", [tenantId]);
      await rejects(commercial.listAdvancements(sales, opportunity.id), 'UNAUTHENTICATED');
    });
  } finally {
    await db.transaction(async tx => {
      for (const tid of [tenantId, foreignId]) {
        await tx.query('UPDATE planning_runs SET action_id=NULL WHERE tenant_id=$1', [tid]);
        for (const table of ['advancement_proposals', 'opportunity_history', 'opportunities', 'fact_reviews', 'commitments', 'receipts', 'facts', 'outbox', 'actions', 'planning_runs', 'evidence', 'customers', 'model_connections', 'audit_events', 'members']) await tx.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tid]);
        await tx.query('DELETE FROM tenants WHERE id=$1', [tid]);
      }
    });
    await db.close();
  }
});
