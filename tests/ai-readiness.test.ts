import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatibleModel, FixtureModel } from '../packages/harness/src/index.js';
import { createActivities } from '../apps/worker/src/activities.js';
import { OutboxDispatcher } from '../apps/worker/src/dispatcher.js';
import type { AdvancementContext, CustomerDetail, Fact, IntentAction, ModelConnection, Plan, PlanningContext } from '../packages/contracts/src/index.js';
import type { IntentService } from '../packages/domain/src/index.js';

const customer = { id: 'customer', name: 'Acme', industry: 'Manufacturing', contact: 'Buyer', email: 'buyer@example.test', ownerId: 'owner', stage: 'discovery', revision: 1 };
const source = { id: 'source', customerId: customer.id, kind: 'meeting' as const, title: 'Requirements', body: 'The customer needs a documented implementation plan.', createdAt: '2026-11-05T00:00:00Z' };
const connection: ModelConnection = { id: 'reasoner', name: 'DeepSeek', provider: 'deepseek', model: 'configured-model', purpose: 'reasoning', enabled: true, baseUrl: 'https://api.deepseek.com', timeoutMs: 12000 };
const context: PlanningContext = {
  customer, evidence: [source], fields: [], fieldValues: {}, model: connection,
  run: { id: 'run', customerId: customer.id, evidenceId: source.id, status: 'queued', actionId: null, model: connection.model, error: null, createdAt: source.createdAt },
};
const detail: CustomerDetail = { customer, evidence: [source], facts: [], actions: [], commitments: [], fields: [], fieldValues: {} };
const fact = { key: 'requirements', value: 'implementation plan', evidenceId: source.id, quote: source.body };
const reviewed: Fact = { ...fact, id: 'reviewed', customerId: customer.id, status: 'rejected', revision: 2, reviewedBy: 'owner', reviewNote: 'Superseded by the latest customer discussion.', reviewedAt: source.createdAt };
const plan: Plan = { summary: 'Review the implementation requirements.', facts: [fact], proposal: { recipient: customer.email, subject: 'Implementation review', body: 'Please review the recorded requirements.', evidenceIds: [source.id] } };
const action: IntentAction = { id: 'action', customerId: customer.id, runId: context.run.id, kind: 'send_proposal', status: 'draft', revision: 1, approvedRevision: null, approvedBy: null, ...plan.proposal, operationId: 'operation', receipt: null, lastError: null, updatedAt: source.createdAt };
const completion = (value: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
const model = (value: unknown) => new CompatibleModel({ connection, apiKey: 'test-credential' }, async () => completion(value));

test('extraction rejects unsupported facts before the reasoning provider is called', async () => {
  let calls = 0, accepted = false, failed = false;
  const provider = new CompatibleModel({ connection, apiKey: 'test-credential' }, async () => {
    calls++;
    return completion({ facts: [{ ...fact, value: 'A purchase was approved' }] });
  });
  const service = {
    async getActionForRun() { return null; }, async recordWorkflowState() {}, async getPlanningContext() { return context; },
    async acceptPlan() { accepted = true; return action; }, async failRun() { failed = true; },
  } as unknown as IntentService;
  await assert.rejects(createActivities(service, provider as unknown as FixtureModel).plan({ tenantId: 'tenant', runId: context.run.id }), (error: unknown) => {
    assert.equal((error as { nonRetryable: boolean }).nonRetryable, true);
    assert.equal((error as { type: string }).type, 'MODEL_GENERATION_FAILED');
    assert.equal((error as Error).cause, undefined);
    return true;
  });
  assert.equal(calls, 1); assert.equal(accepted, false); assert.equal(failed, true);
  assert.deepEqual(await model({ facts: [fact] }).extract(context), [fact]);
  for (const invalid of [{ ...fact, evidenceId: 'not_supplied' }, { ...fact, quote: 'An invented implementation plan' }]) {
    await assert.rejects(model({ facts: [invalid] }).extract(context), /outside the supplied evidence/);
  }
});

test('follow-up grounding binds the actual prompt, trigger and current recipient', async () => {
  const input = { ...context, evidence: Array.from({ length: 12 }, (_, i) => ({ ...source, id: i === 0 ? source.id : `source_${i}` })) };
  const before = structuredClone(input);
  assert.deepEqual(await model(plan).plan(input), plan);
  for (const invalid of [
    { ...plan, facts: [{ ...fact, evidenceId: 'source_11' }] },
    { ...plan, proposal: { ...plan.proposal, recipient: 'other@example.test' } },
    { ...plan, proposal: { ...plan.proposal, evidenceIds: ['source_1'] } },
    { ...plan, proposal: { ...plan.proposal, evidenceIds: [source.id, 'source_11'] } },
  ]) await assert.rejects(model(invalid).plan(input), /outside the supplied/);
  assert.deepEqual(input, before);
  let sent = false;
  const provider = new CompatibleModel({ connection, apiKey: 'test' }, async () => { sent = true; return completion(plan); });
  await assert.rejects(provider.plan({ ...context, evidence: [] }), /triggering evidence/);
  await assert.rejects(provider.plan({ ...context, evidence: [{ ...source, body: '\u0000'.repeat(20000) }] }), /context limit/);
  assert.equal(sent, false);
});

test('conversation citations and links must be present in the bounded authorized prompt', async () => {
  const evidence = Array.from({ length: 12 }, (_, i) => ({ ...source, id: `source_${i}` }));
  const input = { ...detail, evidence: [...evidence, { ...source, id: 'foreign', customerId: 'other', body: 'FOREIGN_CUSTOMER_CONTENT' }] };
  const answer = { text: 'Review the customer requirements.', sources: [{ id: evidence[0]!.id, title: source.title, quote: source.body }], cards: [] };
  const provider = new CompatibleModel({ connection, apiKey: 'test' }, async (_url, payload) => {
    assert.ok(!JSON.stringify(payload).includes('FOREIGN_CUSTOMER_CONTENT'));
    return completion(answer);
  });
  assert.equal((await provider.reply(input, 'What should I review?', [], [])).sources[0]!.id, 'source_0');
  await assert.rejects(model({ ...answer, sources: [{ ...answer.sources[0], id: 'source_11' }] }).reply(input, 'Review', [], []), /outside the supplied evidence/);
  await assert.rejects(model({ ...answer, cards: [{ id: 'bad', title: 'Review', description: '', label: 'Open', href: 'https://external.example.test', tone: 'neutral' }] }).reply(input, 'Review', [], []), /outside the supplied context/);
});

test('large field catalogs keep whole records bounded and disclose omitted context', async () => {
  const fields = Array.from({ length: 250 }, (_, i) => ({ id: `field_${i}`, key: `field_${i}`, label: `Field ${i}`, type: 'text' as const, required: false, enabled: true, options: [] }));
  const fieldValues = Object.fromEntries(fields.map(field => [field.key, '客户原始资料'.repeat(300)]));
  const input = { ...detail, fields, fieldValues };
  const before = structuredClone(input);
  const provider = new CompatibleModel({ connection, apiKey: 'test' }, async (_url, payload) => {
    const body = payload as { messages: { content: string }[] };
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 512000);
    const supplied = JSON.parse(body.messages.at(-1)!.content);
    assert.equal(supplied.contextCoverage.fields.available, 250);
    assert.equal(supplied.contextCoverage.fields.included, 50);
    assert.ok(supplied.contextCoverage.fieldValues.included < 50);
    for (const [key, value] of Object.entries(supplied.detail.fieldValues)) {
      assert.equal(value, fieldValues[key]);
      assert.ok(supplied.detail.fields.some((field: { key: string }) => field.key === key));
    }
    return completion({ text: 'Some customer fields were omitted.', sources: [], cards: [] });
  });
  await provider.reply(input, 'Review the available fields.', [], []);
  assert.deepEqual(input, before);
});

