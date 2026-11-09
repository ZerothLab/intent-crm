import { t, useLocale, localizedLabels, intlLocale, translateMessage } from './i18n';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, Check, CircleDashed, LoaderCircle, Sparkles, X } from 'lucide-react';
import type { ActionStatus } from '@intent/contracts';
import { Link } from 'react-router-dom';
import { refresh } from './api';
export const roleLabels: Record<string, string> = localizedLabels({ admin: "Administrator", manager: "Sales manager", sales: "Sales representative", engineer: "Solutions engineer" });
export const stageLabels: Record<string, string> = localizedLabels({ discovery: "Discovery", qualification: "Qualification", proposal: "Proposal discussion", negotiation: "Commercial discussion", awaiting_review: "Awaiting customer feedback", lead: "New lead", qualified: "Qualified", won: "Won" });
export const statusLabels: Record<ActionStatus, string> = localizedLabels({ cancelled: "Cancelled", draft: "Awaiting your review", approved: "Approved \u00B7 Awaiting execution", executing: "Executing", succeeded: "Completed", unknown: "Reconciliation required", failed: "Execution failed" });
export const dateTime = (value: string) => new Intl.DateTimeFormat(intlLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
export function Logo({ small = false }: {
    small?: boolean;
}) { useLocale(); return <span className={`brand-logo ${small ? 'small-logo' : ''}`} aria-hidden="true"><span /><span /><span /></span>; }
export function AiMark({ large = false }: {
    large?: boolean;
}) { useLocale(); return <span className={`ai-mark ${large ? 'large' : ''}`}><Sparkles size={large ? 28 : 17} strokeWidth={1.6}/></span>; }
export function CompanyMark({ name }: {
    name: string;
}) { useLocale(); return <span className="company-mark">{name.slice(0, 1)}</span>; }
export function Badge({ children, tone = 'neutral' }: {
    children: ReactNode;
    tone?: string;
}) { useLocale(); return <span className={`badge ${tone}`}><span className="badge-dot"/>{children}</span>; }
export function Status({ status }: {
    status: ActionStatus;
}) { useLocale(); return <Badge tone={status === 'succeeded' ? 'green' : status === 'failed' ? 'red' : status === 'unknown' ? 'amber' : status === 'draft' ? 'lime' : 'neutral'}>{statusLabels[status]}</Badge>; }
export function PageHeading({ eyebrow, title, description, children }: {
    eyebrow: string;
    title: string;
    description?: string;
    children?: ReactNode;
}) { useLocale(); return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="heading-actions">{children}</div>}</div>; }
export function Empty({ title, description, children, icon }: {
    title: string;
    description: string;
    children?: ReactNode;
    icon?: ReactNode;
}) { useLocale(); return <div className="empty"><div className="empty-icon">{icon ?? <CircleDashed size={25}/>}</div><h3>{title}</h3><p>{description}</p>{children}</div>; }
export function ErrorBanner({ error, retry = false }: {
    error?: Error | string | null;
    retry?: boolean;
}) {
    useLocale();
    if (!error)
        return null;
    return <div className="error-banner" role="alert"><AlertCircle size={17}/><span>{translateMessage(typeof error === 'string' ? error : error.message)}</span>{retry && <button className="text-button" onClick={refresh}>{t("Reload")}</button>}</div>;
}
export function Loading({ error }: {
    error?: Error;
}) { useLocale(); return error ? <div className="panel"><Empty icon={<AlertCircle size={25}/>} title={t("Unable to load")} description={translateMessage(error.message)}><button className="button" onClick={refresh}>{t("Reconnect")}</button></Empty></div> : <div className="loading" role="status"><LoaderCircle size={24} className="spin"/><span>{t("Loading workspace\u2026")}</span></div>; }
export function SaveNote({ children }: {
    children?: ReactNode;
}) { useLocale(); return children ? <p className="save-note" role="status"><Check size={15}/>{typeof children==='string'?translateMessage(children):children}</p> : null; }
export function PageLink({ href, children }: {
    href: string;
    children: ReactNode;
}) { useLocale(); return <Link className="text-button" to={href}>{children}<ArrowUpRight size={15}/></Link>; }
export function Dialog({ title, subtitle, children, onClose, wide = false, busy = false }: {
    title: string;
    subtitle?: string;
    children: ReactNode;
    onClose: () => void;
    wide?: boolean;
    busy?: boolean;
}) {
    useLocale();
    const ref = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const subtitleId = useId();
    useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
    return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} onCancel={event => {
            event.preventDefault();
            if (!busy)
                onClose();
        }} onClick={event => {
            if (!busy && event.target === event.currentTarget)
                onClose();
        }} aria-labelledby={titleId} aria-describedby={subtitle ? subtitleId : undefined} aria-busy={busy}><div className="dialog-heading"><div><h2 id={titleId}>{title}</h2>{subtitle && <p id={subtitleId}>{subtitle}</p>}</div><button type="button" className="icon-button" aria-label={busy ? t("Saving. Please wait.") : t("Close dialog")} disabled={busy} onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}
