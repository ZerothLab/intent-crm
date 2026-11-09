import { t, useLocale, localizedLabels } from '../i18n';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, Check, ChevronDown, FileText, History, Pencil, Plus, RotateCcw, X } from 'lucide-react';
import type { Customer, CustomerDetail, Fact, FactReview, Member, ProductRun } from '@intent/contracts';
import { api, errorText, refresh, useActiveRefresh, useResource } from '../api';
import { Badge, dateTime, Dialog, Empty, ErrorBanner, Loading } from '../components';
import { useWorkspace } from '../workspace';
export function CreateCustomerButton({ className = 'button primary' }: {
    className?: string;
}) {
    useLocale();
    const { user } = useWorkspace();
    const [open, setOpen] = useState(false);
    const navigate = useNavigate();
    if (user.role === 'engineer')
        return null;
    return <><button className={className} onClick={() => setOpen(true)}><Plus size={16}/>{t("New customer")}</button>{open && <CustomerEditor onClose={() => setOpen(false)} onSaved={customer => { setOpen(false); refresh(); navigate(`/customers/${customer.id}`); }}/>}</>;
}
function CustomerEditor({ customer, onClose, onSaved }: {
    customer?: Customer;
    onClose: () => void;
    onSaved: (customer: Customer) => void;
}) {
    useLocale();
    const { user } = useWorkspace();
    const members = useResource<Member[]>('/members');
    const [name, setName] = useState(customer?.name ?? '');
    const [industry, setIndustry] = useState(customer?.industry ?? '');
    const [contact, setContact] = useState(customer?.contact ?? '');
    const [email, setEmail] = useState(customer?.email ?? '');
    const [ownerId, setOwnerId] = useState(customer?.ownerId ?? user.id);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const manager = ['admin', 'manager'].includes(user.role);
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const input = { name, industry, contact, email, ownerId };
            const result = await api<Customer>(`/customers${customer ? `/${customer.id}` : ''}`, customer ? 'PATCH' : 'POST', customer ? { ...input, expectedRevision: customer.revision, note } : input);
            onSaved(result);
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={customer ? t("Edit customer details") : t("New customer")} subtitle={customer ? t("Revision v{0} \u00B7 Changes are recorded in the audit history", customer.revision) : t("Start with accurate customer information")} busy={busy} onClose={onClose} wide><form className="dialog-body form-stack product-form" onSubmit={submit}><ErrorBanner error={error}/><div className="product-form-columns"><label>{t("Customer name")}<input required minLength={2} maxLength={160} value={name} onChange={event => setName(event.target.value)} placeholder={t("Company or organization name")}/></label><label>{t("Industry")}<input required maxLength={100} value={industry} onChange={event => setIndustry(event.target.value)} placeholder={t("For example: Manufacturing")}/></label><label>{t("Contact")}<input required maxLength={100} value={contact} onChange={event => setContact(event.target.value)}/></label><label>{t("Contact email")}<input required type="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)}/></label><label>{t("Customer owner")}<select required disabled={!!customer || !manager || !members.data} value={ownerId} onChange={event => setOwnerId(event.target.value)}>{members.data?.filter(member => member.active && (manager || member.id === user.id)).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div><ErrorBanner error={members.error}/>{customer && <><label>{t("Change reason")}<textarea required minLength={3} maxLength={1000} rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder={t("Explain the change to customer details or ownership")}/></label><p className="product-caption">{t("Use Transfer customer to move open opportunities and tasks together. Historical contract attribution is retained.")}</p></>}<div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="button primary" disabled={busy || !members.data}>{busy ? t("Saving\u2026") : customer ? t("Save customer details") : t("Create customer")}</button></div></form></Dialog>;
}
export function CustomerBasics({ customer }: {
    customer: Customer;
}) { useLocale(); const user = useWorkspace().user; const [editing, setEditing] = useState(false); const members = useResource<Member[]>('/members'); return <section className="panel"><div className="panel-heading"><h2>{t("Basic information")}</h2>{user.role !== 'engineer' && <button className="text-button" onClick={() => setEditing(true)}><Pencil size={13}/>{t("Edit")}</button>}</div><div className="panel-body"><dl className="customer-basic-details"><div><dt>{t("Industry")}</dt><dd>{customer.industry}</dd></div><div><dt>{t("Contact")}</dt><dd>{customer.contact}</dd></div><div><dt>{t("Contact email")}</dt><dd>{customer.email}</dd></div><div><dt>{t("Owner")}</dt><dd>{members.data?.find(member => member.id === customer.ownerId)?.name ?? t("Assigned")}</dd></div></dl></div>{editing && <CustomerEditor customer={customer} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }}/>}</section>; }
const factNames: Record<string, string> = localizedLabels({ requirements: "Customer requirements", budget: "Budget information", timeline: "Timeline" });
const factStatuses = localizedLabels({ candidate: "Candidate", confirmed: "Verified", rejected: "Rejected" });
function FactReviewHistory({ fact }: {
    fact: Fact;
}) { useLocale(); const [open, setOpen] = useState(false); const history = useResource<FactReview[]>(open ? `/facts/${fact.id}/reviews` : null); return <details className="fact-review-history" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><History size={13}/>{t("Review history")}<ChevronDown size={13}/></summary><ErrorBanner error={history.error} retry/>{history.loading ? <p>{t("Loading history\u2026")}</p> : history.data?.length ? history.data.map(review => <div key={review.id}><span>{factStatuses[review.fromStatus]} → {factStatuses[review.toStatus]} · {review.actorName} · {dateTime(review.createdAt)}</span><p>{review.note}</p></div>) : <p>{t("No human review has been recorded.")}</p>}</details>; }
function ReviewFact({ fact, status, onClose }: {
    fact: Fact;
    status: 'confirmed' | 'rejected';
    onClose: () => void;
}) {
    useLocale();
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api(`/facts/${fact.id}/review`, 'POST', { expectedRevision: fact.revision, status, note });
            onClose();
            refresh();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={status === 'confirmed' ? t("Verify this customer fact") : t("Reject this customer fact")} subtitle={t("Current revision v{0} \u00B7 Original citations are preserved", fact.revision)} busy={busy} onClose={onClose}><form className="dialog-body form-stack product-form" onSubmit={submit}><ErrorBanner error={error}/><div className="info-note"><p>{fact.value}</p></div><label>{t("Verification note")}<textarea required minLength={3} maxLength={1000} rows={4} value={note} onChange={event => setNote(event.target.value)} placeholder={status === 'confirmed' ? t("Describe how you verified this and the evidence used") : t("Explain why the information is inaccurate or should not be used")}/></label><p className="product-caption">{t("Verification changes only this fact\u2019s status. It does not automatically change customer fields, opportunity amounts or deal outcomes.")}</p><div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="button primary" disabled={busy}>{busy ? t("Submitting\u2026") : status === 'confirmed' ? t("Confirm verified") : t("Confirm rejection")}</button></div></form></Dialog>;
}
export function CustomerFacts({ detail, onEvidence }: {
    detail: CustomerDetail;
    onEvidence: (id: string) => void;
}) {
    useLocale();
    const user = useWorkspace().user;
    const [review, setReview] = useState<{
        fact: Fact;
        status: 'confirmed' | 'rejected';
    } | null>(null);
    return <section className="panel" id="customer-facts"><div className="panel-heading"><h2>{t("Customer understanding and verification")}</h2><Badge>{detail.facts.filter(fact => fact.status === 'candidate').length}{" " + t("awaiting verification")}</Badge></div><div className="panel-body">{detail.facts.length ? detail.facts.map(fact => <article className="fact-review-row" key={fact.id}><div className="between wrap"><span>{factNames[fact.key] ?? detail.fields.find(field => field.key === fact.key)?.label ?? fact.key}</span><Badge tone={fact.status === 'confirmed' ? 'green' : fact.status === 'rejected' ? 'amber' : 'neutral'}>{factStatuses[fact.status]}</Badge></div><strong>{fact.value}</strong><blockquote>“{fact.quote}”</blockquote><button className="text-button" onClick={() => onEvidence(fact.evidenceId)}><FileText size={13}/>{detail.evidence.find(item => item.id === fact.evidenceId)?.title ?? t("View original evidence")}</button>{fact.reviewNote && <p className="product-caption">{t("Latest note:")}{fact.reviewNote}</p>}{user.role !== 'engineer' && <div className="product-actions">{fact.status !== 'rejected' && <button className="button" onClick={() => setReview({ fact, status: 'rejected' })}><X size={14}/>{t("Reject")}</button>}{fact.status !== 'confirmed' && <button className="button" onClick={() => setReview({ fact, status: 'confirmed' })}><Check size={14}/>{t("Confirm verified")}</button>}</div>}<FactReviewHistory fact={fact}/></article>) : <p className="product-caption">{t("No candidate facts yet. After evidence processing, review each fact here with notes and original citations.")}</p>}</div>{review && <ReviewFact fact={review.fact} status={review.status} onClose={() => setReview(null)}/>}</section>;
}
export const runNames: Record<ProductRun['status'], string> = localizedLabels({ queued: "Queued for planning", planning: "Planning", waiting_approval: "Awaiting approval", waiting_reconciliation: "Awaiting reconciliation", completed: "Completed", failed: "Planning failed" });
export function RetryRunDialog({ run, onClose, onRetried }: {
    run: ProductRun;
    onClose: () => void;
    onRetried: (run: ProductRun) => void;
}) {
    useLocale();
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const result = await api<ProductRun>(`/runs/${run.id}/retry`, 'POST', { reason });
            refresh();
            onRetried(result);
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={t("Retry planning")} subtitle={t("Previous attempt #{0} \u00B7 Reuses the same evidence", run.attempt)} busy={busy} onClose={onClose}><form className="dialog-body form-stack product-form" onSubmit={submit}><ErrorBanner error={error}/>{run.error && <div className="info-note amber"><p>{run.error}</p></div>}<label>{t("Retry note")}<textarea required minLength={3} maxLength={1000} rows={4} value={reason} onChange={event => setReason(event.target.value)} placeholder={t("Explain what was fixed and why you are retrying")}/></label><p className="product-caption">{t("A new attempt preserves the previous error record. Repeated submissions for the same failed attempt return its successor without duplicate dispatch.")}</p><div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="button primary" disabled={busy}>{busy ? t("Submitting\u2026") : t("Create retry attempt")}</button></div></form></Dialog>;
}
export function CustomerRuns({ customerId, evidence, onAction, onRun }: {
    customerId: string;
    evidence: CustomerDetail['evidence'];
    onAction: (id: string) => void;
    onRun: (id: string) => void;
}) { useLocale(); const user = useWorkspace().user; const runs = useResource<ProductRun[]>(`/customers/${customerId}/runs`); const [retry, setRetry] = useState<ProductRun | null>(null); useActiveRefresh(Boolean(runs.data?.some(run => ['queued', 'planning'].includes(run.status)))); return <section className="panel" id="customer-runs"><div className="panel-heading"><h2>{t("Planning history") + " "}<span className="count-pill">{runs.data?.length ?? '—'}</span></h2><Badge>{t("Selected workspace models")}</Badge></div><ErrorBanner error={runs.error} retry/>{!runs.data ? <div className="panel-body product-caption">{t("Loading planning runs\u2026")}</div> : runs.data.length ? <div className="planning-run-list">{runs.data.map(run => <article key={run.id} id={`run-${run.id}`}><div className="between"><h3>{evidence.find(item => item.id === run.evidenceId)?.title ?? t("Customer evidence planning")}</h3><Badge tone={run.status === 'failed' ? 'red' : run.status === 'completed' ? 'green' : 'neutral'}>{runNames[run.status]}</Badge></div><div className="run-meta"><span>{t("Attempt #")}{run.attempt}</span><span>{dateTime(run.createdAt)}</span>{run.parentRunId && <span>{t("Retry of a failed run")}</span>}</div>{run.error && <p className="run-failure">{run.error}</p>}{run.retryReason && <p className="run-retry-note">{t("Retry note:")}{run.retryReason}</p>}<div className="product-actions">{run.actionId && <button className="text-button" onClick={() => onAction(run.actionId!)}>{t("View related action")}<ArrowUpRight size={14}/></button>}{run.successorRunId && <button className="text-button" onClick={() => document.getElementById(`run-${run.successorRunId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>{t("View successor attempt")}<ArrowUpRight size={14}/></button>}{run.status === 'failed' && !run.successorRunId && !run.actionId && user.role !== 'engineer' && <button className="button" onClick={() => setRetry(run)}><RotateCcw size={14}/>{t("Explain and retry")}</button>}</div></article>)}</div> : <Empty icon={<History size={24}/>} title={t("No planning runs yet")} description={t("Adding evidence records the planning status, errors and subsequent retry attempts here.")}/>}{retry && <RetryRunDialog run={retry} onClose={() => setRetry(null)} onRetried={run => { setRetry(null); onRun(run.id); }}/>}</section>; }