test('provider cards enforce persistable limits before returning a conversation reply', async () => {
  await assert.rejects(model({ text: 'Review', sources: [], cards: [{ id: 'card', title: 'Review', description: 'x'.repeat(4001), label: 'Open', href: '/customers/customer', tone: 'neutral' }] }).reply(detail, 'Review', [], []));
});

test('advancement context reports omitted financial outcomes instead of implying complete totals', async () => {
  const input = {
    opportunity: { customerId: customer.id }, fact: { ...reviewed, status: 'confirmed' }, evidence: source, goal: 'Review the implementation scope', dueDate: '2026-11-06',
    outcomes: { actions: [], tasks: [], contract: null, payments: Array.from({ length: 40 }, (_, i) => ({ id: `payment_${i}`, amountCents: 100 })), refunds: [] },
  } as unknown as AdvancementContext;
  const provider = new CompatibleModel({ connection, apiKey: 'test' }, async (_url, payload) => {
    const messages = (payload as { messages: { content: string }[] }).messages;
    const supplied = JSON.parse(messages.at(-1)!.content);
    assert.deepEqual(supplied.contextCoverage.payments, { available: 40, included: 30 });
    assert.match(messages[0]!.content, /Do not calculate total collections/);
    return completion({ nextStep: 'Review the scope', rationale: 'Use the reviewed requirements and check missing outcomes.' });
  });
  await provider.advance(input);
});

test('reasoning retains human fact decisions alongside newly extracted candidates', async () => {
  const seen: PlanningContext[] = [];
  class RecordingModel extends FixtureModel {
    override async plan(input: PlanningContext): Promise<Plan> { seen.push(input); return plan; }
  }
  const service = {
    async getActionForRun() { return null; }, async recordWorkflowState() {}, async getPlanningContext() { return { ...context, facts: [reviewed] }; },
    async acceptPlan() { return action; },
  } as unknown as IntentService;
  await createActivities(service, new RecordingModel()).plan({ tenantId: 'tenant', runId: context.run.id });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1]!.facts![0], reviewed);
  assert.equal(seen[1]!.facts![1]!.status, 'candidate');
  assert.equal(seen[1]!.facts![1]!.value, fact.value);
});

test('running outbox publication sets RPC deadlines and stops claiming events after cancellation', async () => {
  const controller = new AbortController();
  const events = ['first', 'second'].map(id => ({ id, tenantId: 'tenant', type: 'plan.requested' as const, aggregateId: id, payload: { runId: id } }));
  const published: string[] = [], deadlines: number[] = [];
  const service = { async listOutbox() { return events; }, async markOutboxPublished(id: string) { published.push(id); } } as unknown as IntentService;
  const client = {
    connection: {
      async withAbortSignal<T>(signal: AbortSignal, fn: () => Promise<T>) { assert.equal(signal, controller.signal); return fn(); },
      async withDeadline<T>(deadline: number, fn: () => Promise<T>) { deadlines.push(deadline); return fn(); },
    },
    workflow: { async start() { controller.abort(); } },
  } as unknown as ConstructorParameters<typeof OutboxDispatcher>[1];
  const before = Date.now();
  assert.equal(await new OutboxDispatcher(service, client).dispatchPending(controller.signal), 1);
  assert.deepEqual(published, ['first']);
  assert.equal(deadlines.length, 1); assert.ok(deadlines[0]! >= before + 10000 && deadlines[0]! <= Date.now() + 10000);
});
