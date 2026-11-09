import { t, useLocale } from '../i18n';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import type { AdvancementInput, AdvancementProposal, CustomerDetail, Opportunity } from '@intent/contracts';
import { api, errorText, refresh, useResource } from '../api';
import { Badge, dateTime, Dialog, ErrorBanner, SaveNote } from '../components';
import { dateLabel, openStages, today } from './shared';
export function AdvancementPanel({ opportunity, customer, editable }: {
    opportunity: Opportunity;
    customer?: CustomerDetail;
    editable: boolean;
}) {
    useLocale();
    const proposals = useResource<AdvancementProposal[]>(`/opportunities/${opportunity.id}/advancements`);
    const [goal, setGoal] = useState('');
    const [dueDate, setDueDate] = useState('');
    const [factId, setFactId] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState('');
    const [review, setReview] = useState<{
        proposal: AdvancementProposal;
        decision: 'apply' | 'dismiss';
    } | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    const request = useRef<AdvancementInput | null>(null);
    const sending = useRef(false);
    const facts = customer?.facts.filter(fact => fact.status === 'confirmed' && fact.reviewedBy) ?? [];
    const selected = facts.find(fact => fact.id === factId);
    const open = openStages.includes(opportunity.stage);
    const list = proposals.data ?? [];
    const pending = list.filter(item => item.status === 'pending');
    async function generate(event: FormEvent) {
        event.preventDefault();
        if (!selected || sending.current)
            return;
        const payload = { expectedRevision: opportunity.revision, factId: selected.id, factRevision: selected.revision, goal: goal.trim(), dueDate };
        const previous = request.current;
        const input = previous && Object.entries(payload).every(([key, value]) => previous[key as keyof AdvancementInput] === value) ? previous : { ...payload, requestId: crypto.randomUUID() };
        request.current = input;
        sending.current = true;
        setBusy(true);
        setError('');
        setSaved('');
        try {
            const proposal = await api<AdvancementProposal>(`/opportunities/${opportunity.id}/advancements`, 'POST', input);
            setSaved(proposal.status === 'pending' ? t("Proposal saved. Review and apply it to update the opportunity.") : t("The result of this request was recovered. Review the history below."));
            if (proposal.status !== 'pending')
                setShowHistory(true);
            refresh();
        }
        catch (error) {
            setError(errorText(error));
            refresh();
        }
        finally {
            sending.current = false;
            setBusy(false);
        }
    }
    function stale(p: AdvancementProposal) {
        if (!open)
            return t("Opportunity closed");
        if (p.opportunityRevision !== opportunity.revision)
            return t("Opportunity updated");
        if (p.dueDate < today())
            return t("The planned deadline has passed");
        if (!customer)
            return t("Loading supporting evidence");
        if (!facts.some(f => f.id === p.factId && f.revision === p.factRevision))
            return t("The fact review has changed");
        return '';
    }
    return <section className="panel advancement-panel" id="opportunity-advance">
    <div className="panel-heading"><div><h2><Sparkles size={17}/>{t("Intent \u00B7 Next-step proposals")}</h2><p>{t("Set your goal and turn verified information into a next step you can review.")}</p></div><Badge>{t("Review before applying")}</Badge></div>
    <div className="panel-body stack"><ErrorBanner error={proposals.error ?? error} retry={Boolean(proposals.error)}/><SaveNote>{saved}</SaveNote>
      {editable && open && (customer ? facts.length ? <form className="form-stack product-form" onSubmit={event => void generate(event)}>
        <label>{t("Desired outcome")}<input value={goal} minLength={3} maxLength={200} required disabled={busy} onChange={event => setGoal(event.target.value)} placeholder={t("For example: Confirm the pilot scope and acceptance criteria")}/></label>
        <div className="advancement-inputs"><label>{t("Supporting verified fact")}<select required value={factId} disabled={busy} onChange={event => setFactId(event.target.value)}><option value="">{t("Select a fact relevant to this opportunity")}</option>{facts.map(fact => <option key={fact.id} value={fact.id}>{fact.value.length > 70 ? `${fact.value.slice(0, 70)}…` : fact.value}</option>)}</select></label><label>{t("Your planned deadline")}<input type="date" required min={today()} max="9999-12-31" value={dueDate} disabled={busy} onChange={event => setDueDate(event.target.value)}/></label></div>
        {selected && <blockquote className="advancement-source"><strong>{t("Reviewed by a person \u00B7 v")}{selected.revision}</strong><p>{selected.quote}</p><Link to={`/customers/${opportunity.customerId}?focus=facts`}>{t("View original evidence and review history")}</Link></blockquote>}
        <div className="between wrap"><span className="product-caption">{t("You set the goal and deadline. They are not customer commitments.")}</span><button className="button primary" disabled={busy || !selected}><Sparkles size={15}/>{busy ? t("Preparing proposal\u2026") : t("Generate next-step proposal")}</button></div>
      </form> : <div className="inline-empty">{t("Verify a customer fact relevant to this opportunity before requesting a proposal.")}<Link className="text-button" to={`/customers/${opportunity.customerId}?focus=facts`}>{t("Review customer facts")}<ArrowRight size={14}/></Link></div> : <p className="muted">{t("Loading customer facts\u2026")}</p>)}
      <div className="advancement-list">{(showHistory ? list : pending).map(p => {
            const reason = p.status === 'pending' ? stale(p) : '';
            return <article className="advancement-item" key={p.id}>
          <div className="between wrap"><Badge tone={p.status === 'applied' ? 'green' : reason ? 'amber' : 'neutral'}>{p.status === 'applied' ? t("Applied \u00B7 Opportunity v{0}", p.appliedOpportunityRevision) : p.status === 'dismissed' ? t("Dismissed") : reason || t("Awaiting review")}</Badge><span className="product-caption">{dateTime(p.createdAt)}</span></div>
          <h3>{p.goal}</h3><p className="advancement-plan">{p.nextStep}</p><p className="product-caption">{t("Planned for") + " "}{dateLabel(p.dueDate)}{" " + t("\u00B7 Based on opportunity v")}{p.opportunityRevision}</p>
          <details><summary>{t("View evidence and change preview")}</summary><p>{p.rationale}</p><blockquote className="advancement-source"><strong>{p.evidenceTitle}{" " + t("\u00B7 Fact v")}{p.factRevision}</strong><p>{p.quote}</p></blockquote><PlanChange proposal={p}/><Link className="text-button" to={`/customers/${opportunity.customerId}?focus=facts`}>{t("View the current fact and review history")}</Link></details>
          {p.status === 'pending' && editable && <div className="product-actions"><button className="button" onClick={() => setReview({ proposal: p, decision: 'dismiss' })}>{t("Dismiss")}</button><button className="button primary" disabled={Boolean(reason)} onClick={() => setReview({ proposal: p, decision: 'apply' })}>{t("Review and apply")}</button></div>}
          {reason && p.status === 'pending' && <p className="product-caption">{reason}{t(". Review the current context and generate a new proposal; you can dismiss the old one.")}</p>}
          {p.decisionNote && <p className="product-caption">{t("Decision note:")}{p.decisionNote} · {dateTime(p.decidedAt!)}</p>}
        </article>;
        })}</div>
      {!proposals.data && !proposals.error && <p className="muted">{t("Loading proposals\u2026")}</p>}
      {list.some(p => p.status !== 'pending') && <button className="text-button" onClick={() => setShowHistory(value => !value)}>{showHistory ? t("Hide resolved proposals") : t("View resolved proposals ({0})", list.length - pending.length)}</button>}
      <p className="product-caption">{t("Applying updates the next step and deadline while preserving evidence and history. Add the customer\u2019s reply afterward to inform the next decision.")}</p>
    </div>
    {review && <DecisionDialog opportunity={opportunity} {...review} onClose={() => setReview(null)} onSaved={p => { setReview(null); setSaved(p.status === 'applied' ? t("The next-step plan was updated. Evidence, review notes and change history were saved.") : t("The dismissal reason was saved.")); setShowHistory(true); refresh(); }}/>}
  </section>;
}
function PlanChange({ proposal: p }: {
    proposal: AdvancementProposal;
}) {
    useLocale();
    return <div className="advancement-diff"><div><span>{t("Previous plan at generation")}</span><p>{p.previousNextStep || t("No next step recorded")}</p><small>{p.previousDueDate ? dateLabel(p.previousDueDate) : t("No deadline")}</small></div><ArrowRight size={17}/><div><span>{t("Plan after applying")}</span><p>{p.nextStep}</p><small>{dateLabel(p.dueDate)}</small></div></div>;
}
function DecisionDialog({ opportunity, proposal, decision, onClose, onSaved }: {
    opportunity: Opportunity;
    proposal: AdvancementProposal;
    decision: 'apply' | 'dismiss';
    onClose: () => void;
    onSaved: (p: AdvancementProposal) => void;
}) {
    useLocale();
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const submitting = useRef(false);
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (submitting.current)
            return;
        submitting.current = true;
        setBusy(true);
        setError('');
        try {
            onSaved(await api<AdvancementProposal>(`/opportunities/${opportunity.id}/advancements/${proposal.id}/decision`, 'POST', { expectedRevision: proposal.revision, decision, note: note.trim() }));
        }
        catch (error) {
            setError(errorText(error));
            refresh();
        }
        finally {
            submitting.current = false;
            setBusy(false);
        }
    }
    return <Dialog title={decision === 'apply' ? t("Apply this next-step proposal") : t("Record why this proposal is being dismissed")} subtitle={t("{0} \u00B7 Proposal v{1} \u00B7 {2}", opportunity.title, proposal.revision, proposal.model)} busy={busy} onClose={onClose}><form className="dialog-body form-stack product-form" onSubmit={event => void submit(event)}>
    <ErrorBanner error={error}/><p>{proposal.rationale}</p><blockquote className="advancement-source"><strong>{proposal.evidenceTitle}{" " + t("\u00B7 Verified fact v")}{proposal.factRevision}</strong><p>{proposal.quote}</p></blockquote><PlanChange proposal={proposal}/>
    <label>{decision === 'apply' ? t("Review note") : t("Reason for dismissal")}<textarea required minLength={3} maxLength={1000} rows={3} value={note} disabled={busy} onChange={event => setNote(event.target.value)} placeholder={decision === 'apply' ? t("Explain why this proposal fits the current opportunity") : t("For example: The scope differs from the current pilot; collect customer feedback first")}/></label>
    <p className="product-caption">{decision === 'apply' ? t("Applying updates only the next step and deadline. The amount, stage and forecast category stay unchanged. No customer message is sent.") : t("The proposal and dismissal reason are retained. The opportunity plan stays unchanged.")}</p>
    <div className="dialog-footer"><button className="button" type="button" disabled={busy} onClick={onClose}>{t("Back")}</button><button className="button primary" disabled={busy || note.trim().length < 3}>{busy ? t("Saving\u2026") : decision === 'apply' ? t("Apply and update the plan") : t("Save decision reason")}</button></div>
  </form></Dialog>;
}
