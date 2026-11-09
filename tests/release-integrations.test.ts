import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { requestJson, isPublicAddress, FixtureModel, CompatibleModel } from '../packages/harness/src/index.js';
import { deliverViaGateway } from '../apps/worker/src/gateway.js';
import { createActivities } from '../apps/worker/src/activities.js';
import { DomainError, type DeliveryEnvelope, type IntentService } from '../packages/domain/src/index.js';
import type { Fact, IntentAction, Plan, PlanningContext } from '../packages/contracts/src/index.js';

// Exercise the production HTTP implementation without DNS, TLS, credentials or remote traffic.
function network(t: TestContext, respond?: (response: PassThrough, request: ClientRequest) => void, addresses = [{ address: '1.1.1.1', family: 4 }]) {
  const requests: { url: URL; options: RequestOptions; body: string }[] = [];
  const lookup = t.mock.method(dns, 'lookup', async () => addresses as never);
  t.mock.method(https, 'request', ((url: URL, options: RequestOptions, receive: (response: IncomingMessage) => void) => {
    const emitter = new EventEmitter();
    const response = Object.assign(new PassThrough(), { statusCode: 200 });
    let destroyed = false;
    const request = Object.assign(emitter, {
      end(body: string) {
        requests.push({ url, options, body });
        if (respond) queueMicrotask(() => { receive(response as unknown as IncomingMessage); respond(response, request as unknown as ClientRequest); });
        return request;
      },
      destroy(error: Error) {
        if (!destroyed) {
          destroyed = true;
          queueMicrotask(() => { request.emit('error', error); request.emit('close'); response.destroy(); });
        }
        return request;
      },
    });
    response.once('close', () => request.emit('close'));
    return request as unknown as ClientRequest;
  }) as typeof https.request);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { requests, lookup };
}

const endpoint = 'https://provider.example.test/v1/chat/completions';
const secretHeaders = { authorization: 'Bearer PRIVATE_TEST_CREDENTIAL' };

test('HTTPS transport rejects unsafe URLs and oversized UTF-8 requests before DNS or dispatch', async t => {
  const state = network(t);
  for (const url of ['http://provider.example.test', 'https://user:password@provider.example.test', 'https://provider.example.test:8443', 'https://provider.example.test?token=secret', 'https://provider.example.test/#fragment']) {
    await assert.rejects(requestJson(url, {}, secretHeaders, 100), /HTTPS endpoint/);
  }
  await assert.rejects(requestJson(endpoint, { text: '客户'.repeat(90000) }, secretHeaders, 100), /request size limit/);
  assert.equal(state.lookup.mock.callCount(), 0);
  assert.equal(state.requests.length, 0);
});

test('HTTPS transport rejects a mixed public/private DNS answer before credentials leave the process', async t => {
  const state = network(t, undefined, [{ address: '1.1.1.1', family: 4 }, { address: '169.254.169.254', family: 4 }]);
  await assert.rejects(requestJson(endpoint, {}, secretHeaders, 100), /public address/);
  assert.equal(state.requests.length, 0);
});

