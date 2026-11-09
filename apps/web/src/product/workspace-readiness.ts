import type { CustomerDetail, ModelConnection, Role, WorkInbox } from '@intent/contracts';

export type ModelReadiness = 'missing' | 'demo' | 'connected' | 'unverified';

export function modelReadiness(models: ModelConnection[], purpose: ModelConnection['purpose']): ModelReadiness {
    const active = models.filter(model => model.purpose === purpose && model.enabled);
    if (!active.length) return 'missing';
    if (active.length !== 1) return 'unverified';
    const model = active[0]!;
    if (model.provider === 'fixture') return 'demo';
    return model.hasApiKey && model.revision !== undefined && model.testedRevision === model.revision && !model.testError ? 'connected' : 'unverified';
}

export type WorkSuggestion = {
    kind: 'reconcile' | 'inspect-outcome' | 'failed-run' | 'overdue-task' | 'facts' | 'proposal' | 'draft' | 'task' | 'waiting';
    href: string;
    record: string;
};

export function nextWorkSuggestion(inbox: WorkInbox, role: Role, businessDate: string): WorkSuggestion | null {
    const customerPath = (id: string) => `/customers/${encodeURIComponent(id)}`;
    if (role !== 'engineer') {
        const unknown = inbox.actions.find(action => action.status === 'unknown');
        if (unknown) return { kind: role === 'admin' || role === 'manager' ? 'reconcile' : 'inspect-outcome', href: `${customerPath(unknown.customerId)}?action=${encodeURIComponent(unknown.id)}`, record: unknown.subject };
    }
    const failed = inbox.runs.find(run => run.status === 'failed' && !run.actionId && !run.successorRunId);
    if (failed) return { kind: 'failed-run', href: `${customerPath(failed.customerId)}?focus=runs`, record: inbox.customers.find(customer => customer.id === failed.customerId)?.name ?? '' };
    const tasks = inbox.tasks.filter(task => task.status === 'open').sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id));
    const overdue = tasks.find(task => task.dueDate < businessDate);
    if (overdue) return { kind: 'overdue-task', href: `/opportunities/${encodeURIComponent(overdue.opportunityId)}?tab=tasks`, record: overdue.title };
    if (role !== 'engineer') {
        const fact = inbox.facts.find(item => item.status === 'candidate');
        if (fact) return { kind: 'facts', href: `${customerPath(fact.customerId)}?focus=facts`, record: fact.value };
        const proposal = inbox.advancements.find(item => item.status === 'pending');
        if (proposal) return { kind: 'proposal', href: `/opportunities/${encodeURIComponent(proposal.opportunityId)}?focus=advance`, record: proposal.goal };
        const draft = inbox.actions.find(action => action.status === 'draft');
        if (draft) return { kind: 'draft', href: `${customerPath(draft.customerId)}?action=${encodeURIComponent(draft.id)}`, record: draft.subject };
    }
    const task = tasks[0];
    if (task) return { kind: 'task', href: `/opportunities/${encodeURIComponent(task.opportunityId)}?tab=tasks`, record: task.title };
    const run = inbox.runs.find(item => item.status === 'queued' || item.status === 'planning');
    if (run) return { kind: 'waiting', href: `${customerPath(run.customerId)}?focus=runs`, record: inbox.customers.find(customer => customer.id === run.customerId)?.name ?? '' };
    const approved = role !== 'engineer' && inbox.actions.find(action => action.status === 'approved' || action.status === 'executing');
    if (approved) return { kind: 'waiting', href: `${customerPath(approved.customerId)}?action=${encodeURIComponent(approved.id)}`, record: approved.subject };
    return null;
}

export type CustomerReadiness = { kind: 'evidence' | 'facts' | 'outcome' | 'draft' | 'waiting' | 'simulation' | 'feedback' | 'planning' | 'conversation'; href: string };

export function customerReadiness(detail: CustomerDetail): CustomerReadiness {
    const path = `/customers/${encodeURIComponent(detail.customer.id)}`;
    const actions = [...detail.actions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const unresolved = actions.find(action => action.status === 'unknown');
    if (unresolved) return { kind: 'outcome', href: `${path}?action=${encodeURIComponent(unresolved.id)}` };
    const pending = actions.find(action => action.status === 'draft' || action.status === 'approved' || action.status === 'executing');
    if (pending) return { kind: pending.status === 'draft' ? 'draft' : 'waiting', href: `${path}?action=${encodeURIComponent(pending.id)}` };
    if (!detail.evidence.length) return { kind: 'evidence', href: path };
    if (detail.facts.some(fact => fact.status === 'candidate')) return { kind: 'facts', href: `${path}?focus=facts` };
    const delivered = actions.find(action => action.status === 'succeeded' && action.receipt);
    if (delivered?.receipt?.simulated) return { kind: 'simulation', href: `${path}?action=${encodeURIComponent(delivered.id)}` };
    if (delivered && !detail.evidence.some(evidence => evidence.kind === 'reply' && Date.parse(evidence.createdAt) > Date.parse(delivered.receipt!.recordedAt))) {
        return { kind: 'feedback', href: path };
    }
    if (!actions.length && !detail.facts.length) return { kind: 'planning', href: `${path}?focus=runs` };
    return { kind: 'conversation', href: `/assistant?customer=${encodeURIComponent(detail.customer.id)}` };
}
