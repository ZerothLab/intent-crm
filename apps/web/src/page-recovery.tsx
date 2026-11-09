import { Component, Suspense, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { Loading } from './components';
import { t, useLocale } from './i18n';

function PageFailure() {
    useLocale();
    const location = useLocation();
    return <section className="panel page-recovery" role="alert"><div className="empty"><AlertCircle size={28}/><h1>{t('Unable to display this page')}</h1><p>{t('Reload the page to fetch the latest version. If you just submitted a change, check the saved record before trying it again.')}</p><div className="product-actions"><button type="button" className="button primary" onClick={() => window.location.reload()}><RotateCcw size={16}/>{t('Reload page')}</button><Link className="button" to={location.pathname === '/' ? '/customers' : '/'}>{location.pathname === '/' ? t('Go to customers') : t('Back to workbench')}</Link></div></div></section>;
}

class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
        if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
    }
    render() { return this.state.failed ? <PageFailure/> : this.props.children; }
}

export function PageRecovery({ children }: { children: ReactNode }) {
    const location = useLocation();
    return <PageErrorBoundary resetKey={location.pathname}><Suspense fallback={<Loading/>}>{children}</Suspense></PageErrorBoundary>;
}