test('network policy excludes documentation, benchmarking, protocol and transition address ranges', () => {
  for (const address of ['192.88.99.2', '2001:2::1', '2001::1', '2001:10::1', '3fff::1', '3fff:fff::1', '64:ff9b:1::1', '5f00::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
});

test('HTTPS transport pins its validated address and preserves exact request bytes', async t => {
  const expected = { text: 'Original customer evidence: 中文', count: 1 };
  const state = network(t, response => response.end('{"ok":true}'));
  assert.deepEqual(await requestJson(endpoint, expected, secretHeaders, 1000), { ok: true });
  const sent = state.requests[0]!;
  assert.equal(state.requests.length, 1);
  assert.equal(sent.url.href, endpoint);
  assert.equal(sent.options.family, 4);
  assert.equal(sent.options.method, 'POST');
  assert.equal(sent.body, JSON.stringify(expected));
  assert.equal((sent.options.headers as Record<string, string>)['content-length'], String(Buffer.byteLength(sent.body)));
  assert.equal((sent.options.headers as Record<string, string>).authorization, secretHeaders.authorization);
  let pinned = '';
  const lookup = sent.options.lookup as (host: string, options: unknown, callback: (error: Error | null, address: string, family: number) => void) => void;
  lookup('provider.example.test', {}, (error, address, family) => { assert.equal(error, null); assert.equal(family, 4); pinned = address; });
  assert.equal(pinned, '1.1.1.1');
  assert.equal(state.lookup.mock.callCount(), 1);
});

test('HTTPS transport rejects redirects without following or accepting their JSON body', async t => {
  const state = network(t, response => {
    Object.assign(response, { statusCode: 307, headers: { location: 'https://another.example.test' } });
    response.end('{"status":"delivered","reference":"receipt"}');
  });
  await assert.rejects(requestJson(endpoint, {}, secretHeaders, 1000), /307/);
  assert.equal(state.requests.length, 1);
});

test('HTTPS transport rejects oversized responses without exposing provider content', async t => {
  const state = network(t, response => response.end(Buffer.alloc(1_048_577, 'x')));
  await assert.rejects(requestJson(endpoint, {}, secretHeaders, 1000), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, 'The provider response was interrupted.'); return true;
  });
  assert.equal(state.requests.length, 1);
});

test('HTTPS transport rejects invalid UTF-8 instead of changing provider receipt identifiers', async t => {
  network(t, response => response.end(Buffer.concat([Buffer.from('{"status":"delivered","reference":"receipt-'), Buffer.from([0xff]), Buffer.from('"}')])));
  await assert.rejects(requestJson(endpoint, {}, secretHeaders, 1000), /invalid JSON/);
});

test('HTTPS transport bounds DNS lookup and never starts a request after lookup timeout', async t => {
  const state = network(t);
  state.lookup.mock.mockImplementation(() => new Promise<never>(() => undefined));
  await assert.rejects(requestJson(endpoint, {}, secretHeaders, 10), /lookup timed out/);
  assert.equal(state.requests.length, 0);
});

test('HTTPS transport bounds incomplete response bodies and does not retry the POST', async t => {
  const state = network(t, response => response.write('{"status":"delivered",'));
  await assert.rejects(requestJson(endpoint, {}, secretHeaders, 10), /configured timeout/);
  assert.equal(state.requests.length, 1);
});

test('HTTPS transport redacts interrupted response errors and rejects malformed JSON', async t => {
  await t.test('interrupted response', async sub => {
    const state = network(sub, response => response.destroy(new Error('PRIVATE_PROVIDER_BODY PRIVATE_TEST_CREDENTIAL')));
    await assert.rejects(requestJson(endpoint, {}, secretHeaders, 1000), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, 'The provider response was interrupted.'); assert.equal(error.cause, undefined); return true;
    });
    assert.equal(state.requests.length, 1);
  });
  await t.test('malformed response', async sub => {
    network(sub, response => response.end('PRIVATE_PROVIDER_BODY is not JSON'));
    await assert.rejects(requestJson(endpoint, {}, secretHeaders, 1000), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, 'The provider returned invalid JSON.'); return true;
    });
  });
});

