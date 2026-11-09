import test from 'node:test';
import assert from 'node:assert/strict';
import type { CustomerDetail, IntentAction, ModelConnection, ProductRun, WorkInbox } from '@intent/contracts';
import { customerReadiness, modelReadiness, nextWorkSuggestion } from '../src/product/workspace-readiness.js';

const timestamp = '2026-11-05T08:00:00.000Z';
const emptyInbox = (): WorkInbox => ({ asOf: timestamp, tasks: [], facts: [], actions: [], runs: [], advancements: [], customers: [] });
const action = (status: IntentAction['status'], id = 'action_1'): IntentAction => ({ id, customerId: 'customer_1', runId: 'run_1', kind: 'send_proposal', status, revision: 1, approvedRevision: null, approvedBy: null, recipient: 'contact@example.com', subject: 'Original customer subject', body: 'Original message', evidenceIds: ['evidence_1'], operationId: 'operation_1', receipt: null, lastError: null, updatedAt: timestamp });
const run = (status: ProductRun['status']): ProductRun => ({ id: 'run_1', customerId: 'customer_1', evidenceId: 'evidence_1', status, actionId: null, model: 'fixture-v1', error: null, createdAt: timestamp, parentRunId: null, attempt: 1, retryReason: null, successorRunId: null });
const task = (id: string, dueDate: string): WorkInbox['tasks'][number] => ({ id, opportunityId: 'opportunity_1', customerId: 'customer_1', opportunityTitle: 'Original opportunity', title: id, assigneeId: 'member_1', assigneeName: 'Member', dueDate, status: 'open', completionNote: null, revision: 1, createdAt: timestamp, completedAt: null });
const detail = (): CustomerDetail => ({ customer: { id: 'customer_1', name: 'Original customer name', industry: 'Industry', contact: 'Contact', email: 'contact@example.com', ownerId: 'member_1', stage: 'engaged', revision: 1 }, evidence: [], facts: [], actions: [], commitments: [], fields: [], fieldValues: {} });

test('model readiness distinguishes missing purposes, deterministic demos and verified current configurations', () => {
    const model: ModelConnection = { id: 'model_1', name: 'Model', provider: 'deepseek', model: 'deepseek-chat', enabled: true, purpose: 'reasoning', hasApiKey: true, revision: 2, testedRevision: 2 };
    assert.equal(modelReadiness([model], 'extraction'), 'missing');
    assert.equal(modelReadiness([{ ...model, enabled: false }], 'reasoning'), 'missing');
    assert.equal(modelReadiness([{ ...model, provider: 'fixture', hasApiKey: false }], 'reasoning'), 'demo');
    assert.equal(modelReadiness([model], 'reasoning'), 'connected');
    for (const invalid of [{ ...model, testedRevision: 1 }, { ...model, hasApiKey: false }, { ...model, testError: 'Connection failed' }, { ...model, revision: undefined, testedRevision: undefined }]) {
        assert.equal(modelReadiness([invalid], 'reasoning'), 'unverified');
    }
    assert.equal(modelReadiness([model, { ...model, id: 'model_2' }], 'reasoning'), 'unverified');
});

test('uncertain delivery takes precedence over recovery and never proposes another dispatch', () => {
    const inbox = emptyInbox();
    inbox.actions = [action('draft', 'new_draft'), action('unknown')];
    inbox.runs = [run('failed')];
    inbox.tasks = [task('overdue', '2026-11-04')];
    assert.deepEqual(nextWorkSuggestion(inbox, 'manager', '2026-11-05'), { kind: 'reconcile', href: '/customers/customer_1?action=action_1', record: 'Original customer subject' });
    assert.equal(nextWorkSuggestion(inbox, 'sales', '2026-11-05')?.kind, 'inspect-outcome');
    assert.equal(nextWorkSuggestion(inbox, 'engineer', '2026-11-05')?.kind, 'failed-run');
});

test('an existing action or successor prevents suggesting recovery of the original failed run', () => {
    const inbox = emptyInbox();
    inbox.runs = [{ ...run('failed'), actionId: 'existing_action' }, { ...run('failed'), id: 'superseded', successorRunId: 'successor' }];
    assert.equal(nextWorkSuggestion(inbox, 'admin', '2026-11-05'), null);
});

test('open tasks use the business-date boundary and earliest deadline without mutating inbox order', () => {
    const inbox = emptyInbox();
    inbox.tasks = [task('later', '2026-11-06'), task('today', '2026-11-05'), { ...task('closed', '2026-11-01'), status: 'completed' }];
    assert.equal(nextWorkSuggestion(inbox, 'engineer', '2026-11-05')?.kind, 'task');
    assert.equal(nextWorkSuggestion(inbox, 'engineer', '2026-11-05')?.record, 'today');
    assert.equal(nextWorkSuggestion(inbox, 'engineer', '2026-11-06')?.kind, 'overdue-task');
    assert.deepEqual(inbox.tasks.map(item => item.id), ['later', 'today', 'closed']);
    assert.equal(nextWorkSuggestion(inbox, 'engineer', '2026-11-05')?.href, '/opportunities/opportunity_1?tab=tasks');
});

