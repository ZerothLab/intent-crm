import { t, useLocale } from './i18n';
import { money } from './commercial/shared';
import { amountToCents } from './commercial/money';
import { useState, type FormEvent } from 'react';
import type { Customer, DeliverySettings, IntentAction, Member, ModelConnection, OpportunityDetail, OpportunityTask, RuntimeDiagnostics } from '@intent/contracts';
import { api, errorText, refresh, useResource } from './api';
import { dateTime, Badge, Dialog, ErrorBanner, Loading, PageHeading, SaveNote } from './components';
import { useWorkspace } from './workspace';
export function ModelSettings() {
    useLocale();
    const resource = useResource<ModelConnection[]>('/models');
    const admin = useWorkspace().user.role === 'admin';
    const [editing, setEditing] = useState<ModelConnection | 'new' | null>(null);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [saved, setSaved] = useState('');
    async function change(model: ModelConnection, test = false) {
        setBusy(model.id);
        setError('');
        setSaved('');
        try {
            const result = await api<ModelConnection>(`/models/${model.id}${test ? '/test' : ''}`, test ? 'POST' : 'PATCH', test ? { expectedRevision: model.revision } : { enabled: !model.enabled, expectedRevision: model.revision });
            refresh();
            if (result.testError && test)
                setError(result.testError);
            else
                setSaved(test ? t("Connection verified. You can now enable this model.") : t("Model selection saved."));
        }
        catch (e) {
            setError(errorText(e));
        }
        finally {
            setBusy('');
        }
    }
    if (!resource.data)
        return <Loading error={resource.error}/>;
    return <><PageHeading eyebrow={t("WORKSPACE SETTINGS")} title={t("Model settings")} description={t("Connect DeepSeek or an OpenAI-compatible service, verify access, and choose the models that power Intent.")}>{admin && <button className="button primary" onClick={() => setEditing('new')}>{t("Add model")}</button>}</PageHeading><ErrorBanner error={error || resource.error}/><SaveNote>{saved}</SaveNote><div className="info-note"><p>{t("One model can be active for each purpose. Reasoning powers conversations and proposals; extraction produces evidence-backed candidate facts. Demo models use fixed rules. Connection tests send a short request and may incur provider charges.")}</p></div><div className="model-grid">{resource.data.map(model => <article className="panel model-card" key={model.id}><div className="between"><Badge tone={model.enabled ? 'green' : 'neutral'}>{model.enabled ? t("Active") : t("Inactive")}</Badge><Badge>{model.provider === 'fixture' ? t("Deterministic demo") : model.provider === 'deepseek' ? 'DeepSeek' : t("OpenAI compatible")}</Badge></div><h2>{model.name}</h2><p>{model.purpose === 'reasoning' ? t("Reasoning and conversations") : t("Evidence extraction")}</p><div className="model-properties"><div><span>{t("Model")}</span><code>{model.model}</code></div><div><span>{t("Endpoint")}</span><span>{model.baseUrl ?? t("Built-in demo")}</span></div><div><span>{t("Credential")}</span><span>{model.provider === 'fixture' ? t("Not required") : model.hasApiKey ? t("Saved securely") : t("Missing")}</span></div><div><span>{t("Connection")}</span><span>{model.provider === 'fixture' ? t("Local") : model.testedRevision === model.revision && !model.testError ? t("Verified") : t("Not verified")}</span></div></div>{model.testError && <ErrorBanner error={model.testError}/>} {admin && <div className="product-actions"><button className="button" disabled={!!busy} onClick={() => setEditing(model)}>{t("Configure")}</button><button className="button" disabled={!!busy} onClick={() => void change(model, true)}>{busy === model.id ? t("Working\u2026") : t("Test connection")}</button><button className="button primary" disabled={!!busy || !model.enabled && model.provider !== 'fixture' && (model.testedRevision !== model.revision || !!model.testError)} onClick={() => void change(model)}>{model.enabled ? t("Disable") : t("Enable")}</button></div>}</article>)}</div>{editing && <ModelEditor model={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setSaved(t("Configuration saved. Test the connection before enabling it.")); refresh(); }}/>}</>;
}
function ModelEditor({ model, onClose, onSaved }: {
    model: ModelConnection | 'new';
    onClose: () => void;
    onSaved: () => void;
}) {
    useLocale();
    const old = model === 'new' ? null : model;
    const [name, setName] = useState(old?.name ?? '');
    const [provider, setProvider] = useState<ModelConnection['provider']>(old?.provider ?? 'deepseek');
    const [modelId, setModelId] = useState(old?.model ?? 'deepseek-flash');
    const [baseUrl, setBaseUrl] = useState(old?.baseUrl ?? 'https://api.deepseek.com');
    const [purpose, setPurpose] = useState<ModelConnection['purpose']>(old?.purpose ?? 'reasoning');
    const [apiKey, setApiKey] = useState('');
    const [timeoutMs, setTimeoutMs] = useState(old?.timeoutMs ?? 30000);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api(`/models${old ? `/${old.id}/configuration` : ''}`, old ? 'PATCH' : 'POST', { name, provider, model: modelId, purpose, baseUrl: provider === 'fixture' ? null : baseUrl, timeoutMs, ...(apiKey ? { apiKey } : {}), ...(old ? { expectedRevision: old.revision } : {}) });
            setApiKey('');
            onSaved();
        }
        catch (e) {
            setError(errorText(e));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={old ? t("Configure model") : t("Add model")} subtitle={t("Changes disable this connection until its current settings are verified and enabled.")} onClose={onClose} busy={busy} wide><form className="dialog-body form-stack model-config-form" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Name")}<input required maxLength={100} value={name} onChange={e => setName(e.target.value)}/></label><label>{t("Provider")}<select value={provider} onChange={e => {
            const p = e.target.value as ModelConnection['provider'];
            setProvider(p);
            setApiKey('');
            if (p === 'deepseek') {
                setBaseUrl('https://api.deepseek.com');
                setModelId('deepseek-flash');
            }
            if (p === 'fixture')
                setModelId('fixture-v1');
        }}><option value="deepseek">DeepSeek</option><option value="openai-compatible">{t("Custom OpenAI-compatible API")}</option><option value="fixture">{t("Deterministic demo")}</option></select></label><label>{t("Purpose")}<select value={purpose} onChange={e => setPurpose(e.target.value as ModelConnection['purpose'])}><option value="reasoning">{t("Reasoning and conversations")}</option><option value="extraction">{t("Evidence extraction")}</option></select></label><label>{t("Model identifier")}<input required maxLength={160} readOnly={provider === 'fixture'} value={modelId} onChange={e => setModelId(e.target.value)}/></label>{provider !== 'fixture' && <><label>{t("Base URL")}<input type="url" required readOnly={provider === 'deepseek'} value={baseUrl} onChange={e => setBaseUrl(e.target.value)}/><span className="field-help">{t("Use the API base URL, including /v1 if required. The hostname must be approved by your deployment administrator.")}</span></label><label>{t("API key")}<input type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={old?.hasApiKey ? t("Leave blank to keep the saved credential") : t("Enter your provider credential")}/></label><label>{t("Timeout (seconds)")}<input type="number" required min={1} max={45} value={timeoutMs / 1000} onChange={e => setTimeoutMs(Number(e.target.value) * 1000)}/></label></>}<div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="button primary" disabled={busy}>{busy ? t("Saving\u2026") : t("Save configuration")}</button></div></form></Dialog>;
}
export function ReasonCommand({ label, path, revision, description, onSaved }: {
    label: string;
    path: string;
    revision?: number;
    description: string;
    onSaved?: () => void;
}) {
    useLocale();
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api(path, 'POST', { expectedRevision: revision, note });
            setOpen(false);
            setNote('');
            refresh();
            onSaved?.();
        }
        catch (err) {
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    }
    return <><button className="button" onClick={() => setOpen(true)}>{label}</button>{open && <Dialog title={label} subtitle={description} onClose={() => setOpen(false)} busy={busy}><form className="dialog-body form-stack" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Reason")}<textarea required minLength={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)}/></label><div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={() => setOpen(false)}>{t("Back")}</button><button className="button primary" disabled={busy}>{busy ? t("Saving\u2026") : label}</button></div></form></Dialog>}</>;
}
export function ActionResolution({ action }: {
    action: IntentAction;
}) {
    useLocale();
    const role = useWorkspace().user.role;
    if (role === 'engineer' || !['draft', 'approved', 'failed'].includes(action.status))
        return null;
    return <div className="product-actions"><ReasonCommand label={t("Cancel action")} path={`/actions/${action.id}/cancel`} revision={action.revision} description={t("Close this action and its open commitment without dispatching. The reason is retained in the audit history.")}/>{['admin', 'manager'].includes(role) && <ReasonCommand label={t("Take responsibility")} path={`/actions/${action.id}/takeover`} revision={action.revision} description={t("Accept responsibility for execution. Existing approval is cleared, and the new revision must be reviewed and approved.")}/>}</div>;
}
export function CustomerHandover({ customer }: {
    customer: Customer;
}) {
    useLocale();
    const role = useWorkspace().user.role;
    const members = useResource<Member[]>(['admin', 'manager'].includes(role) ? '/members' : null);
    const [open, setOpen] = useState(false);
    const [ownerId, setOwnerId] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    if (!['admin', 'manager'].includes(role))
        return null;
    async function submit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api(`/customers/${customer.id}/handover`, 'POST', { expectedRevision: customer.revision, ownerId, note });
            setOpen(false);
            refresh();
        }
        catch (err) {
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    }
    return <><button className="button" onClick={() => setOpen(true)}>{t("Transfer customer")}</button>{open && <Dialog title={t("Transfer customer")} subtitle={t("Open opportunities and tasks move together. Pending action approvals are cleared. Historical contract ownership is retained.")} busy={busy} onClose={() => setOpen(false)}><form className="dialog-body form-stack" onSubmit={submit}><ErrorBanner error={error || members.error}/><label>{t("New owner")}<select required value={ownerId} onChange={e => setOwnerId(e.target.value)}><option value="">{t("Select a member")}</option>{members.data?.filter(m => m.active && m.role !== 'engineer' && m.id !== customer.ownerId).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>{t("Handover note")}<textarea required minLength={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)}/></label><div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={() => setOpen(false)}>{t("Cancel")}</button><button className="button primary" disabled={busy}>{t("Transfer responsibility")}</button></div></form></Dialog>}</>;
}
export function TaskManagement({ task, members }: {
    task: OpportunityTask;
    members: Member[];
}) {
    useLocale();
    const [open, setOpen] = useState(false);
    const [assigneeId, setAssigneeId] = useState(task.assigneeId);
    const [dueDate, setDueDate] = useState(task.dueDate);
    const [status, setStatus] = useState<'open' | 'cancelled'>('open');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api(`/opportunity-tasks/${task.id}`, 'PATCH', { expectedRevision: task.revision, assigneeId, dueDate, status, note });
            setOpen(false);
            refresh();
        }
        catch (err) {
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    }
    return <><button className="text-button" onClick={() => setOpen(true)}>{t("Manage task")}</button>{open && <Dialog title={t("Manage task")} subtitle={t("Reassign, reschedule, reopen or cancel this task. Previous results remain in the audit history.")} busy={busy} onClose={() => setOpen(false)}><form className="dialog-body form-stack" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Assignee")}<select required value={assigneeId} onChange={e => setAssigneeId(e.target.value)}>{members.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label><label>{t("Due date")}<input required type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}/></label><label>{t("Status")}<select value={status} onChange={e => setStatus(e.target.value as 'open' | 'cancelled')}><option value="open">{t("Open")}</option><option value="cancelled">{t("Cancelled")}</option></select></label><label>{t("Reason")}<textarea required minLength={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)}/></label><button className="button primary" disabled={busy}>{t("Save task")}</button></form></Dialog>}</>;
}
export function FinancialCorrections({ detail }: {
    detail: OpportunityDetail;
}) {
    useLocale();
    const manager = ['admin', 'manager'].includes(useWorkspace().user.role);
    const [target, setTarget] = useState<{
        id: string;
        kind: 'contracts' | 'payments' | 'refunds';
    } | null>(null);
    const [evidenceId, setEvidenceId] = useState('');
    const [note, setNote] = useState('');
    const [requestId, setRequestId] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!target)
            return;
        setBusy(true);
        setError('');
        try {
            await api(`/${target.kind}/${target.id}/${target.kind === 'contracts' ? 'cancel' : 'reverse'}`, 'POST', { requestId, evidenceId, note });
            setTarget(null);
            refresh();
        }
        catch (err) {
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    }
    function select(value: NonNullable<typeof target>) { setTarget(value); setRequestId(crypto.randomUUID()); setNote(''); setEvidenceId(''); setError(''); }
    return <section className="panel"><div className="panel-heading"><h2>{t("Financial corrections and refunds")}</h2></div><div className="panel-body form-stack"><p>{t("Corrections retain original records and require supporting customer evidence. They update current totals; saved forecast snapshots remain unchanged. Reversing a record does not transfer money.")}</p>{manager && detail.contract && <button className="button" onClick={() => select({ id: detail.contract!.id, kind: 'contracts' })}>{t("Cancel contract registration")}</button>}{detail.payments.map(payment => <div className="between wrap" key={payment.id}><span>{payment.reference} · {payment.reversedAt ? t("Reversed") : t("Recorded")}</span>{manager && !payment.reversedAt && <button className="text-button" onClick={() => select({ id: payment.id, kind: 'payments' })}>{t("Reverse payment record")}</button>}</div>)}{manager && detail.payments.some(p=>!p.reversedAt) && <RefundForm detail={detail}/>} {detail.refunds?.map(refund=><div className="between wrap" key={refund.id}><span>{t("Refund")} · {refund.reference} · {money(refund.amountCents)} · {refund.refundedDate} · {refund.reversedAt?t("Reversed"):t("Recorded")}</span>{manager&&!refund.reversedAt&&<button className="text-button" onClick={()=>select({id:refund.id,kind:'refunds'})}>{t("Reverse refund record")}</button>}</div>)}{detail.cancelledContracts?.map(contract => <p key={contract.id}>{contract.reference}{t("\u00B7 Cancelled contract")}</p>)}{detail.corrections?.map(correction => <blockquote key={correction.id}>{correction.note}<span> · {dateTime(correction.createdAt)}</span></blockquote>)}</div>{target && <Dialog title={target.kind === 'contracts' ? t("Cancel contract registration") : target.kind==='refunds'?t("Reverse refund record"):t("Reverse payment record")} subtitle={t("This preserves the original entry and creates an auditable correction. Active payments must be fully refunded or corrected before a contract can be cancelled.")} busy={busy} onClose={() => setTarget(null)}><form className="dialog-body form-stack" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Supporting evidence")}<select required value={evidenceId} onChange={e => { setEvidenceId(e.target.value); setRequestId(crypto.randomUUID()); }}><option value="">{t("Select evidence")}</option>{detail.evidence.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}</select></label><label>{t("Reason")}<textarea required minLength={3} maxLength={1000} value={note} onChange={e => { setNote(e.target.value); setRequestId(crypto.randomUUID()); }}/></label><button className="button primary" disabled={busy}>{t("Record correction")}</button></form></Dialog>}</section>;
}
function RefundForm({detail}:{detail:OpportunityDetail}) {
    useLocale();
    const [open,setOpen]=useState(false);
    const [paymentId,setPaymentId]=useState('');
    const [amount,setAmount]=useState('');
    const [refundedDate,setDate]=useState('');
    const [reference,setReference]=useState('');
    const [evidenceId,setEvidence]=useState('');
    const [note,setNote]=useState('');
    const [requestId,setRequestId]=useState(crypto.randomUUID());
    const [error,setError]=useState('');
    const [busy,setBusy]=useState(false);
    async function submit(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{await api(`/payments/${paymentId}/refunds`,'POST',{requestId,amountCents:amountToCents(amount),refundedDate,reference,evidenceId,note});setOpen(false);setAmount('');setReference('');setNote('');setRequestId(crypto.randomUUID());refresh();}catch(e){setError(errorText(e));}finally{setBusy(false);}}
    return <><button className="button" onClick={()=>setOpen(true)}>{t("Record refund")}</button>{open&&<Dialog title={t("Record refund")} subtitle={t("Record a refund that has already occurred. Intent does not transfer money. Refunds reduce net collections and reopen the installment balance.")} onClose={()=>setOpen(false)} busy={busy}><form className="dialog-body form-stack" onSubmit={submit} onChange={()=>setRequestId(crypto.randomUUID())}><ErrorBanner error={error}/><label>{t("Original payment")}<select required value={paymentId} onChange={e=>setPaymentId(e.target.value)}><option value="">{t("Select payment")}</option>{detail.payments.filter(p=>!p.reversedAt).map(p=><option value={p.id} key={p.id}>{p.reference} · {money(p.amountCents)}</option>)}</select></label><label>{t("Refund amount (CNY)")}<input required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></label><label>{t("Refund date")}<input type="date" required value={refundedDate} onChange={e=>setDate(e.target.value)}/></label><label>{t("Refund reference")}<input required minLength={3} maxLength={200} value={reference} onChange={e=>setReference(e.target.value)}/></label><label>{t("Supporting evidence")}<select required value={evidenceId} onChange={e=>setEvidence(e.target.value)}><option value="">{t("Select evidence")}</option>{detail.evidence.map(e=><option value={e.id} key={e.id}>{e.title}</option>)}</select></label><label>{t("Reason")}<textarea required minLength={3} maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></label><button className="button primary" disabled={busy}>{t("Record refund")}</button></form></Dialog>}</>;
}
export function OperationsSettings() {
    useLocale();
    const admin = useWorkspace().user.role === 'admin';
    const runtime = useResource<RuntimeDiagnostics>(admin ? '/settings/runtime' : null, 10000);
    const delivery = useResource<DeliverySettings>(admin ? '/settings/delivery' : null);
    const [editing, setEditing] = useState(false);
    const [runId, setRunId] = useState('');
    const [note, setNote] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    if (!admin)
        return <ErrorBanner error={t("Workspace administrator permission is required.")}/>;
    async function recover(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api('/settings/runtime/recover', 'POST', { runId, note });
            setRunId('');
            setNote('');
            refresh();
        }
        catch (err) {
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    }
    return <><PageHeading eyebrow={t("WORKSPACE SETTINGS")} title={t("Delivery and runtime")} description={t("Configure customer delivery and inspect execution health.")}/><ErrorBanner error={error || runtime.error || delivery.error}/>{runtime.data && <section className="panel"><div className="panel-heading"><h2>{t("Execution health")}</h2><Badge tone={runtime.data.worker === 'healthy' ? 'green' : 'amber'}>{runtime.data.worker === 'healthy' ? t("Worker connected") : t("Worker unavailable")}</Badge></div><div className="panel-body form-stack"><p>{t("Database:")}{t('Healthy')}{t("\u00B7 Pending events:")}{runtime.data.pendingEvents}{t("\u00B7 Stalled planning runs:")}{runtime.data.stalledRuns}{t("\u00B7 Uncertain or executing actions:")}{runtime.data.uncertainActions}</p><p>{t("Last worker heartbeat:")}{runtime.data.lastHeartbeat ? dateTime(runtime.data.lastHeartbeat) : t("None")}</p><form onSubmit={recover} className="form-stack"><label>{t("Stalled planning run ID")}<select required value={runId} onChange={e => setRunId(e.target.value)}><option value="">{t("Select stalled run")}</option>{runtime.data?.stalledItems.map(item=><option key={item.id} value={item.id}>{item.customerName} · {item.id}</option>)}</select></label><label>{t("Recovery reason")}<input required minLength={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)}/></label><p>{t("Recovery creates a new attempt only when planning has been stalled for five minutes and no action exists. It cannot redispatch an uncertain delivery.")}</p><button className="button" disabled={busy||!runtime.data.stalledItems.length}>{t("Recover planning run")}</button></form></div></section>}{delivery.data && <section className="panel"><div className="panel-heading"><h2>{t("Customer delivery")}</h2><Badge>{delivery.data.mode === 'simulated' ? t("Simulated delivery") : t("Real gateway delivery")}</Badge></div><div className="panel-body form-stack"><p>{delivery.data.endpoint ?? t("No external messages are sent in simulated mode.")}</p><button className="button" onClick={() => setEditing(true)}>{t("Configure delivery")}</button></div></section>}{editing && delivery.data && <DeliveryEditor initial={delivery.data} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }}/>}</>;
}
function DeliveryEditor({ initial, onClose, onSaved }: {
    initial: DeliverySettings;
    onClose: () => void;
    onSaved: () => void;
}) {
    useLocale();
    const [mode, setMode] = useState(initial.mode);
    const [endpoint, setEndpoint] = useState(initial.endpoint ?? '');
    const [sender, setSender] = useState(initial.sender ?? '');
    const [apiKey, setApiKey] = useState('');
    const [webhookSecret, setWebhookSecret] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api('/settings/delivery', 'PATCH', { expectedRevision: initial.revision, mode, endpoint: mode === 'webhook' ? endpoint : null, sender: mode === 'webhook' ? sender : null, ...(apiKey ? { apiKey } : {}), ...(webhookSecret ? { webhookSecret } : {}) });
            setApiKey('');
            setWebhookSecret('');
            onSaved();
        }
        catch (err) {
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={t("Configure customer delivery")} subtitle={t("Real gateway mode sends approved messages to your configured service. Changing these settings invalidates pending execution approvals.")} busy={busy} onClose={onClose}><form className="dialog-body form-stack" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Delivery mode")}<select value={mode} onChange={e => setMode(e.target.value as DeliverySettings['mode'])}><option value="simulated">{t("Simulated delivery")}</option><option value="webhook">{t("Real delivery gateway")}</option></select></label>{mode === 'webhook' && <><label>{t("Gateway endpoint")}<input required type="url" value={endpoint} onChange={e => setEndpoint(e.target.value)}/></label><label>{t("Sender email")}<input required type="email" value={sender} onChange={e => setSender(e.target.value)}/></label><label>{t("Gateway credential")}<input type="password" autoComplete="new-password" minLength={16} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={t("Leave blank to keep the saved credential")}/></label><label>{t("Webhook signing secret")}<input type="password" autoComplete="new-password" minLength={32} value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} placeholder={t("At least 32 characters")}/></label><p>{t("The deployment administrator must approve the gateway hostname. Your gateway must implement the documented delivery and signed-event contract.")}</p></>}<button className="button primary" disabled={busy}>{t("Save delivery settings")}</button></form></Dialog>;
}
