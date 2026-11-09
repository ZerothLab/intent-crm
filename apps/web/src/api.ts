import { getLocale, t } from './i18n';
import { useEffect, useState } from 'react';
let token: string | null = null;
let sessionGeneration = 0;
const listeners = new Set<() => void>();
const unauthorizedListeners = new Set<() => void>();
export function refresh() { listeners.forEach(listener => listener()); }
export function setAccessToken(value: string | null) { token = value; sessionGeneration++; }
export function onUnauthorized(listener: () => void) { unauthorizedListeners.add(listener); return () => { unauthorizedListeners.delete(listener); }; }
export class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
}
const unknownMutationNotice = () => t("The outcome is not confirmed. Reload the record before submitting again.");
async function readResponse<T>(response: Response, method: string): Promise<T> {
    const body = await response.json().catch(() => null);
    if (body === null) {
        const resultNotice = method === 'GET' ? t("Reload this page. If the problem persists, ask your administrator to check the service connection.") : unknownMutationNotice();
        throw new ApiError(response.status, 'INVALID_RESPONSE', t("The service returned unreadable data. {0}", resultNotice));
    }
    if (!response.ok)
        throw new ApiError(response.status, body?.code ?? 'HTTP_ERROR', body?.message ?? t("Request failed ({0}). Try again later.", response.status));
    return body as T;
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const requestGeneration = sessionGeneration;
    let response: Response;
    try {
        response = await fetch(`/api${path}`, { method, credentials: 'same-origin', signal: AbortSignal.timeout(path.includes('/messages')||path.includes('/advancements')||path.endsWith('/test')?60000:30000), headers: { 'Accept-Language':getLocale(), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify((path.endsWith('/evidence')||path.endsWith('/messages')||path.endsWith('/advancements'))&&body&&typeof body==='object'?{...body,locale:getLocale()}:body) }) });
    }
    catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        const resultNotice = method === 'GET' ? t("Check your connection and reload.") : unknownMutationNotice();
        throw new ApiError(0, timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', `${timedOut ? t("The request timed out.") : t("The service is temporarily unreachable.")} ${resultNotice}`);
    }
    if (response.status === 401 && requestGeneration === sessionGeneration) {
        setAccessToken(null);
        unauthorizedListeners.forEach(listener => listener());
    }
    const result = await readResponse<T>(response, method);
    if (requestGeneration !== sessionGeneration)
        throw new ApiError(401, 'SESSION_CHANGED', t('Your session changed. Reload the current workspace.'));
    return result;
}
export function useResource<T>(path: string | null, pollMs = 0) {
    const [state, setState] = useState<{
        path?: string | null;
        data?: T;
        error?: Error;
        loading: boolean;
    }>({ loading: true });
    useEffect(() => {
        let cancelled = false;
        let loading = false;
        let refreshRequested = false;
        setState(previous => previous.path === path ? { ...previous, error: undefined } : { path, loading: true });
        if (!path) {
            setState({ path, loading: false });
            return;
        }
        // Do not let an older, slower poll overwrite a newer business state.
        const load = async () => {
            if (loading)
                return;
            loading = true;
            try {
                const data = await api<T>(path);
                if (!cancelled)
                    setState({ path, data, loading: false });
            }
            catch (error) {
                if (!cancelled)
                    setState(previous => ({ ...(error instanceof ApiError && [401, 403, 404].includes(error.status) ? {} : previous), path, loading: false, error: error as Error }));
            }
            finally {
                loading = false;
                if (refreshRequested && !cancelled) {
                    refreshRequested = false;
                    void load();
                }
            }
        };
        // Refresh while loading must not cancel every slow response or lose a saved update.
        const reload = () => { if (loading)
            refreshRequested = true;
        else
            void load(); };
        listeners.add(reload);
        void load();
        const timer = pollMs ? window.setInterval(load, pollMs) : undefined;
        return () => { cancelled = true; listeners.delete(reload); if (timer)
            clearInterval(timer); };
    }, [path, pollMs]);
    return state.path === path ? state : { loading: true };
}
export function errorText(error: unknown) { return error instanceof Error ? error.message : t("The operation could not be completed. Please try again."); }
export function useActiveRefresh(active: boolean) {
    useEffect(() => { if (!active)
        return; const timer = window.setInterval(refresh, 2200); return () => clearInterval(timer); }, [active]);
}
