import { t, useLocale, translateMessage } from './i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCheck, ChevronRight, CircleCheck, FileCheck2, FileText, History, Inbox, Layers3, LoaderCircle, Mail, Pencil, Plus, Search, ShieldCheck, Sparkles, Target, Upload, Workflow } from 'lucide-react';
import type { Customer, CustomerDetail, Evidence, IntentAction, Member, PlanningRun } from '@intent/contracts';
import { api, errorText, refresh, useActiveRefresh, useResource } from './api';
import { AiMark, Badge, CompanyMark, dateTime, Dialog, Empty, ErrorBanner, Loading, PageHeading, PageLink, SaveNote, stageLabels, Status } from './components';
import { useWorkspace } from './workspace';
import { CustomerOpportunities } from './commercial/opportunities';
import { useSession } from './product/auth';
import { CreateCustomerButton, CustomerBasics, CustomerFacts, CustomerRuns } from './product/customers';
import { ActionResolution, CustomerHandover } from './production';
import { readEvidenceFile } from './product/evidence-file';
const isActive = (action: IntentAction) => action.status === 'approved' || action.status === 'executing';
const attention = (action: IntentAction) => ['draft', 'unknown', 'failed'].includes(action.status);
const customerPath = (id: string, action?: string) => `/customers/${encodeURIComponent(id)}${action ? `?action=${encodeURIComponent(action)}` : ''}`;
function ActionList({ actions, customers, compact = false }: {
    actions: IntentAction[];
    customers: Customer[];
    compact?: boolean;
}) {
    useLocale();
    return <div className={`action-list ${compact ? 'compact' : ''}`}>{actions.map(action => {
            const customer = customers.find(item => item.id === action.customerId);
            return <Link key={action.id} to={customerPath(action.customerId, action.id)} className="action-card"><div className="action-card-top"><span className="row"><CompanyMark name={customer?.name ?? t("C")}/><strong>{customer?.name ?? t("Customer")}</strong></span><Status status={action.status}/></div><div className="action-card-main"><div className="action-type"><Mail size={17}/></div><div><h3>{action.subject}</h3><p>{action.status === 'unknown' ? t("Delivery is uncertain. Check external records before confirming the outcome.") : action.status === 'succeeded' ? (action.receipt?.simulated ? t("Simulated delivery completed; receipt linked.") : t("Delivery receipt recorded and linked to the commitment.")) : action.status === 'cancelled' ? t("This action was cancelled before dispatch.") : t("Intent has prepared an evidence-based draft for your review.")}</p></div></div><div className="action-card-bottom"><span><FileText size={13}/>{action.evidenceIds.length}{" " + t("sources")}<span className="separator">·</span>v{action.revision}</span><span className="action-card-link">{action.status === 'draft' ? t("Review action") : action.status === 'unknown' ? t("Reconcile outcome") : t("View details")}<ArrowUpRight size={15}/></span></div></Link>;
        })}</div>;
}
export function Customers() {
    useLocale();
    const { data, error } = useResource<Customer[]>('/customers');
    const members = useResource<Member[]>('/members');
    const [search, setSearch] = useState('');
    const [stage, setStage] = useState('all');
    if (!data)
        return <Loading error={error}/>;
    const visible = data.filter(customer => `${customer.name} ${customer.contact} ${customer.industry}`.toLowerCase().includes(search.toLowerCase()) && (stage === 'all' || customer.stage === stage));
    return <><PageHeading eyebrow={t("CUSTOMER SPACE")} title={t("Build stronger customer relationships")} description={t("Connect evidence with decisions, commitments and action.")}><CreateCustomerButton /></PageHeading><ErrorBanner error={error} retry/><div className="panel"><div className="table-toolbar"><label className="search-field"><Search size={17}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t("Search customers, contacts or industries")} aria-label={t("Search customers")}/></label><select aria-label={t("Filter customer stage")} value={stage} onChange={event => setStage(event.target.value)}><option value="all">{t("All stages")}</option>{[...new Set(data.map(item => item.stage))].map(value => <option key={value} value={value}>{stageLabels[value] ?? value}</option>)}</select></div><div className="table-scroll"><table><thead><tr><th>{t("Customer name")}</th><th>{t("Contact")}</th><th>{t("Current stage")}</th><th>{t("Owner")}</th><th>{t("Next step")}</th></tr></thead><tbody>{visible.map(customer => <tr key={customer.id}><td><Link to={customerPath(customer.id)} className="table-customer"><CompanyMark name={customer.name}/><div><strong>{customer.name}</strong><span>{customer.industry}</span></div></Link></td><td><strong className="table-text">{customer.contact}</strong><span className="cell-sub">{customer.email}</span></td><td><Badge>{stageLabels[customer.stage] ?? customer.stage}</Badge></td><td><span className="row"><span className="avatar avatar-tiny">{members.data?.find(item => item.id === customer.ownerId)?.name.slice(-1) ?? t("M")}</span>{members.data?.find(item => item.id === customer.ownerId)?.name ?? t("Assigned")}</span></td><td><PageLink href={customerPath(customer.id)}>{t("Open customer workspace")}</PageLink></td></tr>)}</tbody></table></div>{!visible.length && <Empty title={data.length ? t("No matching customers") : t("Start with your first customer")} description={data.length ? t("Try another keyword or stage filter.") : t("Create a customer and record conversations, opportunities and commitments.")}>{!data.length && <CreateCustomerButton />}</Empty>}<div className="table-footer">{t("Total") + " "}{visible.length}{" " + t("customers") + " "}<span>{t("Visible within your account permissions")}</span></div></div><div className="under-table-note"><ShieldCheck size={15}/>{t("Customer records and evidence are available only within the authorized workspace.")}</div></>;
}
export function Actions() {
    useLocale();
    const actions = useResource<IntentAction[]>('/actions');
    const customers = useResource<Customer[]>('/customers');
    const [params, setParams] = useSearchParams();
    const filter = params.get('filter') ?? 'all';
    useActiveRefresh(Boolean(actions.data?.some(isActive)));
    if (!actions.data || !customers.data)
        return <Loading error={actions.error ?? customers.error}/>;
    const visible = actions.data.filter(action => filter === 'attention' ? attention(action) : filter === 'active' ? isActive(action) : filter === 'completed' ? action.status === 'succeeded' : true);
    return <><PageHeading eyebrow={t("ACTION CENTER")} title={t("Turn decisions into next steps")} description={t("Review proposals, approve an exact revision, and follow execution and receipts.")}/><ErrorBanner error={actions.error ?? customers.error} retry/><div className="tabs">{[['all', t("All actions")], ['attention', t("Needs my review")], ['active', t("In progress")], ['completed', t("Completed")]].map(([key, label]) => <button key={key} className={filter === key ? 'selected' : ''} onClick={() => setParams(key === 'all' ? {} : { filter: key })}>{label}</button>)}</div>{visible.length ? <div className="actions-grid"><ActionList actions={visible} customers={customers.data}/></div> : <div className="panel"><Empty icon={<Workflow size={28}/>} title={t("No actions yet")} description={t("Add customer evidence to generate a draft you can review.")}><Link className="button primary" to="/customers">{t("Go to customers")}<ArrowRight size={15}/></Link></Empty></div>}</>;
}
function EvidenceImport({ customer, onClose, onCreated }: {
    customer: Customer;
    onClose: () => void;
    onCreated: (runId: string) => void;
}) {
    useLocale();
    const { mode } = useSession();
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [kind, setKind] = useState<Evidence['kind']>('meeting');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const result = await api<{
                evidence: Evidence;
                runId: string;
            }>(`/customers/${customer.id}/evidence`, 'POST', { title, body, kind });
            refresh();
            onCreated(result.runId);
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={t("Add customer evidence")} subtitle={t("{0} \u00B7 Prepare next steps from actual customer conversations", customer.name)} busy={busy} onClose={onClose} wide><form onSubmit={submit} className="dialog-body form-stack"><ErrorBanner error={error}/><div className="form-columns"><label>{t("Evidence type")}<select value={kind} onChange={event => setKind(event.target.value as Evidence['kind'])}><option value="meeting">{t("Meeting notes")}</option><option value="reply">{t("Customer reply")}</option><option value="note">{t("Follow-up note")}</option></select></label><label>{t("Title")}<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} placeholder={t("For example: Solution requirements meeting")}/></label></div><label>{t("Conversation content")}<textarea rows={10} required minLength={10} maxLength={20000} value={body} onChange={event => setBody(event.target.value)} placeholder={t("Paste meeting notes, a customer reply or follow-up notes. Preserve the original wording so Intent can cite it.")}/></label><div className="between wrap"><label className="file-button"><Upload size={14}/>{t("Import text file")}<input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file)
                return;
            try {
                const text = await readEvidenceFile(file);
                setBody(text);
                setError('');
                if (!title)
                    setTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 200));
            }
            catch (error) {
                setError(errorText(error));
            }
        }}/></label>{mode.demo && <button type="button" className="text-button" onClick={() => { setTitle(t("Example \u00B7 Customer requirements discussion")); setBody(t("Today we discussed a CRM solution with {0}. The customer said: \u201CWe need unified customer records and less duplicate data entry.\u201D They would like an implementation plan and quote. Next, prepare a proposal for the team to review. Contact email: {1}.", customer.contact, customer.email)); }}>{t("Use example notes")}</button>}</div><div className="info-note"><Sparkles size={17}/><p>{t("Saving starts evidence processing. Configured models prepare a draft; an authorized reviewer must approve delivery.")}</p></div><div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : <Sparkles size={16}/>}{t("Save and prepare next steps")}</button></div></form></Dialog>;
}
function RunProgress({ id, onAction, onStatus }: {
    id: string;
    onAction: (id: string) => void;
    onStatus: (status: PlanningRun['status']) => void;
}) {
    useLocale();
    const [poll, setPoll] = useState(1600);
    const { data, error } = useResource<PlanningRun>(`/runs/${encodeURIComponent(id)}`, poll);
    useEffect(() => {
        if (data)
            onStatus(data.status);
        if (data && !['queued', 'planning'].includes(data.status)) {
            setPoll(0);
            refresh();
        }
    }, [data?.status, onStatus]);
    if (error)
        return <ErrorBanner error={error} retry/>;
    if (!data)
        return <div className="run-progress"><LoaderCircle size={17} className="spin"/>{t("Loading planning progress\u2026")}</div>;
    const labels: Record<PlanningRun['status'], string> = { queued: t("Evidence saved; waiting for planning"), planning: t("Intent is preparing evidence and action proposals"), waiting_approval: t("The draft is ready for your review"), waiting_reconciliation: t("The outcome requires reconciliation"), completed: t("The action is closed"), failed: t("Planning could not complete") };
    return <div className={`run-progress ${data.status === 'failed' ? 'warning' : ''}`}>{['queued', 'planning'].includes(data.status) ? <LoaderCircle size={17} className="spin"/> : <CircleCheck size={17}/>}<div className="grow"><strong>{labels[data.status]}</strong>{data.error && <p>{data.error}</p>}{data.status === 'queued' && <p>{t("The workflow will process this task. Progress updates automatically.")}</p>}</div>{data.actionId && <button className="text-button" onClick={() => onAction(data.actionId!)}>{t("View action")}<ArrowRight size={15}/></button>}</div>;
}
export function CustomerPage() {
    useLocale();
    const { id } = useParams();
    const [params, setParams] = useSearchParams();
    const detail = useResource<CustomerDetail>(id ? `/customers/${encodeURIComponent(id)}` : null);
    const [importing, setImporting] = useState(false);
    const [tab, setTab] = useState<'overview' | 'evidence'>('overview');
    const [runStatus, setRunStatus] = useState<PlanningRun['status'] | null>(null);
    useActiveRefresh(Boolean(detail.data?.actions.some(isActive)));
    useEffect(() => {
        const focus = params.get('focus');
        if (!detail.data || !['facts', 'runs'].includes(focus ?? ''))
            return;
        setTab('overview');
        requestAnimationFrame(() => document.getElementById(`customer-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }, [id, detail.data?.customer.id, params]);
    if (!detail.data)
        return <Loading error={detail.error}/>;
    const { customer, evidence, facts, actions, commitments } = detail.data;
    const selectedAction = actions.find(action => action.id === params.get('action'));
    const openAction = (actionId: string) => { const next = new URLSearchParams(params); next.set('action', actionId); setParams(next); };
    const closeAction = () => { const next = new URLSearchParams(params); next.delete('action'); setParams(next); };
    const runId = params.get('run');
    return <><Link className="back-link" to="/customers"><ArrowLeft size={15}/>{t("Customer workspace")}</Link><div className="customer-heading"><div className="row"><CompanyMark name={customer.name}/><div><div className="row wrap"><h1>{customer.name}</h1><Badge>{stageLabels[customer.stage] ?? customer.stage}</Badge></div><p>{customer.industry}<span>·</span>{customer.contact}<span>·</span>{customer.email}</p></div></div><div className="heading-actions"><Link to={`/assistant?customer=${encodeURIComponent(customer.id)}`} className="button"><Sparkles size={15}/>{t("Ask Intent")}</Link>{<button className="button primary" onClick={() => setImporting(true)}><Plus size={16}/>{t("Add evidence")}</button>}</div></div><ErrorBanner error={detail.error} retry/>{runId && <RunProgress key={runId} id={runId} onAction={openAction} onStatus={setRunStatus}/>}
    <div className="customer-columns"><div className="stack"><div className="customer-intent"><div><span className="eyebrow">{t("CUSTOMER CONTEXT")}</span><h2>{evidence.length ? t("Make every conversation useful") : t("Start with what the customer actually said")}</h2><p>{evidence.length ? t("{0} evidence records \u00B7 {1} facts \u00B7 {2} awaiting review \u00B7 {3} actions", evidence.length, facts.length, facts.filter(fact => fact.status === 'candidate').length, actions.length) : t("Add meeting notes or customer replies to connect context, commitments and next steps.")}</p></div><div className="context-graphic" aria-hidden="true"><Target size={52} strokeWidth={1}/><span /></div></div><div className="tabs"><button className={tab === 'overview' ? 'selected' : ''} onClick={() => setTab('overview')}>{t("Customer overview")}</button><button className={tab === 'evidence' ? 'selected' : ''} onClick={() => setTab('evidence')}>{t("Evidence library")}<span>{evidence.length}</span></button></div>
      {tab === 'overview' ? <><CustomerOpportunities customerId={customer.id}/><div className="section-title"><h2>{t("Next actions") + " "}<span className="count-pill">{actions.length}</span></h2><span className="subtle-label"><ShieldCheck size={13}/>{t("Execution requires approval")}</span></div>{actions.length ? <div className="stack">{actions.map(action => <button key={action.id} className="customer-action panel" onClick={() => openAction(action.id)}><div className="between"><span className="row"><span className="mini-icon"><Mail size={17}/></span><strong>{action.subject}</strong></span><Status status={action.status}/></div><p>{action.body.slice(0, 140)}{action.body.length > 140 ? '…' : ''}</p><div className="between"><span className="small muted">{action.evidenceIds.length}{" " + t("sources \u00B7 v")}{action.revision}</span><span className="text-button">{action.status === 'draft' ? t("Review draft") : t("View action")}<ArrowUpRight size={15}/></span></div></button>)}</div> : <div className="panel"><Empty icon={<Mail size={25}/>} title={evidence.length ? runStatus === 'failed' ? t("Evidence saved; planning did not complete") : t("Evidence saved; awaiting next steps") : t("Start with evidence")} description={evidence.length ? runStatus === 'failed' ? t("Review the planning error above. Your evidence remains in the library.") : runId && (!runStatus || ['queued', 'planning'].includes(runStatus)) ? t("Intent is preparing a draft from the available evidence. Progress updates automatically.") : t("Your conversation evidence is saved. A generated draft will appear here for review.") : t("Import conversation evidence to prepare an action draft for approval.")}>{evidence.length ? <button className="button" onClick={() => setTab('evidence')}><FileText size={15}/>{t("View saved evidence")}</button>  : <button className="button" onClick={() => setImporting(true)}><Plus size={15}/>{t("Add the first evidence record")}</button>}</Empty></div>}
      <CustomerFacts detail={detail.data} onEvidence={evidenceId => { setTab('evidence'); requestAnimationFrame(() => document.getElementById(`evidence-${evidenceId}`)?.scrollIntoView({ behavior: 'smooth' })); }}/><CustomerRuns customerId={customer.id} evidence={evidence} onAction={openAction} onRun={run => { setRunStatus(null); const next = new URLSearchParams(params); next.set('run', run); setParams(next); }}/></> : <div className="stack">{evidence.length ? evidence.map(item => <article className="panel evidence-card" key={item.id} id={`evidence-${item.id}`}><div className="row"><span className="mini-icon"><FileText size={18}/></span><div className="grow"><h3>{item.title}</h3><p>{item.kind === 'meeting' ? t("Meeting notes") : item.kind === 'reply' ? t("Customer reply") : t("Follow-up note")} · {dateTime(item.createdAt)}</p></div><Badge>{t("Original evidence")}</Badge></div><div className="evidence-body">{item.body}</div></article>) : <div className="panel"><Empty icon={<BookOpen size={25}/>} title={t("The evidence library is empty")} description={t("Meeting notes, customer replies and follow-up notes can support your next step.")}>{<button className="button primary" onClick={() => setImporting(true)}>{t("Add evidence")}</button>}</Empty></div>}</div>}
    </div><aside className="stack"><CustomerBasics customer={customer}/><CustomerHandover customer={customer}/><CustomerFields detail={detail.data} openInitially={params.get('focus') === 'fields'}/><div className="panel"><div className="panel-heading"><h2>{t("Customer commitments")}</h2><History size={16}/></div><div className="panel-body">{commitments.length ? commitments.map(commitment => <div className="commitment" key={commitment.id}><span className={`commitment-dot ${commitment.status === 'fulfilled' ? 'done' : ''}`}>{commitment.status === 'fulfilled' && <Check size={10}/>}</span><strong>{commitment.title}</strong><p>{commitment.status === 'cancelled' ? t("Cancelled") : commitment.status === 'fulfilled' ? t("Completed \u00B7 Receipt linked") : t("Open \u00B7 Awaiting action completion")}</p>{commitment.dueAt && <time>{dateTime(commitment.dueAt)}</time>}<button className="text-button small" onClick={() => openAction(commitment.actionId)}>{t("View related action")}<ArrowUpRight size={12}/></button></div>) : <p className="muted small">{t("Evidence-backed commitments are linked to actions and completion receipts.")}</p>}</div></div><div className="principle-note"><FileText size={18}/><div><strong>{t("Traceable information, informed decisions")}</strong><p>{t("AI-extracted information is saved as candidate facts. Delivery moves the customer to awaiting feedback; it never marks a deal as won.")}</p></div></div></aside></div>
    {importing && <EvidenceImport customer={customer} onClose={() => setImporting(false)} onCreated={run => { setImporting(false); setRunStatus(null); setParams({ run }); }}/>} {selectedAction && <ActionDialog key={selectedAction.id} action={selectedAction} evidence={evidence} customer={customer} onClose={closeAction}/>} {params.has('action') && !selectedAction && <ErrorBanner error={t("This action does not exist or is outside the visible customer scope.")}/>}
  </>;
}
function CustomerFields({ detail, openInitially }: {
    detail: CustomerDetail;
    openInitially: boolean;
}) {
    useLocale();
    const canEdit = useWorkspace().user.role !== 'engineer';
    const [editing, setEditing] = useState(openInitially && canEdit);
    const [values, setValues] = useState(detail.fieldValues);
    const [revision, setRevision] = useState(detail.customer.revision);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    useEffect(() => {
        if (openInitially && canEdit) {
            setEditing(true);
            document.getElementById('customer-fields')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [openInitially]);
    const fields = detail.fields.filter(field => field.enabled);
    const begin = () => { setValues(detail.fieldValues); setRevision(detail.customer.revision); setError(''); setSaved(false); setEditing(true); };
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const result = await api<CustomerDetail>(`/customers/${detail.customer.id}/fields`, 'PATCH', { expectedRevision: revision, values: Object.fromEntries(fields.map(field => [field.key, values[field.key] ?? null])) });
            setValues(result.fieldValues);
            setRevision(result.customer.revision);
            setEditing(false);
            setSaved(true);
            refresh();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <section className={`panel ${editing ? 'field-focus' : ''}`} id="customer-fields"><div className="panel-heading"><h2>{t("Customer information")}</h2>{!editing && canEdit && fields.length > 0 && <button className="text-button" onClick={begin}><Pencil size={13}/>{t("Edit")}</button>}</div><div className="panel-body"><ErrorBanner error={error}/>{fields.length ? editing ? <form className="form-stack" onSubmit={submit}>{fields.map(field => <label key={field.key}>{field.label}{field.required && <span className="required">*</span>}{field.type === 'select' ? <select required={field.required} value={String(values[field.key] ?? '')} onChange={event => setValues({ ...values, [field.key]: event.target.value || null })}><option value="">{t("Please select")}</option>{field.options.map(option => <option key={option}>{option}</option>)}</select> : <input required={field.required} type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} step={field.type === 'number' ? 'any' : undefined} value={values[field.key] ?? ''} onChange={event => setValues({ ...values, [field.key]: event.target.value === '' ? null : field.type === 'number' ? Number(event.target.value) : event.target.value })}/>}</label>)}<div className="row"><button className="button primary" disabled={busy}>{busy ? t("Saving\u2026") : t("Save information")}</button><button type="button" className="button" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>{t("Cancel")}</button></div></form> : <dl className="detail-fields">{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{detail.fieldValues[field.key] ?? <span className="muted">{t("Not provided")}</span>}</dd></div>)}</dl> : <p className="muted small">{t("No custom fields are enabled. An administrator can configure customer fields.")}</p>}<SaveNote>{saved && t("Customer information saved")}</SaveNote></div></section>;
}
function ActionDialog({ action, customer, evidence, onClose }: {
    action: IntentAction;
    customer: Customer;
    evidence: Evidence[];
    onClose: () => void;
}) {
    useLocale();
    const workspace = useWorkspace();
    const role = workspace.user.role;
    const canEdit = role !== 'engineer';
    const canReconcile = role === 'admin' || role === 'manager';
    const [snapshot, setSnapshot] = useState(action);
    const [editing, setEditing] = useState(false);
    const [recipient, setRecipient] = useState(action.recipient);
    const [subject, setSubject] = useState(action.subject);
    const [body, setBody] = useState(action.body);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [reference, setReference] = useState('');
    const [outcome, setOutcome] = useState<'' | 'delivered' | 'not_delivered'>('');
    useEffect(() => {
        if (!editing && action.revision >= snapshot.revision && action.updatedAt >= snapshot.updatedAt) {
            setSnapshot(action);
            setRecipient(action.recipient);
            setSubject(action.subject);
            setBody(action.body);
        }
    }, [action, editing]);
    async function perform(operation: 'save' | 'approve' | 'reconcile') {
        setBusy(true);
        setError('');
        try {
            const payload = operation === 'save' ? { expectedRevision: snapshot.revision, recipient, subject, body } : operation === 'approve' ? { expectedRevision: snapshot.revision } : { expectedRevision: snapshot.revision, outcome, reference };
            const result = await api<IntentAction>(`/actions/${snapshot.id}${operation === 'save' ? '' : `/${operation}`}`, operation === 'save' ? 'PATCH' : 'POST', payload);
            setSnapshot(result);
            setEditing(false);
            refresh();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={t("Review action")} subtitle={t("{0} \u00B7 Proposal email \u00B7 Revision v{1}", customer.name, snapshot.revision)} busy={busy} onClose={onClose} wide><div className="dialog-body"><div className="between action-review-status"><Status status={snapshot.status}/><span className="small muted">{(snapshot.status === 'draft' ? workspace.execution.transport : snapshot.transport) === 'webhook' ? t("Real gateway delivery") : t("Simulated delivery")}</span></div><ActionResolution action={snapshot}/><ErrorBanner error={error}/>{snapshot.resolutionNote && <p>{snapshot.resolutionNote}</p>}{snapshot.lastError && <div className="info-note amber">{translateMessage(snapshot.lastError)}</div>}
    {editing ? <form className="form-stack" onSubmit={event => { event.preventDefault(); void perform('save'); }}><label>{t("Recipient")}<input type="email" required value={recipient} onChange={event => setRecipient(event.target.value)}/></label><label>{t("Email subject")}<input required maxLength={200} value={subject} onChange={event => setSubject(event.target.value)}/></label><label>{t("Email body")}<textarea required rows={12} maxLength={20000} value={body} onChange={event => setBody(event.target.value)}/></label><p className="small muted">{t("Editing creates a new revision and clears approval. Review and approve the new revision before execution.")}</p><div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={() => setEditing(false)}>{t("Cancel editing")}</button><button className="button primary" disabled={busy}>{busy ? t("Saving\u2026") : t("Save new revision")}</button></div></form> : <><div className="email-preview"><div className="email-meta"><span>{t("Recipient")}</span><strong>{snapshot.recipient}</strong></div><div className="email-meta"><span>{t("Subject")}</span><strong>{snapshot.subject}</strong></div><div className="email-body">{snapshot.body}</div></div><details className="source-details"><summary><FileText size={15}/>{t("Based on") + " "}{snapshot.evidenceIds.length}{" " + t("customer sources")}</summary>{snapshot.evidenceIds.map(id => { const item = evidence.find(value => value.id === id); return item ? <div key={id}><strong>{item.title}</strong><p>{item.body}</p></div> : <p key={id}>{t("This evidence is not currently visible")}</p>; })}</details>
      {snapshot.receipt && <div className="receipt"><div className="row"><CircleCheck size={19}/><strong>{snapshot.receipt.simulated ? t("Simulated delivery completed") : t("Delivery receipt recorded")}</strong></div><dl><div><dt>{t("Receipt reference")}</dt><dd>{snapshot.receipt.reference}</dd></div><div><dt>{t("Recorded at")}</dt><dd>{dateTime(snapshot.receipt.recordedAt)}</dd></div><div><dt>{t("Operation ID")}</dt><dd>{snapshot.receipt.operationId}</dd></div></dl><p>{snapshot.receipt.simulated ? t("This is a simulated receipt. No real email was sent.") : t("The receipt was recorded from the configured delivery gateway or an explicit reconciliation.")}</p></div>}
      {snapshot.status === 'unknown' && !canReconcile && <div className="info-note amber"><ShieldCheck size={17}/><p>{t("Ask an administrator or sales manager to verify and record the delivery outcome. Automatic redispatch is blocked. Your account can view this record but cannot reconcile it.")}</p></div>}
      {snapshot.status === 'unknown' && canReconcile ? <form className="form-stack reconciliation" onSubmit={event => { event.preventDefault(); void perform('reconcile'); }}><div className="info-note amber"><ShieldCheck size={17}/><p>{t("Delivery is uncertain and automatic redispatch is blocked. Check external records. Confirmed non-delivery requires a new approval before another attempt.")}</p></div><label>{t("Reconcile outcome")}<select required value={outcome} onChange={event => setOutcome(event.target.value as typeof outcome)}><option value="">{t("Select the verified outcome")}</option><option value="delivered">{t("Confirmed delivered")}</option><option value="not_delivered">{t("Confirmed not delivered")}</option></select></label><label>{t("Reconciliation reference")}<input required minLength={3} maxLength={200} value={reference} onChange={event => setReference(event.target.value)} placeholder={t("Enter a traceable reference or verification note")}/></label><button className="button primary" disabled={busy}>{busy ? t("Submitting\u2026") : t("Record verified outcome")}</button></form> : <div className="dialog-footer review-footer"><span className="small muted">{snapshot.approvedRevision ? t("Approved v{0}", snapshot.approvedRevision) : t("Approval applies only to this revision")}</span><div className="row">{canEdit && ['draft', 'approved'].includes(snapshot.status) && <button className="button" disabled={busy} onClick={() => setEditing(true)}><Pencil size={14}/>{t("Edit draft")}</button>}{canEdit && snapshot.status === 'draft' && <button className="button primary" disabled={busy} onClick={() => void perform('approve')}>{busy ? <LoaderCircle size={15} className="spin"/> : <ShieldCheck size={15}/>}{t("Approve v{0} and dispatch",snapshot.revision)}</button>}{isActive(snapshot) && <span className="row small"><LoaderCircle size={15} className="spin"/>{t("Waiting for execution results\u2026")}</span>}</div></div>}</>}
  </div></Dialog>;
}
