import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { IntentService, ProductService, DomainError } from '../packages/domain/src/index.js';
import type { Actor, Plan, ChatReply, Customer } from '../packages/contracts/src/index.js';

const url = process.env.DATABASE_URL;
const rejectsCode = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);

// Each suite owns its tenants, so acceptance and legacy tests can share an isolated test database.
test('PostgreSQL product lifecycle', { skip: !url }, async t => {
  const db = createDatabase(url!);
  const intent = new IntentService(db);
  const product = new ProductService(db);
  const tenantId = `product_${randomUUID().replaceAll('-', '')}`;
  const foreignId = `foreign_${randomUUID().replaceAll('-', '')}`;
  const admin: Actor = { tenantId, memberId: 'admin', role: 'admin' };
  const sales: Actor = { tenantId, memberId: 'sales', role: 'sales' };
  const engineer: Actor = { tenantId, memberId: 'engineer', role: 'engineer' };
  await migrate(db);
  await db.transaction(async tx => {
    await tx.query('INSERT INTO tenants(id,name) VALUES($1,$1),($2,$2)', [tenantId, foreignId]);
    for (const [tid, id, role, active] of [[tenantId, 'admin', 'admin', true], [tenantId, 'manager', 'manager', true], [tenantId, 'sales', 'sales', true], [tenantId, 'sales2', 'sales', true], [tenantId, 'engineer', 'engineer', true], [tenantId, 'disabled', 'sales', false], [foreignId, 'outsider', 'admin', true]]) {
      await tx.query('INSERT INTO members(tenant_id,id,name,email,role,active) VALUES($1,$2,$2,$3,$4,$5)', [tid, id, `${id}@example.com`, role, active]);
    }
    for (const [tid, id, owner] of [[tenantId, 'customer', 'sales'], [tenantId, 'technical', 'engineer'], [foreignId, 'foreign_customer', 'outsider']]) {
      await tx.query("INSERT INTO customers(tenant_id,id,name,industry,contact,email,owner_id) VALUES($1,$2,$2,'Test','Contact','customer@example.com',$3)", [tid, id, owner]);
    }
    await tx.query("INSERT INTO model_connections(tenant_id,id,name,model,purpose) VALUES($1,'reasoning','Fixture','fixture-v1','reasoning'),($1,'extraction','Fixture extraction','fixture-v1','extraction')", [tenantId]);
  });
  const customerData = (ownerId = 'sales') => ({ name: `Product customer ${randomUUID().slice(0, 8)}`, industry: 'Software', contact: 'Customer contact', email: 'customer@example.com', ownerId });
  const edit = (customer: Customer, extra = {}) => ({ name: customer.name, industry: customer.industry, contact: customer.contact, email: customer.email, ownerId: customer.ownerId, expectedRevision: customer.revision, note: '人工核对更新客户资料', ...extra });
  const addSource = async (customerId = 'customer', actor = admin) => {
    const input = { title: `会议 ${randomUUID()}`, body: '客户需要统一资料。预算五十万元，要求下周确认方案。' };
    return { ...await intent.addEvidence(actor, customerId, input), input };
  };
  const makePlan = async (customerId = 'customer', actor = admin) => {
    const source = await addSource(customerId, actor);
    const plan: Plan = { summary: 'Fixture', facts: [{ key: 'requirements', value: '客户需要统一资料。', quote: '客户需要统一资料。', evidenceId: source.evidence.id }], proposal: { recipient: 'customer@example.com', subject: '方案确认', body: '仅模拟发送，请人工确认。', evidenceIds: [source.evidence.id] } };
    return { ...source, plan, action: await intent.acceptPlan(tenantId, source.runId, plan) };
  };
  const reply = (customerId = 'customer'): ChatReply => ({ text: 'Fixture 演示回答', model: 'fixture-v1', sources: [], cards: [{ id: customerId, title: '客户', description: '查看资料', label: '查看', href: `/customers/${customerId}`, tone: 'neutral' }] });
  const insertOpportunity = async (customerId: string, ownerId: string) => {
    const id = `opp_${randomUUID().replaceAll('-', '')}`;
    await db.query("INSERT INTO opportunities(tenant_id,id,customer_id,owner_id,title,amount_cents,expected_close_date,stage,forecast_category) VALUES($1,$2,$3,$4,'Test opportunity',10000,'2026-11-30','discovery','pipeline')", [tenantId, id, customerId, ownerId]);
    return id;
  };
  const insertTask = async (opportunityId: string, assigneeId: string) => {
    const id = `task_${randomUUID().replaceAll('-', '')}`;
    await db.query("INSERT INTO opportunity_tasks(tenant_id,id,opportunity_id,title,assignee_id,due_date) VALUES($1,$2,$3,'核对客户需求',$4,'2026-11-20')", [tenantId, id, opportunityId, assigneeId]);
    return id;
  };
  try {
    await t.test('customer creation checks active tenant owner and fresh role, and records audit', async () => {
      const created = await product.createCustomer(sales, customerData());
      assert.equal(created.ownerId, sales.memberId); assert.equal(created.revision, 1); assert.equal(created.stage, 'discovery');
      await rejectsCode(product.createCustomer({ ...sales, role: 'admin' }, customerData('admin')), 'FORBIDDEN');
      await rejectsCode(product.createCustomer(engineer, customerData('engineer')), 'FORBIDDEN');
      await rejectsCode(product.createCustomer(admin, customerData('disabled')), 'VALIDATION');
      await rejectsCode(product.createCustomer(admin, customerData('outsider')), 'VALIDATION');
      await rejectsCode(product.createCustomer(admin, { ...customerData(), stage: 'won' } as never), 'VALIDATION');
      assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND event='customer.created'", [tenantId, created.id])).rows[0]!.n, 1);
    });
    await t.test('customer and custom-field edits share one optimistic revision', async () => {
      const created = await product.createCustomer(admin, customerData());
      const [first, second] = await Promise.allSettled([product.updateCustomer(sales, created.id, edit(created, { contact: 'First' })), product.updateCustomer(admin, created.id, edit(created, { contact: 'Second' }))]);
      assert.equal([first, second].filter(r => r.status === 'fulfilled').length, 1);
      assert.ok([first, second].some(r => r.status === 'rejected' && r.reason instanceof DomainError && r.reason.code === 'CONFLICT'));
      const detail = await intent.getCustomer(sales, created.id);
      const fields = await intent.updateFieldValues(sales, created.id, { expectedRevision: detail.customer.revision, values: {} });
      await rejectsCode(product.updateCustomer(admin, created.id, edit(detail.customer)), 'CONFLICT');
      const updated = await product.updateCustomer(sales, created.id, edit(fields.customer, { contact: 'Final' }));
      assert.equal(updated.revision, 4);
      await rejectsCode(product.updateCustomer(sales, created.id, edit(updated, { ownerId: 'sales2' })), 'FORBIDDEN');
      await rejectsCode(product.updateCustomer(engineer, created.id, edit(updated)), 'FORBIDDEN');
    });
    await t.test('transfer refuses stranded open opportunities and tasks, without changing historical owner', async () => {
      const customer = await product.createCustomer(admin, customerData());
      const opportunityId = await insertOpportunity(customer.id, 'sales');
      await rejectsCode(product.updateCustomer(admin, customer.id, edit(customer, { ownerId: 'sales2' })), 'CONFLICT');
      await db.query("UPDATE opportunities SET owner_id='admin' WHERE tenant_id=$1 AND id=$2", [tenantId, opportunityId]);
      const taskId = await insertTask(opportunityId, 'sales');
      await rejectsCode(product.updateCustomer(admin, customer.id, edit(customer, { ownerId: 'sales2' })), 'CONFLICT');
      await db.query("UPDATE opportunity_tasks SET status='completed',completion_note='已核对完毕',completed_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, taskId]);
      const transferred = await product.handoverCustomer(admin, customer.id, { expectedRevision: customer.revision, ownerId: 'sales2', note: 'Transfer customer responsibility.' });
      assert.equal(transferred.ownerId, 'sales2');
      assert.equal((await db.query('SELECT owner_id FROM opportunities WHERE tenant_id=$1 AND id=$2', [tenantId, opportunityId])).rows[0]!.owner_id, 'sales2');
      await rejectsCode(intent.getCustomer(sales, customer.id), 'NOT_FOUND');
    });
    await t.test('contact edits invalidate an existing approved dispatch on execution', async () => {
      const customer = await product.createCustomer(admin, customerData());
      const { action, runId } = await makePlan(customer.id);
      await intent.approveAction(sales, action.id, { expectedRevision: 1 });
      await product.updateCustomer(admin, customer.id, edit(customer, { email: 'new-contact@example.com' }));
      assert.equal(await intent.executeAction(tenantId, runId, 1), 'waiting_approval');
      const current = await intent.getActionForRun(tenantId, runId);
      assert.equal(current?.receipt, null); assert.equal(current?.approvedBy, null); assert.equal(current?.revision, 2);
    });
    await t.test('fact reviews retain citations and a revisioned reviewer history without commercial writes', async () => {
      const { evidence } = await makePlan();
      const fact = (await intent.getCustomer(admin, 'customer')).facts.find(f => f.evidenceId === evidence.id)!;
      assert.equal(fact.revision, 1); assert.equal(fact.reviewedBy, null);
      const confirmed = await product.reviewFact(sales, fact.id, { expectedRevision: 1, status: 'confirmed', note: '已与会议原文逐字核实' });
      assert.equal(confirmed.revision, 2); assert.equal(confirmed.reviewedBy, 'sales'); assert.ok(confirmed.reviewedAt);
      assert.equal(confirmed.evidenceId, fact.evidenceId); assert.equal(confirmed.quote, fact.quote); assert.equal(confirmed.value, fact.value);
      await rejectsCode(product.reviewFact(admin, fact.id, { expectedRevision: 1, status: 'rejected', note: '旧版本不应覆盖新核实' }), 'CONFLICT');
      await rejectsCode(product.reviewFact(admin, fact.id, { expectedRevision: 2, status: 'confirmed', note: '重复状态不能重复写入' }), 'CONFLICT');
      await rejectsCode(product.reviewFact(admin, fact.id, { expectedRevision: 2, status: 'rejected', note: ' ' }), 'VALIDATION');
      const rejected = await product.reviewFact(admin, fact.id, { expectedRevision: 2, status: 'rejected', note: '会后发现该信息尚待客户确认' });
      assert.equal(rejected.revision, 3);
      const history = await product.listFactReviews(sales, fact.id);
      assert.deepEqual(history.map(h => [h.revision, h.fromStatus, h.toStatus, h.actorId]), [[3, 'confirmed', 'rejected', 'admin'], [2, 'candidate', 'confirmed', 'sales']]);
      assert.equal((await intent.getCustomer(admin, 'customer')).customer.stage, 'discovery');
      await rejectsCode(product.reviewFact(engineer, fact.id, { expectedRevision: 3, status: 'confirmed', note: '无权审核客户事实' }), 'FORBIDDEN');
      await rejectsCode(product.listFactReviews({ tenantId: foreignId, memberId: 'outsider', role: 'admin' }, fact.id), 'NOT_FOUND');
    });
    await t.test('later and concurrent planning preserve reviewed facts without reopening identical candidates', async () => {
      const confirmed = await makePlan(), rejected = await makePlan();
      for (const [source, status] of [[confirmed, 'confirmed'], [rejected, 'rejected']] as const) {
        const fact = (await intent.getCustomer(sales, 'customer')).facts.find(item => item.evidenceId === source.evidence.id)!;
        await product.reviewFact(sales, fact.id, { expectedRevision: fact.revision, status, note: 'Recorded review of the original customer source.' });
      }
      const sources = await Promise.all([addSource(), addSource()]);
      const facts = [...confirmed.plan.facts, ...rejected.plan.facts];
      await Promise.all(sources.map(source => intent.acceptPlan(tenantId, source.runId, {
        ...confirmed.plan, facts: [...facts, ...facts],
        proposal: { ...confirmed.plan.proposal, evidenceIds: [source.evidence.id, confirmed.evidence.id, rejected.evidence.id] },
      })));
      const detail = await intent.getCustomer(sales, 'customer');
      for (const [source, status] of [[confirmed, 'confirmed'], [rejected, 'rejected']] as const) {
        const matching = detail.facts.filter(item => item.evidenceId === source.evidence.id);
        assert.equal(matching.length, 1);
        assert.equal(matching[0]!.status, status);
        assert.equal(matching[0]!.revision, 2);
      }
      const inbox = await product.getWorkInbox(sales);
      assert.ok(!inbox.facts.some(item => [confirmed.evidence.id, rejected.evidence.id].includes(item.evidenceId)));
      const fresh = await makePlan();
      assert.ok((await product.getWorkInbox(sales)).facts.some(item => item.evidenceId === fresh.evidence.id));
    });
    await t.test('concurrent fact reviews accept only one exact revision', async () => {
      const { evidence } = await makePlan();
      const fact = (await intent.getCustomer(admin, 'customer')).facts.find(f => f.evidenceId === evidence.id)!;
      const results = await Promise.allSettled([product.reviewFact(admin, fact.id, { expectedRevision: 1, status: 'confirmed', note: '核实正确并确认' }), product.reviewFact(sales, fact.id, { expectedRevision: 1, status: 'rejected', note: '证据不足予以驳回' })]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal((await product.listFactReviews(admin, fact.id)).length, 1);
    });
    await t.test('retry is an atomic unique successor; old failure stays and evidence replay follows latest attempt', async () => {
      const source = await addSource();
      await intent.failRun(tenantId, source.runId, 'sensitive original failure');
      const old = await intent.getRun(admin, source.runId);
      const [first, concurrent] = await Promise.all([product.retryRun(admin, source.runId, { reason: '已修复模型配置重新规划' }), product.retryRun(sales, source.runId, { reason: '请求相同失败任务重试' })]);
      assert.equal(first.id, concurrent.id); assert.equal(first.parentRunId, source.runId); assert.equal(first.attempt, 2); assert.equal(first.status, 'queued');
      assert.deepEqual(await intent.getRun(admin, source.runId), old);
      const count = (await db.query('SELECT count(*)::int AS n FROM outbox WHERE tenant_id=$1 AND aggregate_id=$2', [tenantId, first.id])).rows[0]!.n;
      assert.equal(count, 1);
      assert.equal((await intent.addEvidence(sales, 'customer', source.input)).runId, first.id);
      await intent.failRun(tenantId, first.id, 'second failure');
      const third = await product.retryRun(sales, first.id, { reason: '再次修复后重试失败规划' });
      assert.equal(third.attempt, 3); assert.equal(third.parentRunId, first.id);
      assert.equal((await intent.addEvidence(admin, 'customer', source.input)).runId, third.id);
      const list = await product.listRuns(admin, 'customer');
      assert.equal(list.find(r => r.id === source.runId)?.successorRunId, first.id);
      assert.equal(list.find(r => r.id === first.id)?.successorRunId, third.id);
      assert.equal((await db.query('SELECT actor_id FROM planning_runs WHERE tenant_id=$1 AND id=$2', [tenantId, third.id])).rows[0]!.actor_id, 'sales');
      await rejectsCode(product.listRuns(engineer, 'customer'), 'NOT_FOUND');
    });
    await t.test('retry rejects disabled models, forbidden actors, queued, successful and unknown-action runs', async () => {
      const source = await addSource();
      await rejectsCode(product.retryRun(admin, source.runId, { reason: '仍在队列不允许重试' }), 'CONFLICT');
      await intent.failRun(tenantId, source.runId, 'failure');
      await intent.updateModel(admin, 'extraction', { enabled: false });
      await rejectsCode(product.retryRun(admin, source.runId, { reason: '模型关闭不应创建规划' }), 'MODEL_DISABLED');
      await intent.updateModel(admin, 'extraction', { enabled: true });
      const technical = await addSource('technical', engineer); await intent.failRun(tenantId, technical.runId, 'failure');
      await rejectsCode(product.retryRun(engineer, technical.runId, { reason: '技术成员没有规划重试权限' }), 'FORBIDDEN');
      const planned = await makePlan();
      await rejectsCode(product.retryRun(admin, planned.runId, { reason: '已有行动不能另起规划' }), 'CONFLICT');
      await intent.approveAction(admin, planned.action.id, { expectedRevision: 1 });
      process.env.INTENT_TRANSPORT_OUTCOME = 'unknown';
      try { assert.equal(await intent.executeAction(tenantId, planned.runId, 1), 'unknown'); } finally { delete process.env.INTENT_TRANSPORT_OUTCOME; }
      await rejectsCode(product.retryRun(admin, planned.runId, { reason: '未知结果不能绕过重新投递' }), 'CONFLICT');
      await intent.reconcileAction(admin, planned.action.id, { expectedRevision: 1, outcome: 'delivered', reference: 'product-verification' });
      await rejectsCode(product.retryRun(admin, planned.runId, { reason: '已完成不能重新规划发送' }), 'CONFLICT');
    });
    await t.test('work inbox includes only reachable assigned tasks and latest actionable run leaves', async () => {
      const opportunityId = await insertOpportunity('customer', 'admin');
      const ownTask = await insertTask(opportunityId, 'sales');
      const adminTask = await insertTask(opportunityId, 'admin');
      const technicalOpportunity = await insertOpportunity('technical', 'admin');
      const technicalTask = await insertTask(technicalOpportunity, 'engineer');
      const inbox = await product.getWorkInbox(sales);
      assert.ok(inbox.tasks.some(task => task.id === ownTask)); assert.ok(!inbox.tasks.some(task => task.id === adminTask || task.id === technicalTask));
      assert.ok(inbox.tasks.every(task => task.customerId === 'customer'));
      assert.ok(inbox.actions.length > 0); assert.ok(inbox.runs.every(run => !run.successorRunId && run.customerId === 'customer'));
      assert.ok(inbox.customers.every(customer => customer.id !== 'technical'));
      const technical = await product.getWorkInbox(engineer);
      assert.equal(technical.actions.length, 0); assert.ok(technical.tasks.some(task => task.id === technicalTask));
      assert.ok((await product.getWorkInbox(admin)).tasks.some(task => task.id === adminTask));
    });
    await t.test('candidate fact reviews enter the scoped inbox and leave after a decision or handover', async () => {
      const { evidence } = await makePlan();
      const fact = (await intent.getCustomer(sales, 'customer')).facts.find(item => item.evidenceId === evidence.id)!;
      const inbox = await product.getWorkInbox(sales);
      assert.ok(inbox.facts.some(item => item.id === fact.id && item.quote === fact.quote));
      const visible = new Set((await intent.listCustomers(sales)).map(customer => customer.id));
      assert.ok(inbox.facts.every(item => visible.has(item.customerId) && item.status === 'candidate'));
      assert.equal((await product.getWorkInbox(engineer)).facts.length, 0);
      assert.equal((await product.getWorkInbox({ tenantId: foreignId, memberId: 'outsider', role: 'admin' })).facts.length, 0);
      await product.reviewFact(sales, fact.id, { expectedRevision: fact.revision, status: 'confirmed', note: 'Verified against the original source.' });
      assert.ok(!(await product.getWorkInbox(sales)).facts.some(item => item.id === fact.id));
      const moved = await product.createCustomer(admin, customerData());
      const pending = await makePlan(moved.id);
      const pendingFact = (await intent.getCustomer(sales, moved.id)).facts.find(item => item.evidenceId === pending.evidence.id)!;
      assert.ok((await product.getWorkInbox(sales)).facts.some(item => item.id === pendingFact.id));
      await product.handoverCustomer(admin, moved.id, { expectedRevision: moved.revision, ownerId: 'sales2', note: 'Transfer the outstanding review to the new customer owner.' });
      assert.ok(!(await product.getWorkInbox(sales)).facts.some(item => item.id === pendingFact.id));
      assert.ok((await product.getWorkInbox({ tenantId, memberId: 'sales2', role: 'sales' })).facts.some(item => item.id === pendingFact.id));
    });
    await t.test('conversations are private even from managers, and request IDs atomically deduplicate turns', async () => {
      const conversation = await product.createConversation(sales, { customerId: 'customer', title: '私人客户跟进' });
      const input = { requestId: randomUUID(), message: '请整理下一步' };
      const [first, concurrent] = await Promise.all([product.saveTurn(sales, conversation.id, input, reply()), product.saveTurn(sales, conversation.id, input, reply())]);
      assert.equal(first.id, concurrent.id); assert.equal((await product.getConversation(sales, conversation.id)).turns.length, 1);
      assert.equal((await product.getTurnByRequest(sales, conversation.id, input.requestId))?.id, first.id);
      await rejectsCode(product.saveTurn(sales, conversation.id, { ...input, message: '不同请求内容' }, reply()), 'CONFLICT');
      await rejectsCode(product.getConversation(admin, conversation.id), 'NOT_FOUND');
      await rejectsCode(product.getTurnByRequest({ ...admin, memberId: 'manager', role: 'manager' }, conversation.id, input.requestId), 'NOT_FOUND');
      await rejectsCode(product.saveTurn(admin, conversation.id, { requestId: randomUUID(), message: '经理不能写私人会话' }, reply()), 'NOT_FOUND');
      assert.equal((await product.listConversations(admin, {})).items.length, 0);
      await rejectsCode(product.listConversations(admin, { cursor: conversation.id }), 'NOT_FOUND');
      assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND event='conversation.turn.saved'", [tenantId, first.id])).rows[0]!.n, 1);
    });
    await t.test('saved replies validate current customer citations, exact links, shape and bounded size', async () => {
      const conversation = await product.createConversation(sales, { customerId: 'customer', title: '来源校验' });
      const source = await addSource();
      const foreignSource = await addSource('technical');
      const opportunityId = await insertOpportunity('customer', 'admin');
      const valid = { ...reply(), sources: [{ id: source.evidence.id, title: source.evidence.title, quote: '客户需要统一资料。' }], cards: [{ ...reply().cards[0]!, href: `/opportunities/${opportunityId}?tab=finance` }] };
      const saved = await product.saveTurn(sales, conversation.id, { requestId: randomUUID(), message: '引用原文' }, valid);
      assert.deepEqual(saved.reply, valid);
      const invalid = [
        { ...valid, sources: [{ id: foreignSource.evidence.id, title: foreignSource.evidence.title, quote: '客户需要统一资料。' }] },
        { ...valid, sources: [{ ...valid.sources[0]!, quote: '客户已经承诺签约' }] },
        { ...valid, cards: [{ ...valid.cards[0]!, href: `/opportunities/${opportunityId}?tab=finance&redirect=https://example.com` }] },
        { ...valid, cards: [{ ...valid.cards[0]!, href: 'https://example.com' }] },
        { ...valid, text: 'x'.repeat(20001) },
        { ...valid, cards: Array(31).fill(valid.cards[0]) },
      ];
      for (const value of invalid) await rejectsCode(product.saveTurn(sales, conversation.id, { requestId: randomUUID(), message: '无效回答不得持久化' }, value), 'VALIDATION');
      assert.equal((await product.getConversation(sales, conversation.id)).turns.length, 1);
    });
    await t.test('turn and conversation pagination are private, bounded and have no duplicate page records', async () => {
      const customer = await product.createCustomer(admin, customerData());
      const conversation = await product.createConversation(sales, { customerId: customer.id, title: '分页消息' });
      for (let i = 0; i < 52; i++) await product.saveTurn(sales, conversation.id, { requestId: randomUUID(), message: `第 ${i} 条消息` }, reply(customer.id));
      // PostgreSQL microseconds must not be truncated to JavaScript milliseconds in cursors.
      await db.query("UPDATE conversation_turns SET created_at='2026-10-28T08:00:00.123456Z' WHERE tenant_id=$1 AND conversation_id=$2", [tenantId, conversation.id]);
      const page = await product.getConversation(sales, conversation.id);
      assert.equal(page.turns.length, 50); assert.ok(page.olderCursor);
      const older = await product.getConversation(sales, conversation.id, { before: page.olderCursor! });
      assert.equal(older.turns.length, 2); assert.equal(older.olderCursor, null);
      assert.equal(new Set([...older.turns, ...page.turns].map(turn => turn.id)).size, 52);
      assert.equal(new Set([...older.turns, ...page.turns].map(turn => turn.message)).size, 52);
      const another = await product.createConversation(sales, { customerId: customer.id, title: '另一会话' });
      await rejectsCode(product.getConversation(sales, another.id, { before: page.turns[0]!.id }), 'NOT_FOUND');
      for (let i = 0; i < 50; i++) await product.createConversation(sales, { customerId: customer.id, title: `分页会话 ${i}` });
      await db.query("UPDATE conversations SET updated_at='2026-10-28T09:00:00.987654Z' WHERE tenant_id=$1 AND customer_id=$2", [tenantId, customer.id]);
      const list = await product.listConversations(sales, { customerId: customer.id });
      assert.equal(list.items.length, 50); assert.ok(list.nextCursor);
      const next = await product.listConversations(sales, { customerId: customer.id, cursor: list.nextCursor! });
      assert.equal(next.items.length, 2); assert.equal(next.nextCursor, null);
      assert.equal(new Set([...list.items, ...next.items].map(item => item.id)).size, 52);
      await rejectsCode(product.listConversations(sales, { customerId: 'customer', cursor: list.nextCursor! }), 'NOT_FOUND');
    });
    await t.test('customer transfer and member revocation remove private conversation access including idempotent reads', async () => {
      const customer = await product.createCustomer(admin, customerData());
      const conversation = await product.createConversation(sales, { customerId: customer.id, title: '转交前的私人记录' });
      const input = { requestId: randomUUID(), message: '当前客户资料' };
      await product.saveTurn(sales, conversation.id, input, reply(customer.id));
      await product.handoverCustomer(admin, customer.id, { expectedRevision: customer.revision, ownerId: 'sales2', note: 'Transfer customer responsibility.' });
      await rejectsCode(product.getConversation(sales, conversation.id), 'NOT_FOUND');
      await rejectsCode(product.getTurnByRequest(sales, conversation.id, input.requestId), 'NOT_FOUND');
      await rejectsCode(product.saveTurn(sales, conversation.id, input, reply(customer.id)), 'NOT_FOUND');
      assert.ok(!(await product.listConversations(sales, {})).items.some(item => item.id === conversation.id));
      const own = await product.createConversation(sales, { customerId: 'customer', title: '账号停用检查' });
      await db.query("UPDATE members SET active=false WHERE tenant_id=$1 AND id='sales'", [tenantId]);
      try { await rejectsCode(product.saveTurn(sales, own.id, { requestId: randomUUID(), message: '停用后不得写入' }, reply()), 'UNAUTHENTICATED'); }
      finally { await db.query("UPDATE members SET active=true WHERE tenant_id=$1 AND id='sales'", [tenantId]); }
    });
    await t.test('save waits for concurrent transfer and rechecks access before committing a turn', async () => {
      const customer = await product.createCustomer(admin, customerData());
      const conversation = await product.createConversation(sales, { customerId: customer.id, title: '并发转交' });
      const blocker = await db.pool.connect(); let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await blocker.query("UPDATE customers SET owner_id='sales2' WHERE tenant_id=$1 AND id=$2", [tenantId, customer.id]);
        pending = product.saveTurn(sales, conversation.id, { requestId: randomUUID(), message: '转交竞态检查' }, reply(customer.id));
        const rejection = rejectsCode(pending, 'NOT_FOUND');
        let waited = false;
        for (let i = 0; i < 100; i++) { if ((await db.query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid])).rowCount) { waited = true; break; } await delay(10); }
        assert.ok(waited); await blocker.query('COMMIT'); await rejection;
        assert.equal((await db.query('SELECT count(*)::int AS n FROM conversation_turns WHERE tenant_id=$1 AND conversation_id=$2', [tenantId, conversation.id])).rows[0]!.n, 0);
      } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); }
    });
    await t.test('existing planning and approval writes recheck authority after a concurrent transfer', async () => {
      const customer = await product.createCustomer(admin, customerData());
      const planned = await makePlan(customer.id, sales);
      const source = await addSource(customer.id, sales);
      const plan: Plan = { summary: 'Fixture', facts: [], proposal: { recipient: customer.email, subject: '新计划', body: '客户转交后不得创建', evidenceIds: [source.evidence.id] } };
      const blocker = await db.pool.connect();
      let approval: Promise<unknown> | undefined; let acceptance: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await blocker.query("UPDATE customers SET owner_id='sales2' WHERE tenant_id=$1 AND id=$2", [tenantId, customer.id]);
        approval = intent.approveAction(sales, planned.action.id, { expectedRevision: 1 });
        acceptance = intent.acceptPlan(tenantId, source.runId, plan);
        const rejections = Promise.all([rejectsCode(approval, 'NOT_FOUND'), rejectsCode(acceptance, 'NOT_FOUND')]);
        let waited = false;
        for (let i = 0; i < 100; i++) {
          if ((await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid<>$1 AND cardinality(pg_blocking_pids(pid))>0", [pid])).rows[0]!.n === 2) { waited = true; break; }
          await delay(10);
        }
        assert.ok(waited); await blocker.query('COMMIT'); await rejections;
        assert.equal((await intent.getActionForRun(tenantId, planned.runId))?.approvedBy, null);
        assert.equal(await intent.getActionForRun(tenantId, source.runId), null);
      } finally {
        await blocker.query('ROLLBACK'); blocker.release();
        await Promise.all([approval?.catch(() => {}), acceptance?.catch(() => {})]);
      }
    });
    await t.test('database tenant foreign keys and review metadata constraints reject malformed lifecycle rows', async () => {
      await assert.rejects(db.query("INSERT INTO conversations(tenant_id,id,customer_id,member_id,title) VALUES($1,'cross_conv','foreign_customer','sales','禁止跨租户')", [tenantId]), (error: unknown) => (error as { code: string }).code === '23503');
      const source = await addSource();
      const otherSource = await addSource('technical');
      await assert.rejects(db.query("INSERT INTO planning_runs(tenant_id,id,customer_id,evidence_id,actor_id,parent_run_id,attempt,retry_reason) VALUES($1,'cross_run','technical',$2,'admin',$3,2,'错误来源的重试')", [tenantId, otherSource.evidence.id, source.runId]), (error: unknown) => (error as { code: string }).code === '23503');
      const { evidence } = await makePlan();
      const fact = (await intent.getCustomer(admin, 'customer')).facts.find(f => f.evidenceId === evidence.id)!;
      await assert.rejects(db.query("UPDATE facts SET status='rejected',review_note=NULL WHERE tenant_id=$1 AND id=$2", [tenantId, fact.id]), (error: unknown) => (error as { code: string }).code === '23514');
    });
  } finally {
    await db.transaction(async tx => {
      for (const tid of [tenantId, foreignId]) {
        await tx.query('UPDATE planning_runs SET action_id=NULL WHERE tenant_id=$1', [tid]);
        for (const table of ['conversation_turns', 'conversations', 'fact_reviews', 'opportunity_tasks', 'opportunity_history', 'opportunities', 'commitments', 'receipts', 'facts', 'outbox', 'actions', 'planning_runs', 'evidence', 'customer_field_values', 'field_definitions', 'customers', 'model_connections', 'audit_events', 'members']) {
          await tx.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tid]);
        }
        await tx.query('DELETE FROM tenants WHERE id=$1', [tid]);
      }
    });
    await db.close();
  }
});