const customer = { id: 'customer', name: 'Acme', industry: 'Manufacturing', contact: 'Buyer', email: 'buyer@example.test', ownerId: 'owner', stage: 'discovery', revision: 1 };
const source = { id: 'source', customerId: customer.id, kind: 'meeting' as const, title: 'Requirements', body: 'The customer needs an implementation plan.', createdAt: '2026-11-09T00:00:00Z' };
const context: PlanningContext = { customer, evidence: [source], fields: [], fieldValues: {}, model: { id: 'fixture', name: 'Fixture', provider: 'fixture', model: 'fixture-v1', purpose: 'reasoning', enabled: true, revision: 1 }, run: { id: 'run', customerId: customer.id, evidenceId: source.id, status: 'planning', actionId: null, model: 'fixture-v1', error: null, createdAt: source.createdAt } };
const plan: Plan = { summary: 'Review implementation requirements.', facts: [{ key: 'requirements', value: 'implementation plan', evidenceId: source.id, quote: source.body }], proposal: { recipient: customer.email, subject: 'Implementation review', body: 'Please review the recorded requirements.', evidenceIds: [source.id] } };
const action: IntentAction = { id: 'action', customerId: customer.id, runId: context.run.id, kind: 'send_proposal', status: 'draft', revision: 1, approvedRevision: null, approvedBy: null, ...plan.proposal, operationId: 'operation', receipt: null, lastError: null, updatedAt: source.createdAt };
const envelope: DeliveryEnvelope = { action, endpoint: 'https://gateway.example.test/send', sender: 'sales@example.test', apiKey: 'PRIVATE_TEST_CREDENTIAL' };

test('gateway delivery accepts only an unambiguous documented receipt and preserves operation idempotency', async () => {
  let calls = 0;
  assert.deepEqual(await deliverViaGateway(envelope, async (url, body, headers, timeout) => {
    calls++; assert.equal(url, envelope.endpoint); assert.equal(timeout, 30000);
    assert.deepEqual(headers, { authorization: 'Bearer PRIVATE_TEST_CREDENTIAL', 'idempotency-key': action.operationId });
    assert.deepEqual(body, { operationId: action.operationId, revision: action.revision, from: envelope.sender, to: action.recipient, subject: action.subject, text: action.body });
    return { status: 'delivered', reference: '  provider-receipt-001  ' };
  }), { outcome: 'delivered', reference: 'provider-receipt-001' });
  assert.equal(calls, 1);
  for (const response of [null, [], {}, { status: 'queued', reference: 'receipt' }, { status: 'delivered', reference: '   ' }, { status: 'delivered', reference: 'x'.repeat(201) }, { status: 'delivered', reference: 'receipt', delivered: false }, { status: 'delivered', reference: 'receipt', error: 'not delivered' }]) {
    let attempts = 0;
    assert.deepEqual(await deliverViaGateway(envelope, async () => { attempts++; return response; }), { outcome: 'unknown' });
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  assert.deepEqual(await deliverViaGateway(envelope, async () => { attempts++; throw new Error('PRIVATE_NETWORK_ERROR'); }), { outcome: 'unknown' });
  assert.equal(attempts, 1);
});

test('planning refreshes authorization and model bindings before starting the second provider stage', async t => {
  for (const change of ['revoked', 'reasoning_revision', 'extraction_revision', 'failed_run', 'database_unavailable'] as const) await t.test(change, async () => {
    let contexts = 0, modelCalls = 0, accepted = false, failed = false;
    class Model extends FixtureModel { override async plan(): Promise<Plan> { modelCalls++; return plan; } }
    const initial = { ...context, extractionModel: { ...context.model, id: 'extractor', purpose: 'extraction' as const } };
    const service = {
      async getActionForRun() { return null; }, async recordWorkflowState() {},
      async getPlanningContext() {
        if (++contexts === 1) return initial;
        if (change === 'revoked') throw new DomainError('UNAUTHENTICATED', 401, 'Access changed.');
        if (change === 'database_unavailable') throw new Error('PRIVATE_DATABASE_FAILURE');
        if (change === 'reasoning_revision') return { ...initial, model: { ...initial.model, revision: 2 } };
        if (change === 'extraction_revision') return { ...initial, extractionModel: { ...initial.extractionModel, revision: 2 } };
        return { ...initial, run: { ...initial.run, status: 'failed' as const } };
      },
      async acceptPlan() { accepted = true; return action; }, async failRun() { failed = true; },
    } as unknown as IntentService;
    await assert.rejects(createActivities(service, new Model()).plan({ tenantId: 'tenant', runId: context.run.id }), error => {
      assert.ok(error instanceof Error);
      assert.equal((error as { nonRetryable?: boolean }).nonRetryable, change !== 'database_unavailable');
      assert.ok(!error.message.includes('PRIVATE_DATABASE_FAILURE')); return true;
    });
    assert.equal(modelCalls, 1); assert.equal(accepted, false); assert.equal(failed, change !== 'database_unavailable');
  });
});

test('reasoning receives current customer and human fact review changes made during extraction', async () => {
  let contexts = 0;
  const seen: PlanningContext[] = [];
  const reviewed: Fact = { ...plan.facts[0]!, id: 'review', customerId: customer.id, status: 'rejected', revision: 2, reviewedBy: 'owner', reviewNote: 'Superseded during extraction.', reviewedAt: source.createdAt };
  class Model extends FixtureModel { override async plan(value: PlanningContext): Promise<Plan> { seen.push(value); return plan; } }
  const service = {
    async getActionForRun() { return null; }, async recordWorkflowState() {},
    async getPlanningContext() { return ++contexts === 1 ? context : { ...context, customer: { ...customer, email: 'new-contact@example.test' }, facts: [reviewed] }; },
    async acceptPlan() { return action; },
  } as unknown as IntentService;
  await createActivities(service, new Model()).plan({ tenantId: 'tenant', runId: context.run.id });
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.customer.email, 'new-contact@example.test');
  assert.deepEqual(seen[1]!.facts![0], reviewed);
});

