import { t, useLocale, localizedLabels } from './i18n';
import { useState, type FormEvent } from 'react';
import { Cpu, FileSliders, LockKeyhole, Pencil, Plus, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { FieldDefinition, Member, ModelConnection, Role } from '@intent/contracts';
import { api, errorText, refresh, useResource } from './api';
import { Badge, Dialog, Empty, ErrorBanner, Loading, PageHeading, roleLabels, SaveNote } from './components';
import { useWorkspace } from './workspace';
import { MemberPassword } from './product/auth';
function SettingsNav({ current }: {
    current: string;
}) { useLocale(); return <div className="settings-tabs">{[["members", t("Team members")], ['models', t("Model settings")], ['fields', t("Customer fields")]].map(([key, label]) => <Link to={`/settings/${key}`} className={current === key ? 'selected' : ''} key={key}>{key === "members" ? <Users size={16}/> : key === 'models' ? <Cpu size={16}/> : <FileSliders size={16}/>} {label}</Link>)}</div>; }
function AccessNote() { useLocale(); return <div className="info-note"><LockKeyhole size={16}/><p>{t("You can view settings. Only workspace administrators can change them.")}</p></div>; }
export function Members() {
    useLocale();
    const { data, error } = useResource<Member[]>('/members');
    const admin = useWorkspace().user.role === 'admin';
    const [editing, setEditing] = useState<Member | 'new' | null>(null);
    const [credentials, setCredentials] = useState<Member | null>(null);
    const [saved, setSaved] = useState('');
    if (!data)
        return <Loading error={error}/>;
    return <><PageHeading eyebrow={t("WORKSPACE SETTINGS")} title={t("Give every team member a clear role")} description={t("Manage team responsibilities and access to customer context.")}>{admin && <button className="button primary" onClick={() => setEditing('new')}><Plus size={16}/>{t("Add member")}</button>}</PageHeading><SettingsNav current="members"/><ErrorBanner error={error} retry/><SaveNote>{saved}</SaveNote>{!admin && <AccessNote />}<div className="panel"><div className="panel-heading"><h2>{t("Team members") + " "}<span className="count-pill">{data.length}</span></h2><span className="subtle-label"><ShieldCheck size={14}/>{t("Roles control data access and available actions")}</span></div><div className="table-scroll"><table><thead><tr><th>{t("Member")}</th><th>{t("Role")}</th><th>{t("Status")}</th><th>{t("Access scope")}</th><th>{t("Actions")}</th></tr></thead><tbody>{data.map(member => <tr key={member.id}><td><div className="row"><span className="avatar">{member.name.slice(-1)}</span><div><strong>{member.name}</strong><span className="cell-sub">{member.email}</span></div></div></td><td>{roleLabels[member.role]}</td><td><Badge tone={member.active ? 'green' : 'neutral'}>{member.active ? t("Enabled") : t("Disabled")}</Badge></td><td className="muted">{['admin', 'manager'].includes(member.role) ? t("All workspace customers") : t("Assigned customers")}</td><td><div className="product-actions"><button className="text-button" disabled={!admin} onClick={() => setEditing(member)}><Pencil size={13}/>{t("Edit")}</button>{admin && <button className="text-button" onClick={() => setCredentials(member)}><LockKeyhole size={13}/>{t("Set password")}</button>}</div></td></tr>)}</tbody></table></div></div><div className="settings-explainer"><ShieldCheck size={21}/><div><strong>{t("Clear permissions for reliable collaboration")}</strong><p>{t("Administrators manage settings. Managers can access workspace customers. Sales representatives and engineers see assigned customers only. The last active administrator is protected.")}</p></div></div>{admin && editing && <MemberEditor member={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setSaved(t("Member settings saved. Set a login password before the new member signs in.")); refresh(); }}/>}{admin && credentials && <MemberPassword member={credentials} onClose={() => setCredentials(null)} onSaved={() => { setCredentials(null); setSaved(t("The password was set and the member\u2019s previous sessions were revoked.")); }}/>}</>;
}
function MemberEditor({ member, onClose, onSaved }: {
    member: Member | 'new';
    onClose: () => void;
    onSaved: () => void;
}) {
    useLocale();
    const [name, setName] = useState(member === 'new' ? '' : member.name);
    const [email, setEmail] = useState(member === 'new' ? '' : member.email);
    const [role, setRole] = useState<Role>(member === 'new' ? 'sales' : member.role);
    const [active, setActive] = useState(member === 'new' ? true : member.active);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api(`/members${member === 'new' ? '' : `/${member.id}`}`, member === 'new' ? 'POST' : 'PATCH', { name, email, role, active, ...(member === 'new' ? {} : { expectedRevision: member.revision }) });
            onSaved();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={member === 'new' ? t("Add team member") : t("Edit team member")} subtitle={t("Permissions take effect when saved. Adding a member does not send an invitation email.")} busy={busy} onClose={onClose}><form className="dialog-body form-stack" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Member name")}<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={t("Enter a name")}/></label><label>{t("Email")}<input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@example.com"/></label><label>{t("Role")}<select value={role} onChange={event => setRole(event.target.value as Role)}>{Object.entries(roleLabels).map(([key, value]) => <option value={key} key={key}>{value}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)}/>{t("Enable this member")}</label><div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="button primary" disabled={busy}>{busy ? t("Saving\u2026") : t("Save member")}</button></div></form></Dialog>;
}
export { ModelSettings as Models } from './production';
const fieldTypeLabels = localizedLabels({ text: "Text", number: "Number", date: "Date", select: "Single choice" });
export function Fields() {
    useLocale();
    const { data, error } = useResource<FieldDefinition[]>('/fields');
    const admin = useWorkspace().user.role === 'admin';
    const [editing, setEditing] = useState<FieldDefinition | 'new' | null>(null);
    const [saved, setSaved] = useState('');
    if (!data)
        return <Loading error={error}/>;
    return <><PageHeading eyebrow={t("WORKSPACE SETTINGS")} title={t("Make customer information fit your business")} description={t("Define the information your team needs to make informed decisions.")}>{admin && <button className="button primary" onClick={() => setEditing('new')}><Plus size={16}/>{t("Add field")}</button>}</PageHeading><SettingsNav current="fields"/><ErrorBanner error={error} retry/><SaveNote>{saved}</SaveNote>{!admin && <AccessNote />}<div className="panel"><div className="panel-heading"><h2>{t("Custom customer fields") + " "}<span className="count-pill">{data.length}</span></h2><span className="small muted">{t("Disabling a field preserves existing values")}</span></div><div className="table-scroll"><table><thead><tr><th>{t("Field name")}</th><th>{t("Field type")}</th><th>{t("Requirement")}</th><th>{t("Status")}</th><th>{t("Actions")}</th></tr></thead><tbody>{data.map(field => <tr key={field.id}><td><strong>{field.label}</strong><span className="cell-sub mono">{field.key}</span></td><td><span className="field-type">{field.type === 'text' ? 'T' : field.type === 'number' ? '#' : field.type === 'date' ? '◷' : '≡'}</span>{fieldTypeLabels[field.type]}{field.type === 'select' && <span className="cell-sub">{field.options.join(' / ')}</span>}</td><td>{field.required ? <span className="required-rule">{t("Required")}</span> : <span className="muted">{t("Optional")}</span>}</td><td><Badge tone={field.enabled ? 'green' : 'neutral'}>{field.enabled ? t("Enabled") : t("Disabled")}</Badge></td><td><button className="text-button" disabled={!admin} onClick={() => setEditing(field)}><Pencil size={13}/>{t("Edit")}</button></td></tr>)}</tbody></table></div>{!data.length && <Empty icon={<FileSliders size={25}/>} title={t("Start with a useful field")} description={t("For example: customer budget, expected decision date or product interest.")}/>}</div><div className="settings-explainer"><SlidersHorizontal size={21}/><div><strong>{t("Stable fields preserve valuable information")}</strong><p>{t("Field identifiers cannot change after creation. Used types and options are protected. New required-field rules are checked the next time customer information is saved.")}</p></div></div>{editing && <FieldEditor field={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setSaved(t("Field settings saved")); refresh(); }}/>}</>;
}
function FieldEditor({ field, onClose, onSaved }: {
    field: FieldDefinition | 'new';
    onClose: () => void;
    onSaved: () => void;
}) {
    useLocale();
    const [key, setKey] = useState(field === 'new' ? '' : field.key);
    const [label, setLabel] = useState(field === 'new' ? '' : field.label);
    const [type, setType] = useState<FieldDefinition['type']>(field === 'new' ? 'text' : field.type);
    const [required, setRequired] = useState(field === 'new' ? false : field.required);
    const [enabled, setEnabled] = useState(field === 'new' ? true : field.enabled);
    const [options, setOptions] = useState(field === 'new' ? '' : field.options.join('\n'));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api(`/fields${field === 'new' ? '' : `/${field.id}`}`, field === 'new' ? 'POST' : 'PATCH', { key, label, type, required, enabled, options: type === 'select' ? options.split('\n').map(value => value.trim()).filter(Boolean) : [] });
            onSaved();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={field === 'new' ? t("Add customer field") : t("Edit customer field")} subtitle={t("These settings apply to all workspace customers.")} busy={busy} onClose={onClose}><form className="dialog-body form-stack" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Field name")}<input required maxLength={50} value={label} onChange={event => setLabel(event.target.value)} placeholder={t("For example: Customer budget")}/></label><label>{t("Field identifier")}<input required pattern="[a-z][a-z0-9_]{1,39}" title={t("2\u201340 lowercase letters, digits or underscores, starting with a letter")} readOnly={field !== 'new'} value={key} onChange={event => setKey(event.target.value)} placeholder={t("For example: customer_budget")}/><span className="field-help">{t("Start with a lowercase letter; digits and underscores are allowed. The identifier cannot change after creation.")}</span></label><label>{t("Field type")}<select value={type} onChange={event => setType(event.target.value as FieldDefinition['type'])}>{Object.entries(fieldTypeLabels).map(([key, value]) => <option value={key} key={key}>{value}</option>)}</select></label>{type === 'select' && <label>{t("Choice options")}<textarea rows={4} required value={options} onChange={event => setOptions(event.target.value)} placeholder={t("One option per line")}/><span className="field-help">{t("Up to 20 unique options.")}</span></label>}<div className="row wrap"><label className="checkbox-label"><input type="checkbox" checked={required} onChange={event => setRequired(event.target.checked)}/>{t("Required field")}</label><label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/>{t("Enable field")}</label></div><div className="dialog-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="button primary" disabled={busy}>{busy ? t("Saving\u2026") : t("Save field")}</button></div></form></Dialog>;
}
