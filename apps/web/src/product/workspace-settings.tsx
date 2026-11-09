import { t, useLocale } from '../i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Building2, Check, Copy, FileSliders, Info, LockKeyhole, Plus, Settings2, ShieldCheck, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { WorkspaceSettings } from '@intent/contracts';
import { api, ApiError, errorText, refresh, useResource } from '../api';
import { Badge, Dialog, ErrorBanner, Loading, PageHeading, SaveNote } from '../components';
import { useWorkspace } from '../workspace';
import './workspace-settings.css';
const bootstrapCommand = 'docker compose --env-file .env.docker -f compose.production.yaml run --rm bootstrap';
export function WorkspaceSettingsPage() {
    useLocale();
    const { data, error } = useResource<WorkspaceSettings>('/workspace');
    const admin = useWorkspace().user.role === 'admin';
    const [showCreation, setShowCreation] = useState(false);
    if (!data)
        return <Loading error={error}/>;
    return <>
    <PageHeading eyebrow={t("WORKSPACE SETTINGS")} title={t("A shared space for your team")} description={t("Manage your workspace name, members and business settings.")}>
      {admin && <button className="button" onClick={() => setShowCreation(true)}><Plus size={16}/>{t("How to create a workspace")}</button>}
    </PageHeading>
    <ErrorBanner error={error} retry/>
    {!admin && <div className="info-note"><LockKeyhole size={16}/><p>{t("You can view workspace information. Contact an administrator to rename or create a workspace.")}</p></div>}
    <div className="workspace-settings-layout">
      <section className="panel workspace-basics" aria-labelledby="workspace-basics-title">
        <div className="panel-heading"><h2 id="workspace-basics-title">{t("Basic information")}</h2><Badge tone="lime">{t("Current workspace")}</Badge></div>
        <WorkspaceForm workspace={data} admin={admin}/>
      </section>
      <aside className="workspace-settings-aside" aria-label={t("Team and workspace information")}>
        <section className="panel workspace-team-summary">
          <div className="workspace-section-icon"><Users size={22}/></div>
          <h2>{t("Move each opportunity forward together")}</h2>
          <p>{t("Members share business settings and access customers and actions according to their roles.")}</p>
          <dl className="workspace-member-stats"><div><dt>{t("Active members")}</dt><dd>{data.activeMemberCount}<span>{t("members")}</span></dd></div><div><dt>{t("All members")}</dt><dd>{data.memberCount}<span>{t("members")}</span></dd></div></dl>
          <Link className="text-button" to="/settings/members">{admin ? t("Manage team members") : t("View team members")}<ArrowUpRight size={15}/></Link>
        </section>
        <div className="workspace-boundary-note"><ShieldCheck size={19}/><div><strong>{t("Separate business and permission boundaries")}</strong><p>{t("Customers, opportunities, members and settings belong to this workspace. Intent follows each member\u2019s access permissions.")}</p></div></div>
      </aside>
    </div>
    <section className="workspace-configuration" aria-labelledby="workspace-config-title">
      <div className="workspace-section-heading"><h2 id="workspace-config-title">{t("Configure how your team works")}</h2><span>{t("Settings apply throughout this workspace")}</span></div>
      <div className="workspace-setting-links">
        <Link to="/settings/members"><span className="workspace-section-icon"><Users size={21}/></span><div><h3>{t("Team members")}</h3><p>{t("Manage members, roles and login access")}</p></div><ArrowUpRight size={17}/></Link>
        <Link to="/settings/models"><span className="workspace-section-icon"><Settings2 size={21}/></span><div><h3>{t("Model settings")}</h3><p>{t("Configure model providers, verify connections and select active models")}</p></div><ArrowUpRight size={17}/></Link>
        <Link to="/settings/fields"><span className="workspace-section-icon"><FileSliders size={21}/></span><div><h3>{t("Customer fields")}</h3><p>{t("Define the information and rules your business needs")}</p></div><ArrowUpRight size={17}/></Link>
      </div>
    </section>
    {showCreation && <WorkspaceCreationGuide onClose={() => setShowCreation(false)}/>}
  </>;
}
function WorkspaceForm({ workspace, admin }: {
    workspace: WorkspaceSettings;
    admin: boolean;
}) {
    useLocale();
    const [baseline, setBaseline] = useState(workspace);
    const [name, setName] = useState(workspace.name);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState('');
    const [needsReload, setNeedsReload] = useState(false);
    const [copyMessage, setCopyMessage] = useState('');
    const idInput = useRef<HTMLInputElement>(null);
    const dirty = name !== baseline.name;
    // Background refreshes may update the summary, but must not replace an edit in progress.
    useEffect(() => {
        if (!dirty && !busy && !needsReload && workspace.revision > baseline.revision) {
            setBaseline(workspace);
            setName(workspace.name);
        }
    }, [workspace, baseline.revision, dirty, busy, needsReload]);
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!admin || busy || needsReload || !name.trim() || !dirty)
            return;
        setBusy(true);
        setError('');
        setSaved('');
        try {
            const updated = await api<WorkspaceSettings>('/workspace', 'PATCH', { name: name.trim(), expectedRevision: baseline.revision });
            setBaseline(updated);
            setName(updated.name);
            setSaved(t("Workspace name saved."));
            refresh();
        }
        catch (failure) {
            setError(errorText(failure));
            setNeedsReload(failure instanceof ApiError && (failure.status === 409 || failure.status === 0 || failure.code === 'INVALID_RESPONSE'));
        }
        finally {
            setBusy(false);
        }
    }
    async function reloadLatest() {
        setBusy(true);
        setError('');
        setSaved('');
        try {
            const latest = await api<WorkspaceSettings>('/workspace');
            setBaseline(latest);
            setName(latest.name);
            setNeedsReload(false);
            setSaved(t("Latest settings loaded. You can continue editing."));
            refresh();
        }
        catch (failure) {
            setError(errorText(failure));
        }
        finally {
            setBusy(false);
        }
    }
    async function copyId() {
        try {
            await navigator.clipboard.writeText(workspace.id);
            setCopyMessage(t("Workspace ID copied"));
        }
        catch {
            idInput.current?.focus();
            idInput.current?.select();
            setCopyMessage(t("Automatic copying failed. The ID is selected for manual copying."));
        }
    }
    return <form className="workspace-settings-form" onSubmit={submit} aria-busy={busy}>
    <div className="workspace-identity"><span className="workspace-section-icon"><Building2 size={24}/></span><div><strong>{admin ? baseline.name : workspace.name}</strong><span>{t("Team workspace")}</span></div></div>
    <ErrorBanner error={error}/><SaveNote>{saved}</SaveNote>
    <label htmlFor="workspace-name">{t("Workspace name")}</label>
    <input id="workspace-name" name="workspaceName" value={admin ? name : workspace.name} onChange={event => { setName(event.target.value); setSaved(''); }} required maxLength={160} readOnly={!admin} disabled={busy} aria-describedby="workspace-name-help" autoComplete="organization"/>
    <p id="workspace-name-help" className="workspace-field-help">{t("Shown in navigation. Use your team or company name, up to 160 characters.")}</p>
    <label htmlFor="workspace-id">{t("Workspace ID")}</label>
    <div className="workspace-id-control"><input ref={idInput} id="workspace-id" readOnly value={workspace.id} aria-describedby="workspace-id-help" spellCheck={false}/><button type="button" className="button" onClick={copyId} aria-label={t("Copy workspace ID")}><Copy size={15}/><span>{t("Copy")}</span></button></div>
    <p id="workspace-id-help" className="workspace-field-help">{t("Members enter this ID when signing in. It cannot change after creation; renaming the workspace does not affect sign-in.")}</p>
    {copyMessage && <p className="workspace-copy-status" role="status">{copyMessage}</p>}
    {admin && <div className="workspace-form-footer">
      {needsReload ? <><p>{t("Check the latest saved settings before continuing.")}</p><button type="button" className="button" disabled={busy} onClick={reloadLatest}>{busy ? t("Loading\u2026") : t("Discard changes and load latest settings")}</button></> : <><p>{dirty ? t("You have unsaved changes") : t("Name changes are recorded in the audit log")}</p><div><button type="button" className="button" disabled={busy || !dirty} onClick={() => { setName(baseline.name); setError(''); setSaved(''); }}>{t("Discard changes")}</button><button className="button primary" disabled={busy || !dirty || !name.trim()}><Check size={15}/>{busy ? t("Saving\u2026") : t("Save name")}</button></div></>}
    </div>}
  </form>;
}
function WorkspaceCreationGuide({ onClose }: {
    onClose: () => void;
}) {
    useLocale();
    const command = useRef<HTMLTextAreaElement>(null);
    const [copyMessage, setCopyMessage] = useState('');
    const [copying, setCopying] = useState(false);
    async function copyCommand() {
        setCopying(true);
        try {
            await navigator.clipboard.writeText(bootstrapCommand);
            setCopyMessage(t("Initialization command copied"));
        }
        catch {
            command.current?.focus();
            command.current?.select();
            setCopyMessage(t("Automatic copying failed. The command is selected for manual copying."));
        }
        finally {
            setCopying(false);
        }
    }
    return <Dialog title={t("Create a new workspace")} subtitle={t("A deployment administrator initializes private workspaces on the server.")} onClose={onClose}>
    <div className="dialog-body workspace-creation-guide">
      <div className="workspace-creation-context"><Info size={18}/><p>{t("This page manages your signed-in workspace. Create another workspace on the deployment server, then sign in with its ID.")}</p></div>
      <ol>
        <li><strong>{t("Run in the server deployment directory")}</strong><p>{t("Open the directory containing .env.docker and compose.production.yaml, then run the initialization command.")}</p></li>
      </ol>
      <label htmlFor="workspace-bootstrap-command" className="sr-only">{t("Workspace initialization command")}</label>
      <textarea ref={command} id="workspace-bootstrap-command" readOnly rows={3} value={bootstrapCommand} spellCheck={false}/>
      <div className="workspace-command-copy"><span role="status">{copyMessage}</span><button type="button" className="button" disabled={copying} onClick={copyCommand}><Copy size={15}/>{copying ? t("Copying\u2026") : t("Copy command")}</button></div>
      <ol start={2}>
        <li><strong>{t("Set up the workspace and its first administrator")}</strong><p>{t("Enter the workspace ID, name, administrator name, email and password. Password input is hidden. New workspaces contain no example business records.")}</p></li>
        <li><strong>{t("Sign in to the new workspace and add members")}</strong><p>{t("Sign out, then sign in using the new workspace ID, email and password. Open Team members to add members and set their login passwords.")}</p></li>
      </ol>
      <div className="dialog-footer"><button type="button" className="button primary" onClick={onClose}>{t("Got it")}</button></div>
    </div>
  </Dialog>;
}
