import { t, useLocale } from '../i18n';
import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Customer, CustomerDetail, ForecastCategory, Member, Opportunity, OpportunityDetail, OpportunityStage, OpportunityTask, Receivable, SalesTarget } from '@intent/contracts';
import { api, errorText, useResource } from '../api';
import { Dialog, ErrorBanner, Loading } from '../components';
import { useWorkspace } from '../workspace';
import { amountToCents } from './money';
import { dateLabel, forecastDescriptions, forecastNames, money, moneyInput, openStages, periodName, stageNames, today } from './shared';
function FormButtons({ busy, onClose, label = t('Save') }: {
    busy: boolean;
    onClose: () => void;
    label?: string;
}) { useLocale(); return <div className="dialog-footer"><button className="button" type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="button primary" disabled={busy}>{busy ? t("Saving\u2026") : label}</button></div>; }
function AmountInput({ label, value, onChange, required = true }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    required?: boolean;
}) { useLocale(); return <label>{label}<div className="amount-input"><span>¥</span><input type="text" inputMode="decimal" required={required} maxLength={16} pattern="(?:0|[1-9][0-9]*)(?:[.][0-9]{1,2})?" title={t("CNY, up to two decimal places")} placeholder="0.00" value={value} onChange={event => onChange(event.target.value)}/><span>{t("CNY")}</span></div></label>; }
export function OpportunityEditor({ opportunity, initialCustomer, onClose, onSaved }: {
    opportunity?: Opportunity;
    initialCustomer?: string;
    onClose: () => void;
    onSaved: (opportunity: Opportunity) => void;
}) {
    useLocale();
    const user = useWorkspace().user;
    const members = useResource<Member[]>('/members');
    const customers = useResource<Customer[]>('/customers');
    const [customerId, setCustomerId] = useState(opportunity?.customerId ?? initialCustomer ?? '');
    const detail = useResource<CustomerDetail>(customerId ? `/customers/${customerId}` : null);
    const [title, setTitle] = useState(opportunity?.title ?? '');
    const [ownerId, setOwnerId] = useState(opportunity?.ownerId ?? user.id);
    const [amount, setAmount] = useState(opportunity ? moneyInput(opportunity.amountCents) : '');
    const [closeDate, setCloseDate] = useState(opportunity?.expectedCloseDate ?? today());
    const [stage, setStage] = useState<OpportunityStage>(opportunity?.stage ?? 'discovery');
    const [forecast, setForecast] = useState<ForecastCategory>(opportunity?.forecastCategory ?? 'pipeline');
    const [nextStep, setNextStep] = useState(opportunity?.nextStep ?? '');
    const [dueDate, setDueDate] = useState(opportunity?.nextStepDueDate ?? '');
    const [evidenceId, setEvidenceId] = useState(opportunity?.evidenceId ?? '');
    const [lostReason, setLostReason] = useState(opportunity?.lostReason ?? '');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const managers = ['admin', 'manager'].includes(user.role);
    async function submit(event: FormEvent) {
        event.preventDefault();
        setError('');
        setBusy(true);
        try {
            const fields = { title, customerId, ownerId, amountCents: amountToCents(amount), expectedCloseDate: closeDate, stage, forecastCategory: forecast, nextStep, nextStepDueDate: dueDate || null, evidenceId: evidenceId || null, lostReason: stage === 'lost' ? lostReason : null };
            const result = await api<Opportunity>(`/opportunities${opportunity ? `/${opportunity.id}` : ''}`, opportunity ? 'PATCH' : 'POST', opportunity ? { ...fields, expectedRevision: opportunity.revision, note } : fields);
            onSaved(result);
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={opportunity ? t("Update opportunity") : t("Create opportunity")} subtitle={opportunity ? t("Current revision v{0} \u00B7 Every change retains its history", opportunity.revision) : t("A customer can have multiple independent opportunities")} busy={busy} onClose={onClose} wide><form className="dialog-body form-stack commercial-form" onSubmit={submit}><ErrorBanner error={error}/>{!customers.data || !members.data ? <Loading error={customers.error ?? members.error}/> : <>
    <label>{t("Opportunity name")}<input required minLength={2} maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder={t("For example: Blue Ocean Manufacturing \u00B7 CRM phase one")}/></label>
    <div className="commercial-form-grid"><label>{t("Related customer")}<select required disabled={Boolean(opportunity)} value={customerId} onChange={event => {
                setCustomerId(event.target.value);
                setEvidenceId('');
                if (managers)
                    setOwnerId(user.id);
            }}><option value="">{t("Select customer")}</option>{customers.data.map(customer => <option value={customer.id} key={customer.id}>{customer.name}</option>)}</select></label><label>{t("Opportunity owner")}<select required disabled={!managers} value={ownerId} onChange={event => setOwnerId(event.target.value)}>{members.data.filter(member => member.active && member.role !== 'engineer' && (managers ? ['admin', 'manager'].includes(member.role) || member.id === detail.data?.customer.ownerId : member.id === user.id)).map(member => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label><AmountInput label={t("Expected contract amount")} value={amount} onChange={setAmount}/><label>{t("Expected close date")}<input required type="date" value={closeDate} onChange={event => setCloseDate(event.target.value)}/></label><label>{t("Opportunity stage")}<select value={stage} onChange={event => setStage(event.target.value as OpportunityStage)}>{[...openStages, ...(opportunity ? ['lost' as const] : [])].map(value => <option value={value} key={value}>{stageNames[value]}</option>)}</select></label><label>{t("Forecast category")}<select value={forecast} onChange={event => setForecast(event.target.value as ForecastCategory)}>{Object.entries(forecastNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
    <p className="form-explanation">{forecastDescriptions[forecast]}{t(". Only contract registration marks the opportunity as won. Email delivery does not change its stage.")}</p>
    <div className="commercial-form-grid"><label>{t("Next action")}<textarea rows={3} maxLength={500} value={nextStep} onChange={event => setNextStep(event.target.value)} placeholder={t("Describe the outcome and who needs to help")}/></label><label>{t("Next-step deadline")}<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)}/><span className="field-help">{t("Missing next steps or deadlines appear in the management risk list.")}</span></label></div>
    <label>{t("Source evidence")}<select value={evidenceId} disabled={!customerId || detail.loading} onChange={event => setEvidenceId(event.target.value)}><option value="">{t("Do not link evidence yet")}</option>{detail.data?.evidence.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select><span className="field-help">{t("Only the selected customer\u2019s original evidence is shown. Missing evidence remains a risk flag.")}</span></label><ErrorBanner error={detail.error}/>
    {stage === 'lost' && <label>{t("Loss reason")}<textarea required minLength={3} maxLength={500} rows={3} value={lostReason} onChange={event => setLostReason(event.target.value)} placeholder={t("Explain why this opportunity is being closed")}/></label>}
    {opportunity && <label>{t("Change note")}<textarea required minLength={3} maxLength={1000} rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder={t("Describe the evidence behind amount, stage or date changes")}/></label>}
    <FormButtons busy={busy} onClose={onClose} label={opportunity ? t("Save opportunity changes") : t("Create opportunity")}/></>}</form></Dialog>;
}
export function TargetEditor({ period, ownerId, ownerName, target, onClose, onSaved }: {
    period: string;
    ownerId: string | null;
    ownerName: string;
    target: SalesTarget | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    useLocale();
    const [bookings, setBookings] = useState(target ? moneyInput(target.bookingsTargetCents) : '');
    const [collections, setCollections] = useState(target ? moneyInput(target.collectionTargetCents) : '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api('/management/targets', 'POST', { period, ownerId, bookingsTargetCents: amountToCents(bookings), collectionTargetCents: amountToCents(collections), expectedRevision: target?.revision ?? 0 });
            onSaved();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={t("Set monthly targets")} subtitle={`${periodName(period)} · ${ownerName}`} busy={busy} onClose={onClose}><form className="dialog-body form-stack commercial-form" onSubmit={submit}><ErrorBanner error={error}/><AmountInput label={t("Bookings target")} value={bookings} onChange={setBookings}/><AmountInput label={t("Collections target")} value={collections} onChange={setCollections}/><p className="form-explanation">{t("Targets apply to the selected month and owner. Workspace and individual targets are maintained separately.")}</p><FormButtons busy={busy} onClose={onClose} label={t("Save targets")}/></form></Dialog>;
}
export function ContractEditor({ opportunity, onClose, onSaved }: {
    opportunity: Opportunity;
    onClose: () => void;
    onSaved: () => void;
}) {
    useLocale();
    const [amount, setAmount] = useState(moneyInput(opportunity.amountCents));
    const [signedDate, setSignedDate] = useState(today());
    const [reference, setReference] = useState('');
    const [installments, setInstallments] = useState([{ dueDate: today(), amount: moneyInput(opportunity.amountCents) }]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    let allocation: string;
    try {
        const total = installments.reduce((sum, item) => sum + amountToCents(item.amount), 0);
        const difference = amountToCents(amount) - total;
        allocation = difference === 0 ? t("Installments match the contract amount") : `${difference > 0 ? t("Remaining to allocate") : t("Overallocated")} ${money(Math.abs(difference))}`;
    }
    catch {
        allocation = t("Enter the contract amount and each installment");
    }
    function changeInstallment(index: number, field: 'dueDate' | 'amount', value: string) { setInstallments(previous => previous.map((item, i) => i === index ? { ...item, [field]: value } : item)); }
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const amountCents = amountToCents(amount);
            const rows = installments.map(item => ({ dueDate: item.dueDate, amountCents: amountToCents(item.amount) }));
            if (rows.reduce((sum, item) => sum + item.amountCents, 0) !== amountCents)
                throw new Error(t("Installments must add up to the contract amount."));
            await api(`/opportunities/${opportunity.id}/contract`, 'POST', { expectedRevision: opportunity.revision, amountCents, signedDate, reference, installments: rows });
            onSaved();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={t("Register signed contract")} subtitle={opportunity.title} busy={busy} onClose={onClose} wide><form className="dialog-body form-stack commercial-form" onSubmit={submit}><ErrorBanner error={error}/><div className="commercial-form-grid"><label>{t("Contract reference")}<input required minLength={3} maxLength={180} value={reference} onChange={event => setReference(event.target.value)} placeholder={t("A unique contract reference within this workspace")}/></label><label>{t("Signing date")}<input required type="date" max={today()} value={signedDate} onChange={event => setSignedDate(event.target.value)}/></label><AmountInput label={t("Signed contract amount")} value={amount} onChange={setAmount}/></div><div className="commercial-form-section"><div className="between"><h3>{t("Installment schedule")}</h3><span>{installments.length}{" " + t("/ 24 installments")}</span></div>{installments.map((item, index) => <div className="installment-input" key={index}><span className="installment-number">{index + 1}</span><label>{t("Due date")}<input required type="date" min={signedDate} value={item.dueDate} onChange={event => changeInstallment(index, 'dueDate', event.target.value)}/></label><AmountInput label={t("Installment amount")} value={item.amount} onChange={value => changeInstallment(index, 'amount', value)}/><button type="button" className="icon-button" aria-label={t("Remove installment {0}", index + 1)} disabled={installments.length === 1} onClick={() => setInstallments(previous => previous.filter((_, i) => i !== index))}><Trash2 size={16}/></button></div>)}<div className="between wrap"><button type="button" className="text-button" disabled={installments.length >= 24} onClick={() => setInstallments(previous => [...previous, { dueDate: signedDate, amount: '' }])}><Plus size={15}/>{t("Add installment")}</button><span className="allocation-note">{allocation}</span></div></div><div className="info-note"><p>{t("Registration marks the opportunity as won and sets its amount to the signed contract value. Historical ownership is assigned to") + " "}{opportunity.ownerName}{t(". Check the details before saving. This is a business record, not financial reconciliation; corrections require evidence.")}</p></div><FormButtons busy={busy} onClose={onClose} label={t("Confirm contract registration")}/></form></Dialog>;
}
export function PaymentEditor({ receivable, detail, onClose, onSaved }: {
    receivable: Receivable;
    detail: OpportunityDetail;
    onClose: () => void;
    onSaved: () => void;
}) {
    useLocale();
    const [amount, setAmount] = useState(moneyInput(receivable.remainingCents));
    const [paidDate, setPaidDate] = useState(today());
    const [reference, setReference] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const amountCents = amountToCents(amount);
            if (amountCents > receivable.remainingCents)
                throw new Error(t("The payment cannot exceed the remaining installment balance."));
            await api(`/receivables/${receivable.id}/payments`, 'POST', { amountCents, paidDate, reference });
            onSaved();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={t("Record received payment")} subtitle={t("Due {0} \u00B7 Remaining {1}", dateLabel(receivable.dueDate), money(receivable.remainingCents))} busy={busy} onClose={onClose}><form className="dialog-body form-stack commercial-form" onSubmit={submit}><ErrorBanner error={error}/><AmountInput label={t("Amount received")} value={amount} onChange={setAmount}/><label>{t("Payment date")}<input required type="date" min={detail.contract?.signedDate} max={today()} value={paidDate} onChange={event => setPaidDate(event.target.value)}/></label><label>{t("Payment reference")}<input required minLength={3} maxLength={180} value={reference} onChange={event => setReference(event.target.value)} placeholder={t("A unique payment evidence reference within this workspace")}/></label><p className="form-explanation">{t("Record payments from actual evidence. Identical submissions with the same reference return the original record. Evidence-backed corrections remain auditable.")}</p><FormButtons busy={busy} onClose={onClose} label={t("Confirm payment record")}/></form></Dialog>;
}
export function TaskEditor({ opportunity, members, onClose, onSaved }: {
    opportunity: Opportunity;
    members: Member[];
    onClose: () => void;
    onSaved: () => void;
}) {
    useLocale();
    const [title, setTitle] = useState('');
    const [assigneeId, setAssigneeId] = useState(members.find(member => member.id === opportunity.ownerId)?.id ?? members[0]?.id ?? '');
    const [dueDate, setDueDate] = useState(today());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api(`/opportunities/${opportunity.id}/tasks`, 'POST', { title, assigneeId, dueDate });
            onSaved();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={t("Create intervention task")} subtitle={opportunity.title} busy={busy} onClose={onClose}><form className="dialog-body form-stack commercial-form" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Task to complete")}<textarea required minLength={3} maxLength={200} rows={3} value={title} onChange={event => setTitle(event.target.value)} placeholder={t("For example: Coordinate a technical review of the proposal")}/></label><label>{t("Owner")}<select required value={assigneeId} onChange={event => setAssigneeId(event.target.value)}>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select><span className="field-help">{t("Only active members with customer access are shown.")}</span></label><label>{t("Completion deadline")}<input required type="date" value={dueDate} onChange={event => setDueDate(event.target.value)}/></label><FormButtons busy={busy} onClose={onClose} label={t("Create task")}/></form></Dialog>;
}
export function TaskCompletion({ task, onClose, onSaved }: {
    task: OpportunityTask;
    onClose: () => void;
    onSaved: () => void;
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
            await api(`/opportunity-tasks/${task.id}/complete`, 'POST', { expectedRevision: task.revision, completionNote: note });
            onSaved();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={t("Complete intervention task")} subtitle={task.title} busy={busy} onClose={onClose}><form className="dialog-body form-stack commercial-form" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Completion result")}<textarea required minLength={3} maxLength={1000} rows={5} value={note} onChange={event => setNote(event.target.value)} placeholder={t("Record what was completed, the outcome and supporting evidence")}/></label><p className="form-explanation">{t("Completion results are retained. Deal status and risk are determined by actual business records.")}</p><FormButtons busy={busy} onClose={onClose} label={t("Confirm completion")}/></form></Dialog>;
}
