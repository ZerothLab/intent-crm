import { LanguageSwitcher } from './language-switcher';
import { t, useLocale } from './i18n';
import { lazy, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { ArrowUpRight, BriefcaseBusiness, ChartNoAxesColumnIncreasing, Building2, ChevronRight, CircleHelp, Command, FileSliders, LayoutDashboard, Menu, PanelLeftClose, Settings2, ShieldCheck, Sparkles, Users, Workflow, X } from 'lucide-react';
import type { Bootstrap } from '@intent/contracts';
import { useResource } from './api';
import { Loading, Logo, roleLabels } from './components';
import { WorkspaceContext } from './workspace';
import { Account, AuthGate, SessionMenu, useSession } from './product/auth';
import { PageRecovery } from './page-recovery';
import './styles.css';
import './commercial/commercial.css';
import './product/product.css';
const Workbench = lazy(() => import('./product/workbench').then(module => ({ default: module.Workbench })));
const Customers = lazy(() => import('./pages').then(module => ({ default: module.Customers })));
const CustomerPage = lazy(() => import('./pages').then(module => ({ default: module.CustomerPage })));
const Actions = lazy(() => import('./pages').then(module => ({ default: module.Actions })));
const Management = lazy(() => import('./commercial/management').then(module => ({ default: module.Management })));
const Opportunities = lazy(() => import('./commercial/opportunities').then(module => ({ default: module.Opportunities })));
const OpportunityPage = lazy(() => import('./commercial/opportunities').then(module => ({ default: module.OpportunityPage })));
const Assistant = lazy(() => import('./product/assistant').then(module => ({ default: module.Assistant })));
const WorkspaceSettingsPage = lazy(() => import('./product/workspace-settings').then(module => ({ default: module.WorkspaceSettingsPage })));
const AccessSettings = lazy(() => import('./access').then(module => ({ default: module.AccessSettings })));
const Members = lazy(() => import('./settings').then(module => ({ default: module.Members })));
const Fields = lazy(() => import('./settings').then(module => ({ default: module.Fields })));
const Models = lazy(() => import('./production').then(module => ({ default: module.ModelSettings })));
const OperationsSettings = lazy(() => import('./production').then(module => ({ default: module.OperationsSettings })));
const primaryNav = [{ to: '/', label: "Workbench", icon: LayoutDashboard }, { to: '/management', label: "Business overview", icon: ChartNoAxesColumnIncreasing }, { to: '/customers', label: "Customer workspace", icon: Building2 }, { to: '/opportunities', label: "Opportunities", icon: BriefcaseBusiness }, { to: '/actions', label: "Action center", icon: Workflow }, { to: '/assistant', label: "Intent assistant", icon: Sparkles }];
const settingsNav = [{ to: '/settings/access', label: 'Access and audit', icon: ShieldCheck }, { to: '/settings/operations', label: "Delivery and runtime", icon: Workflow }, { to: '/settings/workspace', label: "Workspace", icon: Building2 }, { to: '/settings/members', label: "Team members", icon: Users }, { to: '/settings/models', label: "Model settings", icon: Settings2 }, { to: '/settings/fields', label: "Customer fields", icon: FileSliders }];
function Shell() {
    const locale = useLocale();
    const { data, error } = useResource<Bootstrap>('/bootstrap', 30000);
    const session = useSession();
    const [profileOpen, setProfileOpen] = useState(false);
    const location = useLocation();
    const [navOpen, setNavOpen] = useState(false);
    const navigation = useRef<HTMLElement>(null);
    useEffect(() => { setNavOpen(false); window.scrollTo({ top: 0 }); }, [location.pathname]);
    useEffect(() => {
        if (!navOpen)
            return;
        const mobile = window.matchMedia('(max-width: 760px)');
        if (!mobile.matches) { setNavOpen(false); return; }
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const drawer = navigation.current;
        drawer?.querySelector<HTMLButtonElement>('.nav-close')?.focus();
        const close = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setNavOpen(false);
            }
            if (event.key === 'Tab' && drawer) {
                const controls = [...drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter(element => element.getClientRects().length);
                const first = controls[0];
                const last = controls.at(-1);
                if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
            }
        };
        const resize = () => { if (!mobile.matches) setNavOpen(false); };
        mobile.addEventListener('change', resize);
        window.addEventListener('keydown', close);
        return () => { window.removeEventListener('keydown', close); mobile.removeEventListener('change', resize); if (previousFocus?.isConnected) previousFocus.focus(); };
    }, [navOpen]);
    const page = [...primaryNav, ...settingsNav, { to: '/settings/account', label: t("Account") }].find(item => item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to))?.label ?? t("Customer workspace");
    useEffect(() => { document.title = `Intent · ${t(page)}`; }, [page, locale]);
    if (!data)
        return <div className="boot-screen"><div className="boot-brand"><Logo /><strong>Intent</strong></div><Loading error={error}/><p className="muted small">{t("Loading your authorized workspace")}</p></div>;
    return <WorkspaceContext.Provider value={data}><div className="app-shell"><a href="#main-content" className="skip-link">{t("Skip to main content")}</a>
    {navOpen && <button className="nav-scrim" tabIndex={-1} aria-label={t("Close navigation")} onClick={() => setNavOpen(false)}/>}
    <aside ref={navigation} id="primary-navigation" className={`sidebar ${navOpen ? 'is-open' : ''}`} aria-label={t("Main navigation")} role={navOpen ? 'dialog' : undefined} aria-modal={navOpen ? true : undefined}>
      <Link to="/" className="brand"><Logo /><div>Intent<span>{t("The AI-native CRM.")}</span></div></Link><button className="nav-close icon-button" aria-label={t("Close navigation")} onClick={() => setNavOpen(false)}><X size={20}/></button>
      <Link to="/settings/workspace" className="workspace-picker" aria-label={t("Open workspace settings")}><span className="workspace-letter">I</span><div><strong title={data.workspace.name}>{data.workspace.name || t("Intent workspace")}</strong><span>{t("Workspace settings")}</span></div><ChevronRight size={14}/></Link>
      <div className="sidebar-navigation"><div className="nav-label">{t("WORKSPACE")}</div><nav>{primaryNav.filter(item => item.to !== '/management' || ['admin', 'manager'].includes(data.user.role)).map(item => <NavLink key={item.to} to={item.to} end={item.to === '/'}><item.icon size={18} strokeWidth={1.6}/><span>{t(item.label)}</span>{item.to === '/actions' && data.stats.decisions > 0 && <b className="nav-count">{data.stats.decisions}</b>}{item.to === '/assistant' && <span className="nav-ai">AI</span>}</NavLink>)}</nav>
      <div className="nav-divider"/><div className="nav-label">{t("MANAGE")}</div><nav>{settingsNav.filter(item => item.to !== '/settings/operations' || data.user.role === 'admin').map(item => <NavLink key={item.to} to={item.to}><item.icon size={17} strokeWidth={1.6}/><span>{t(item.label)}</span></NavLink>)}</nav></div>
      <div className="sidebar-bottom"><div className="sidebar-note"><div><span className="live-dot"/>{t("Every action starts with evidence")}</div><p>{t("Understand intent. Move business forward.")}</p><Link to="/assistant">{t("Talk with Intent")}<ArrowUpRight size={14}/></Link></div><button className="profile profile-button" onClick={() => { setNavOpen(false); setProfileOpen(true); }} aria-label={t("Account and sign out")}><span className="avatar">{data.user.name.slice(-1)}</span><div><strong>{data.user.name}</strong><span>{roleLabels[data.user.role]}</span></div><ShieldCheck size={16}/></button></div>
    </aside>
    <div className="app-main" inert={navOpen}><header className="topbar"><div className="breadcrumbs"><button className="mobile-menu icon-button" aria-label={t("Open navigation")} aria-expanded={navOpen} aria-controls="primary-navigation" onClick={() => setNavOpen(true)}><Menu size={20}/></button><PanelLeftClose className="desktop-only" size={16}/><Link to="/settings/workspace" className="breadcrumb-workspace">{t("Workspace")}</Link><span className="slash">/</span><strong>{t(page)}</strong></div><div className="topbar-right"><LanguageSwitcher/>{session.mode.demo && <span className="environment"><span className="live-dot"/>{t("Demo workspace")}</span>}<span className="topbar-divider"/><Link to="/assistant" className="assistant-shortcut"><Sparkles size={15}/>{t("Intent")}<Command size={12}/></Link><button className="avatar avatar-small icon-button" aria-label={t("Account and sign out")} onClick={() => { setNavOpen(false); setProfileOpen(true); }}>{data.user.name.slice(-1)}</button></div></header><main id="main-content" className="page" tabIndex={-1}><PageRecovery><Outlet /></PageRecovery></main><footer className="app-footer"><span>Intent <span className="footer-dot">·</span>{" " + t("Understand intent. Move business forward.")}</span><span>{data.execution.model === 'fixture' ? t("Demo model") : t("Configured model")} <span className="footer-dot">·</span> {data.execution.transport === 'simulated' ? t("Simulated delivery") : t("Real gateway delivery")}</span></footer></div>
  {profileOpen && <SessionMenu onClose={() => setProfileOpen(false)}/>}</div></WorkspaceContext.Provider>;
}
function NotFound() { useLocale(); return <div className="panel"><div className="empty"><CircleHelp size={32}/><h1>{t("Page not found")}</h1><Link className="button primary" to="/">{t("Back to workbench")}</Link></div></div>; }
createRoot(document.getElementById('root')!).render(<BrowserRouter><PageRecovery><AuthGate><Routes><Route element={<Shell />}><Route index element={<Workbench />}/><Route path="management" element={<Management />}/><Route path="opportunities" element={<Opportunities />}/><Route path="opportunities/:id" element={<OpportunityPage />}/><Route path="customers" element={<Customers />}/><Route path="customers/:id" element={<CustomerPage />}/><Route path="actions" element={<Actions />}/><Route path="assistant" element={<Assistant />}/><Route path="settings/account" element={<Account />}/><Route path="settings/workspace" element={<WorkspaceSettingsPage />}/><Route path="settings/access" element={<AccessSettings />}/><Route path="settings/members" element={<Members />}/><Route path="settings/operations" element={<OperationsSettings />}/><Route path="settings/models" element={<Models />}/><Route path="settings/fields" element={<Fields />}/><Route path="*" element={<NotFound />}/></Route></Routes></AuthGate></PageRecovery></BrowserRouter>);