test('engineer guidance does not offer action approval or reconciliation even if action metadata is present', () => {
    const inbox = emptyInbox();
    inbox.actions = [action('unknown'), action('draft'), action('approved')];
    assert.equal(nextWorkSuggestion(inbox, 'engineer', '2026-11-05'), null);
    assert.equal(nextWorkSuggestion(emptyInbox(), 'sales', '2026-11-05'), null);
});

test('candidate fact review follows urgent recovery and overdue work, precedes action approval, and respects the engineer role', () => {
    const inbox = emptyInbox();
    inbox.facts = [{ id: 'fact_1', customerId: 'customer_1', key: 'requirements', value: 'Original customer requirement', evidenceId: 'evidence_1', quote: 'Original evidence', status: 'candidate', revision: 1, reviewedBy: null, reviewNote: null, reviewedAt: null }];
    inbox.actions = [action('draft')];
    assert.deepEqual(nextWorkSuggestion(inbox, 'sales', '2026-11-05'), { kind: 'facts', href: '/customers/customer_1?focus=facts', record: 'Original customer requirement' });
    assert.equal(nextWorkSuggestion(inbox, 'engineer', '2026-11-05'), null);
    inbox.tasks = [task('overdue', '2026-11-04')];
    assert.equal(nextWorkSuggestion(inbox, 'sales', '2026-11-05')?.kind, 'overdue-task');
    inbox.runs = [run('failed')];
    assert.equal(nextWorkSuggestion(inbox, 'sales', '2026-11-05')?.kind, 'failed-run');
    inbox.actions.push(action('unknown'));
    assert.equal(nextWorkSuggestion(inbox, 'sales', '2026-11-05')?.kind, 'inspect-outcome');
    inbox.actions.pop();
    inbox.runs = [];
    inbox.tasks = [];
    inbox.facts[0]!.status = 'confirmed';
    assert.equal(nextWorkSuggestion(inbox, 'sales', '2026-11-05')?.kind, 'draft');
});

test('first-use guidance does not mistake missing extraction results for missing evidence', () => {
    const customer = detail();
    assert.equal(customerReadiness(customer).kind, 'evidence');
    customer.evidence.push({ id: 'evidence_1', customerId: customer.customer.id, kind: 'meeting', title: 'Original source', body: 'Original evidence text', createdAt: timestamp });
    assert.deepEqual(customerReadiness(customer), { kind: 'planning', href: '/customers/customer_1?focus=runs' });
    customer.facts.push({ id: 'fact_1', customerId: customer.customer.id, key: 'requirements', value: 'Original value', evidenceId: 'evidence_1', quote: 'Original evidence text', status: 'candidate', revision: 1, reviewedBy: null, reviewNote: null, reviewedAt: null });
    assert.equal(customerReadiness(customer).kind, 'facts');
});

test('customer guidance treats uncertain and pending execution as unfinished work', () => {
    const customer = detail();
    customer.actions = [action('succeeded'), action('draft', 'draft_1'), action('unknown', 'unknown_1')];
    assert.deepEqual(customerReadiness(customer), { kind: 'outcome', href: '/customers/customer_1?action=unknown_1' });
    customer.actions = [action('approved')];
    assert.equal(customerReadiness(customer).kind, 'waiting');
});

test('simulated receipts cannot imply real customer contact or feedback', () => {
    const customer = detail();
    customer.evidence = [{ id: 'evidence_1', customerId: customer.customer.id, kind: 'meeting', title: 'Source', body: 'Source evidence', createdAt: timestamp }];
    const delivered = { ...action('succeeded'), receipt: { id: 'receipt_1', operationId: 'operation_1', reference: 'reference', recordedAt: timestamp, simulated: true } };
    customer.actions = [delivered];
    assert.equal(customerReadiness(customer).kind, 'simulation');
    delivered.receipt.simulated = false;
    assert.equal(customerReadiness(customer).kind, 'feedback');
    customer.evidence.push({ id: 'note_1', customerId: customer.customer.id, kind: 'note', title: 'Internal follow-up', body: 'This is not a customer response', createdAt: '2026-11-05T09:00:00.000Z' });
    assert.equal(customerReadiness(customer).kind, 'feedback');
    customer.evidence.push({ id: 'reply_1', customerId: customer.customer.id, kind: 'reply', title: 'Customer reply', body: 'Customer feedback', createdAt: '2026-11-05T09:00:00.000Z' });
    assert.deepEqual(customerReadiness(customer), { kind: 'conversation', href: '/assistant?customer=customer_1' });
});
