import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CircleArrowRight, Cpu, Radio } from 'lucide-react';
import type { Customer, CustomerDetail, ModelConnection, WorkInbox } from '@intent/contracts';
import { useResource } from '../api';
import { Badge, ErrorBanner } from '../components';
import { today } from '../commercial/shared';
import { t, useLocale } from '../i18n';
import { useWorkspace } from '../workspace';
import { CreateCustomerButton } from './customers';
import { customerReadiness, modelReadiness, nextWorkSuggestion, type WorkSuggestion } from './workspace-readiness';
import './workbench-readiness.css';

function SuggestedWork({ suggestion }: { suggestion: WorkSuggestion }) {
    const descriptions: Record<WorkSuggestion['kind'], [string, string, string]> = {
        reconcile: [t('Verify an uncertain outcome first'), t('Confirm delivery with your provider, then record the result. This action cannot be dispatched again while its outcome is unknown.'), t('Reconcile execution result')],
        'inspect-outcome': [t('Follow up on an uncertain outcome'), t('Ask an administrator or manager to verify delivery and record the result. Do not send the same message again.'), t('View unresolved outcome')],
        'failed-run': [t('Resolve interrupted planning'), t('Inspect the failure and existing attempts before requesting recovery. Your role determines the recovery actions available.'), t('View planning history')],
        'overdue-task': [t('Close the loop on overdue work'), t('This assigned task is past its due date. Record what happened, or ask a manager to update the plan.'), t('View task and record result')],
        facts: [t('Keep customer understanding trustworthy'), t('Review candidate facts against their original citations. Confirm or reject them with a note before relying on them.'), t('Review candidate facts')],
        proposal: [t('Decide on the next business step'), t('Review the goal, cited facts, owner and deadline before accepting the proposed plan.'), t('Review evidence and plan')],
        draft: [t('Turn evidence into a reviewed action'), t('Check the recipient, message and source evidence. Approval applies to the exact revision you review.'), t('Review and approve')],
        task: [t('Move your next task forward'), t('This is your earliest due open task. Keep its completion result connected to the opportunity.'), t('View task and record result')],
        waiting: [t('Follow work already in progress'), t('Check the existing planning or delivery record before starting another attempt.'), t('View progress')],
    };
    const [title, description, label] = descriptions[suggestion.kind];
    return <><h3>{title}</h3>{suggestion.record && <strong className="readiness-record">{suggestion.record}</strong>}<p>{description}</p><Link className="button primary" to={suggestion.href}>{label}<ArrowUpRight size={14}/></Link><p className="product-caption">{t('Suggested from your current work records. Uncertain outcomes and recovery come first, followed by overdue work and decisions.')}</p></>;
}

