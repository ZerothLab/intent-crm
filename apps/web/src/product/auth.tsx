import { LanguageSwitcher } from '../language-switcher';
import { t, useLocale } from '../i18n';
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LogOut, Settings2, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AuthMode, Bootstrap, Member } from '@intent/contracts';
import { api, ApiError, errorText, onUnauthorized, refresh, setAccessToken } from '../api';
import { Badge, Dialog, ErrorBanner, Loading, Logo, PageHeading, roleLabels, SaveNote } from '../components';
import { useWorkspace } from '../workspace';
type SessionContextValue = {
    mode: AuthMode;
    logout: () => Promise<void>;
    requireLogin: (message?: string) => void;
};
const SessionContext = createContext<SessionContextValue | null>(null);
export function useSession() {
    const session = useContext(SessionContext);
    if (!session)
        throw new Error('Session is not initialized');
    return session;
}
export function AuthGate({ children }: {
    children: ReactNode;
}) {
    useLocale();
    const [mode, setMode] = useState<AuthMode | null>(null);
    const [ready, setReady] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [attempt, setAttempt] = useState(0);
    function requireLogin(message = '') { setAccessToken(null); setReady(false); setNotice(message); refresh(); }
    useEffect(() => onUnauthorized(() => { setReady(false); setAccessToken(null); }), []);
    useEffect(() => {
        let alive = true;
        setLoading(true);
        setError('');
        void (async () => {
            try {
                const value = await api<AuthMode>('/auth/mode');
                if (!alive)
                    return;
                setMode(value);
                if (value.mode === 'password') {
                    try {
                        await api<Bootstrap>('/bootstrap');
                        if (alive)
                            setReady(true);
                    }
                    catch (error) {
                        if (!(error instanceof ApiError && error.status === 401))
                            throw error;
                    }
                }
            }
            catch (error) {
                if (alive)
                    setError(errorText(error));
            }
            finally {
                if (alive)
                    setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [attempt]);
    async function authenticated() {
        if (mode?.mode === 'password')
            setAccessToken(null);
        await api<Bootstrap>('/bootstrap');
        setNotice('');
        setReady(true);
        refresh();
    }
    async function logout() { await api('/auth/logout', 'POST', {}); requireLogin(t("You have signed out securely.")); }
    if (loading || !mode || error)
        return <div className="boot-screen"><div className="boot-brand"><Logo /><strong>Intent</strong></div>{error ? <div className="panel"><div className="empty"><h3>{t("Unable to connect to the workspace")}</h3><p>{error}</p><button className="button" onClick={() => setAttempt(value => value + 1)}>{t("Reconnect")}</button></div></div> : <Loading />}</div>;
    if (!ready)
        return <Login mode={mode} notice={notice} onAuthenticated={authenticated}/>;
    return <SessionContext.Provider value={{ mode, logout, requireLogin }}>{children}</SessionContext.Provider>;
}
function Login({ mode, notice, onAuthenticated }: {
    mode: AuthMode;
    notice: string;
    onAuthenticated: () => Promise<void>;
}) {
    const locale=useLocale();
    useEffect(()=>{document.title=`Intent · ${t('Sign in')}`;},[locale]);
    const [workspaceId, setWorkspaceId] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event?: FormEvent) {
        event?.preventDefault();
        setBusy(true);
        setError('');
        try {
            if (mode.demo) {
                const result = await api<{
                    token: string;
                    user: Member;
                }>('/dev/session', 'POST', {});
                setAccessToken(result.token);
            }
            else {
                await api('/auth/login', 'POST', { workspaceId, email, password });
            }
            await onAuthenticated();
            setPassword('');
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <div className="auth-shell"><aside className="auth-brand-panel"><div className="brand"><Logo /><div>Intent<span>{t("The AI-native CRM.")}</span></div></div><div className="auth-narrative"><span>{t("INTENT, INTO ACTION.")}</span><h1>{t("Understand intent.")}<br />{t("Move business forward.")}</h1><p>{t("Build lasting customer context,")}<br />{t("support every decision with evidence,")}<br />{t("and keep every action traceable.")}</p></div><div className="auth-brand-foot">{t("Intent assists. You remain in control.")}</div><div className="auth-orbit" aria-hidden="true"/></aside><main className="auth-content"><div className="auth-card"><LanguageSwitcher/><div className="eyebrow">{t("WELCOME TO YOUR WORKSPACE")}</div><h2>{mode.demo ? t("Enter demo workspace") : t("Sign in to your workspace")}</h2><p>{mode.demo ? t("Explore customers, opportunities and evidence-based collaboration with Intent.") : t("Use the workspace ID, email and password provided by your administrator.")}</p><SaveNote>{notice}</SaveNote><ErrorBanner error={error}/>{mode.demo ? <><div className="auth-demo-box"><strong>{t("Demo workspace")}</strong><p>{t("This entrance uses a preset demo identity and example business records. Model and delivery modes are shown in workspace settings.")}</p></div><button className="button primary full-width" disabled={busy} onClick={() => void submit()}>{busy ? t("Entering\u2026") : t("Enter demo workspace")}</button></> : <form className="form-stack" onSubmit={submit}><label>{t("Workspace ID")}<input required autoComplete="organization" pattern="[a-zA-Z0-9_-]{1,100}" maxLength={100} value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} placeholder={t("Enter your workspace ID")}/></label><label>{t("Login email")}<input required type="email" maxLength={254} autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@company.com"/></label><label>{t("Password")}<input required type="password" maxLength={128} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/></label><button className="button primary full-width" disabled={busy}>{busy ? t("Signing in\u2026") : t("Sign in")}</button></form>}<div className="auth-mode-note"><ShieldCheck size={15}/> {mode.demo ? t("This workspace includes fictional records for exploring the product.") : t("Sessions use secure cookies. Contact your administrator if you need an account or password reset.")}</div></div></main></div>;
}
export function SessionMenu({ onClose }: {
    onClose: () => void;
}) {
    useLocale();
    const { user } = useWorkspace();
    const session = useSession();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function logout() {
        setBusy(true);
        setError('');
        try {
            await session.logout();
        }
        catch (error) {
            setError(t("Sign-out did not complete: {0}", errorText(error)));
            setBusy(false);
        }
    }
    return <Dialog title={user.name} subtitle={`${roleLabels[user.role]} · ${user.email}`} busy={busy} onClose={onClose}><div className="dialog-body session-menu"><ErrorBanner error={error}/><Link to="/settings/account" className="button" onClick={onClose}><Settings2 size={16}/>{t("Account and password")}</Link><button className="button" disabled={busy} onClick={() => void logout()}><LogOut size={16}/>{busy ? t("Signing out\u2026") : t("Sign out")}</button></div></Dialog>;
}
export function Account() {
    useLocale();
    const { user, workspace } = useWorkspace();
    const session = useSession();
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setError('');
        if (newPassword !== confirm) {
            setError(t("The new passwords do not match."));
            return;
        }
        setBusy(true);
        try {
            await api('/auth/password', 'POST', { currentPassword, newPassword });
            setCurrentPassword('');
            setNewPassword('');
            setConfirm('');
            session.requireLogin(t("Password updated and previous sessions revoked. Sign in again."));
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <><PageHeading eyebrow={t("YOUR ACCOUNT")} title={t("Account and security")} description={t("Manage your identity and protect customer and business information.")}/><div className="account-layout"><section className="panel"><div className="panel-heading"><h2>{t("Personal information")}</h2><Badge>{session.mode.demo ? t("Demo session") : t("Password session")}</Badge></div><div className="panel-body"><dl className="account-details"><div><dt>{t("Full name")}</dt><dd>{user.name}</dd></div><div><dt>{t("Login email")}</dt><dd>{user.email}</dd></div><div><dt>{t("Workspace")}</dt><dd>{workspace.name}</dd></div><div><dt>{t("Current role")}</dt><dd>{roleLabels[user.role]}</dd></div></dl></div></section><section className="panel"><div className="panel-heading"><h2>{t("Change password")}</h2><KeyRound size={16}/></div><div className="panel-body">{session.mode.demo ? <p className="product-caption">{t("You are signed in through the explicit demo entrance. Private workspaces use password authentication, with initial passwords set by an administrator.")}</p> : <form className="form-stack product-form" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Current password")}<input required type="password" maxLength={128} autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)}/></label><label>{t("New password")}<input required type="password" minLength={12} maxLength={128} autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)}/><span className="field-help">{t("12\u2013128 characters. Changing your password signs out all existing sessions.")}</span></label><label>{t("Repeat new password")}<input required type="password" minLength={12} maxLength={128} autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)}/></label><button className="button primary" disabled={busy}>{busy ? t("Updating\u2026") : t("Update password and sign in again")}</button></form>}</div></section></div></>;
}
export function MemberPassword({ member, onClose, onSaved }: {
    member: Member;
    onClose: () => void;
    onSaved: () => void;
}) {
    useLocale();
    const user = useWorkspace().user;
    const session = useSession();
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault();
        setError('');
        if (password !== confirm) {
            setError(t("The passwords do not match."));
            return;
        }
        setBusy(true);
        try {
            await api(`/members/${member.id}/credentials`, 'POST', { password });
            setPassword('');
            setConfirm('');
            if (member.id === user.id && !session.mode.demo)
                session.requireLogin(t("Your password was reset. Sign in again."));
            else
                onSaved();
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    return <Dialog title={t("Set member login password")} subtitle={`${member.name} · ${member.email}`} busy={busy} onClose={onClose}><form className="dialog-body form-stack product-form" onSubmit={submit}><ErrorBanner error={error}/><label>{t("New login password")}<input required type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)}/></label><label>{t("Repeat password")}<input required type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirm} onChange={event => setConfirm(event.target.value)}/></label><p className="product-caption">{t("Use 12\u2013128 characters. Saving revokes all previous sessions for this member. No invitation or password email is sent.")}</p><div className="dialog-footer"><button className="button" type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="button primary" disabled={busy}>{busy ? t("Setting password\u2026") : t("Set password")}</button></div></form></Dialog>;
}