test('a concurrently completed plan is reused before another reasoning request', async () => {
  let contexts = 0, modelCalls = 0, reads = 0;
  class Model extends FixtureModel { override async plan(): Promise<Plan> { modelCalls++; return plan; } }
  const service = {
    async getActionForRun() { return ++reads === 1 ? null : action; }, async recordWorkflowState() {},
    async getPlanningContext() { return ++contexts === 1 ? context : { ...context, run: { ...context.run, actionId: action.id, status: 'waiting_approval' as const } }; },
    async acceptPlan() { assert.fail('The existing action must be reused.'); },
  } as unknown as IntentService;
  const result = await createActivities(service, new Model()).plan({ tenantId: 'tenant', runId: context.run.id });
  assert.equal(result.actionId, action.id); assert.equal(modelCalls, 1);
});

test('DeepSeek explicitly disables thinking for connection checks and structured tasks without changing custom payloads', async () => {
  for (const provider of ['deepseek', 'openai-compatible'] as const) {
    const connection = { ...context.model, provider, model: provider === 'deepseek' ? 'deepseek-flash' : 'custom-model', baseUrl: 'https://provider.example.test/v1' };
    const answers = [{ ok: true }, { facts: plan.facts }, plan, { text: 'Review the source requirements.', sources: [], cards: [] }];
    let calls = 0;
    const model = new CompatibleModel({ connection, apiKey: 'test-only' }, async (_url, raw) => {
      const payload = raw as Record<string, unknown>;
      assert.equal(payload.model, connection.model);
      assert.equal(payload.max_tokens, 4096);
      assert.deepEqual(payload.response_format, { type: 'json_object' });
      if (provider === 'deepseek') assert.deepEqual(payload.thinking, { type: 'disabled' });
      else assert.equal(Object.hasOwn(payload, 'thinking'), false);
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answers[calls++]) } }] };
    });
    await model.test();
    await model.extract({ ...context, model: connection });
    await model.plan({ ...context, model: connection });
    await model.reply({ customer, evidence: [source], facts: [], actions: [], commitments: [], fields: [], fieldValues: {} }, 'What should I review?', [], []);
    assert.equal(calls, 4);
  }
});

test('provider connection checks reject blank final content even when reasoning content is present', async () => {
  for (const provider of ['deepseek', 'openai-compatible'] as const) for (const content of ['', ' \n\t ']) {
    const model = new CompatibleModel({ connection: { ...context.model, provider, baseUrl: 'https://provider.example.test/v1' }, apiKey: 'test-only' }, async () => ({
      choices: [{ finish_reason: 'stop', message: { content, reasoning_content: 'PRIVATE_PROVIDER_REASONING' } }],
    }));
    await assert.rejects(model.test(), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'The model response was empty.');
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