function CustomerFirstSteps() {
    const { user } = useWorkspace();
    const customers = useResource<Customer[]>('/customers', 30000);
    const [selectedId, setSelectedId] = useState('');
    const customerId = customers.data?.find(customer => customer.id === selectedId)?.id ?? customers.data?.[0]?.id;
    const detail = useResource<CustomerDetail>(customerId ? `/customers/${encodeURIComponent(customerId)}` : null, 30000);
    if (customers.error) return <ErrorBanner error={customers.error} retry/>;
    if (!customers.data) return <p aria-live="polite">{t('Loading customer guidance…')}</p>;
    if (!customers.data.length) return <><h3>{t('Start with a customer')}</h3><p>{user.role === 'engineer' ? t('No customers are currently assigned to you. Ask an administrator or manager to assign a customer so you can use its evidence and complete your work.') : t('Create a customer, then add a meeting note or customer reply. Intent uses that evidence to prepare candidate facts and proposed actions for review.')}</p>{user.role !== 'engineer' && <CreateCustomerButton/>}<Link className="text-button" to="/settings/access">{t('View role permissions')}<ArrowUpRight size={14}/></Link></>;
    const step = detail.data && customerReadiness(detail.data);
    const descriptions = {
        evidence: [t('Give Intent the customer context'), t('Open the customer and add a meeting note, customer reply or follow-up note as evidence. Preserve the original wording so proposals can cite it.'), t('Open customer evidence')],
        facts: [t('Keep customer understanding trustworthy'), user.role === 'engineer' ? t('Candidate facts still need review by the customer owner or a manager. Inspect their original citations before using them.') : t('Review candidate facts against their original citations. Confirm or reject them with a note before relying on them.'), user.role === 'engineer' ? t('View candidate facts') : t('Review candidate facts')],
        outcome: [t('Verify an uncertain outcome first'), t('An existing action has an unknown delivery result. An administrator or manager must reconcile it before another dispatch.'), t('View unresolved outcome')],
        draft: [t('Turn evidence into a reviewed action'), user.role === 'engineer' ? t('A proposed action awaits review by the customer owner or a manager. You can inspect its source evidence.') : t('Check the recipient, message and source evidence. Approval applies to the exact revision you review.'), t('View proposed action')],
        waiting: [t('Follow work already in progress'), t('Check the existing planning or delivery record before starting another attempt.'), t('View progress')],
        simulation: [t('Review the simulated result'), t('The recorded receipt is a simulation. No message was sent to the customer. Your administrator can configure a real delivery gateway when you are ready.'), t('View execution result')],
        feedback: [t('Bring the customer response back into context'), t('A delivery receipt is recorded, but no later customer reply is saved. Add the reply when it arrives. A receipt alone does not confirm customer acceptance or a won deal.'), t('Open customer evidence')],
        planning: [t('Follow evidence processing'), t('Evidence is saved. Check planning history for progress or errors before adding the same source again.'), t('View planning history')],
        conversation: [t('Explore the next step with Intent'), t('Use the current evidence, reviewed facts and recorded outcomes to discuss the next step. Business changes still require a separate review.'), t('Ask Intent')],
    };
    const copy = step && descriptions[step.kind];
    return <><label className="readiness-customer">{t('Customer focus')}<select value={customerId ?? ''} onChange={event => setSelectedId(event.target.value)}>{customers.data.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>{detail.error ? <ErrorBanner error={detail.error} retry/> : copy && step ? <><h3>{copy[0]}</h3><p>{copy[1]}</p><Link className="button primary" to={step.href}>{copy[2]}<ArrowUpRight size={14}/></Link></> : <p aria-live="polite">{t('Loading customer guidance…')}</p>}</>;
}

export function WorkbenchReadiness({ inbox }: { inbox: WorkInbox }) {
    useLocale();
    const { user, execution } = useWorkspace();
    const models = useResource<ModelConnection[]>('/models', 30000);
    const suggestion = nextWorkSuggestion(inbox, user.role, today());
    const modelStatuses = { missing: t('No active model'), demo: t('Deterministic demo'), connected: t('Connection verified'), unverified: t('Configuration needs attention') };
    return <section className="workbench-readiness" aria-label={t('Evidence, decisions and outcomes')}>
        <div className="readiness-focus"><div className="readiness-eyebrow"><CircleArrowRight size={16}/>{t('Suggested focus')}</div>{suggestion ? <SuggestedWork suggestion={suggestion}/> : <CustomerFirstSteps/>}</div>
        <div className="readiness-setup"><div className="readiness-eyebrow"><Cpu size={16}/>{t('AI workspace setup')}</div><h3>{t('Know what powers your work')}</h3>{models.error ? <ErrorBanner error={models.error} retry/> : !models.data ? <p aria-live="polite">{t('Loading model configuration…')}</p> : <><dl>{(['reasoning', 'extraction'] as const).map(purpose => {
            const status = modelReadiness(models.data!, purpose);
            const active = models.data!.find(model => model.purpose === purpose && model.enabled);
            return <div key={purpose}><dt>{purpose === 'reasoning' ? t('Reasoning and conversations') : t('Evidence extraction')}</dt><dd><Badge tone={status === 'connected' ? 'green' : 'amber'}>{modelStatuses[status]}</Badge>{active && <span>{active.name}</span>}</dd></div>;
        })}</dl><p className="product-caption">{models.data.some(model => model.enabled && model.provider === 'fixture') ? t('Demo models use fixed rules. Configure and activate tested DeepSeek or OpenAI-compatible models for live AI generation.') : t('Each purpose needs an active model. A verified connection records a successful test; availability can change.')}</p></>}
        <div className="readiness-delivery"><Radio size={15}/><strong>{execution.transport === 'simulated' ? t('Simulated delivery') : t('Real gateway delivery')}</strong><p>{execution.transport === 'simulated' ? t('No external messages are sent in simulated mode.') : t('Approved actions can send real messages through your configured gateway. Review each action before approving it.')}</p></div>
        <div className="product-actions"><Link className="button" to="/settings/models">{user.role === 'admin' ? t('Configure models') : t('View model settings')}<ArrowUpRight size={14}/></Link>{user.role === 'admin' && <Link className="text-button" to="/settings/operations">{t('Delivery and runtime')}<ArrowUpRight size={14}/></Link>}</div>{user.role !== 'admin' && <p className="product-caption">{t('Your administrator manages model and delivery configuration.')}</p>}
        </div>
    </section>;
}
