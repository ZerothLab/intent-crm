import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import type { AuditPage, Member, Role } from '@intent/contracts';
import { useResource } from './api';
import { Badge, Empty, ErrorBanner, Loading, PageHeading, dateTime, roleLabels } from './components';
import { t, useLocale } from './i18n';
import { useWorkspace } from './workspace';

const permissions = [
    ['Customer records and evidence', 'All workspace customers', 'All workspace customers', 'Assigned customers', 'Assigned customers'],
    ['Add evidence and use the assistant', 'Allowed', 'Allowed', 'Assigned customers', 'Assigned customers'],
    ['Edit customers, verify facts and approve actions', 'Allowed', 'Allowed', 'Assigned customers', 'Not allowed'],
    ['Edit opportunities and apply AI proposals', 'Allowed', 'Allowed', 'Owned opportunities within customer scope', 'Not allowed'],
    ['Complete intervention tasks', 'Allowed', 'Allowed', 'Assigned tasks within customer scope', 'Assigned tasks within customer scope'],
    ['Transfer customers, assign tasks and reconcile delivery', 'Allowed', 'Allowed', 'Not allowed', 'Not allowed'],
    ['Business overview, contracts, payments and refunds', 'Allowed', 'Allowed', 'Read customer records only', 'Read customer records only'],
    ['Manage members, models, fields, delivery and recovery', 'Allowed', 'Not allowed', 'Not allowed', 'Not allowed'],
    ['View workspace audit history', 'Allowed', 'Not allowed', 'Not allowed', 'Not allowed'],
    ['Private assistant conversations', 'Own conversations within customer scope', 'Own conversations within customer scope', 'Own conversations within customer scope', 'Own conversations within customer scope'],
];

export function AccessSettings() {
    useLocale();
    const admin = useWorkspace().user.role === 'admin';
    return <>
        <PageHeading eyebrow={t('WORKSPACE SETTINGS')} title={t('Access and audit')} description={t('Understand each role and review changes to workspace access.')}>
            {admin && <Link className="button primary" to="/settings/members">{t('Manage team members')}</Link>}
        </PageHeading>
        <section className="panel">
            <div className="panel-heading"><h2>{t('Role permissions')}</h2><ShieldCheck size={20}/></div>
            <div className="table-scroll"><table className="access-permissions"><thead><tr><th>{t('Capability')}</th>{(['admin', 'manager', 'sales', 'engineer'] as const).map(role => <th key={role}>{roleLabels[role]}</th>)}</tr></thead>
                <tbody>{permissions.map(([label, ...scopes]) => <tr key={label}><th scope="row">{t(label!)}</th>{scopes.map((scope, index) => <td key={index}>{t(scope)}</td>)}</tr>)}</tbody>
            </table></div>
        </section>
        <div className="info-note"><p>{t('Role, status or login email changes end existing sessions. Password changes do the same. Pending approvals require review when the approver or execution owner changes access. The last active administrator is protected.')}</p></div>
        <div className="info-note"><p>{t('Transfer customers from the customer workspace to move open work and clear approvals. Historical records retain their original attribution. AI suggestions never grant access or bypass approval.')}</p></div>
        {admin && <AuditHistory/>}
    </>;
}

function AuditHistory() {
    const [category, setCategory] = useState('access');
    const [actorId, setActorId] = useState('');
    const [cursors, setCursors] = useState<string[]>([]);
    const members = useResource<Member[]>('/members');
    const query = new URLSearchParams({ category });
    if (actorId) query.set('actorId', actorId);
    if (cursors.length) query.set('cursor', cursors.at(-1)!);
    const resource = useResource<AuditPage>(`/settings/audit?${query}`);
    const stateLabel = (value: { role: string; active: boolean }) => `${roleLabels[value.role as Role] ?? value.role} · ${value.active ? t('Enabled') : t('Disabled')}`;
    return <section className="panel">
        <div className="panel-heading"><h2>{t('Audit history')}</h2><Badge>{t('Administrator access')}</Badge></div>
        <div className="panel-body form-stack">
            <div className="product-form-columns">
                <label>{t('Category')}<select value={category} onChange={e => { setCategory(e.target.value); setCursors([]); }}>{[['all', 'All events'], ['access', 'Access changes'], ['models', 'Model settings'], ['delivery', 'Delivery'], ['workspace', 'Workspace settings']].map(([value, label]) => <option key={value} value={value}>{t(label!)}</option>)}</select></label>
                <label>{t('Member')}<select value={actorId} onChange={e => { setActorId(e.target.value); setCursors([]); }}><option value="">{t('All members')}</option>{members.data?.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
            </div>
            <ErrorBanner error={members.error}/><ErrorBanner error={resource.error} retry/>
            {!resource.data ? <Loading error={resource.error}/> : resource.data.items.length === 0 ? <Empty icon={<ShieldCheck size={24}/>} title={t('No matching audit events')} description={t('Changes appear here after they are saved.')}/> : <div className="table-scroll"><table className="access-audit">
                <thead><tr><th>{t('Time')}</th><th>{t('Member')}</th><th>{t('Event')}</th><th>{t('Record')}</th><th>{t('Access change')}</th></tr></thead>
                <tbody>{resource.data.items.map(entry => <tr key={entry.id}><td>{dateTime(entry.createdAt)}</td><td>{entry.actorName ?? t('System')}</td><td><code>{entry.event}</code></td><td><code>{entry.entityId}</code></td><td>{entry.accessChange ? <>{entry.accessChange.before && `${stateLabel(entry.accessChange.before)} → `}{stateLabel(entry.accessChange.after)}{entry.accessChange.sessionsRevoked && <span className="cell-sub">{t('Previous sessions revoked')}</span>}</> : '—'}</td></tr>)}</tbody>
            </table></div>}
            <div className="product-actions"><button className="button" disabled={!cursors.length || resource.loading} onClick={() => setCursors(previous => previous.slice(0, -1))}>{t('Previous page')}</button><button className="button" disabled={!resource.data?.nextCursor || resource.loading} onClick={() => setCursors(previous => [...previous, resource.data!.nextCursor!])}>{t('Next page')}</button></div>
        </div>
    </section>;
}
