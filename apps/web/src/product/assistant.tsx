import { t, useLocale } from '../i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, BookOpen, FileText, LoaderCircle, MessageSquare, Plus, ShieldCheck, Sparkles, Target } from 'lucide-react';
import type { ChatTurn, Conversation, ConversationDetail, ConversationPage, Customer } from '@intent/contracts';
import { api, errorText, refresh, useResource } from '../api';
import { AiMark, Badge, dateTime, Dialog, Empty, ErrorBanner, Loading, PageHeading, PageLink } from '../components';
import { CreateCustomerButton } from './customers';
import { isChatDestination } from './chat-links';
type PendingMessage = {
    requestId: string;
    message: string;
};
export function Assistant() {
    useLocale();
    const customers = useResource<Customer[]>('/customers');
    const [params, setParams] = useSearchParams();
    const pending = useRef(new Map<string, PendingMessage>());
    const selected = params.get('customer') ?? customers.data?.[0]?.id ?? '';
    const [locked, setLocked] = useState(false);
    if (!customers.data)
        return <Loading error={customers.error}/>;
    const customer = customers.data.find(item => item.id === selected);
    function selectCustomer(id: string) { setParams({ customer: id }); }
    return <div className="persistent-chat"><PageHeading eyebrow={t("YOUR THINKING PARTNER")} title={t("Find the next step with Intent")} description={t("Keep private customer conversations connected to evidence and business context.")}><Badge>{t("AI-assisted workspace")}</Badge></PageHeading><ErrorBanner error={customers.error} retry/>{!customers.data.length ? <div className="panel"><Empty icon={<MessageSquare size={27}/>} title={t("Start a conversation about a customer")} description={t("Create a customer and add evidence to discuss next steps with Intent.")}><CreateCustomerButton /></Empty></div> : <><div className="panel chat-context"><div className="row"><span className="small muted">{t("Customer context")}</span><select aria-label={t("Select conversation customer")} value={selected} disabled={locked} onChange={event => selectCustomer(event.target.value)}>{!customer && <option value={selected}>{t("This customer is unavailable")}</option>}{customers.data.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>{customer && <PageLink href={`/customers/${customer.id}`}>{t("Customer workspace")}</PageLink>}</div>{customer ? <CustomerConversations key={selected} customer={customer} selectedId={params.get('conversation')} select={id => setParams({ customer: selected, ...(id ? { conversation: id } : {}) })} pending={pending.current} locked={locked} onLocked={setLocked}/> : <div className="panel"><Empty title={t("This customer does not exist or is no longer accessible")} description={t("Select a customer you are authorized to access and continue their conversation.")}/></div>}</>}</div>;
}
function CustomerConversations({ customer, selectedId, select, pending, locked, onLocked }: {
    customer: Customer;
    selectedId: string | null;
    select: (id: string | null) => void;
    pending: Map<string, PendingMessage>;
    locked: boolean;
    onLocked: (value: boolean) => void;
}) {
    useLocale();
    const sessions = useResource<ConversationPage>(`/conversations?customerId=${customer.id}`);
    const [more, setMore] = useState<Conversation[]>([]);
    const [cursor, setCursor] = useState<string | null | undefined>(undefined);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState('');
    const [creating, setCreating] = useState(false);
    const list = [...(sessions.data?.items ?? []), ...more].filter((item, index, items) => items.findIndex(other => other.id === item.id) === index);
    const next = cursor === undefined ? sessions.data?.nextCursor : cursor;
    async function loadMore() {
        if (!next)
            return;
        setLoadingMore(true);
        setError('');
        try {
            const page = await api<ConversationPage>(`/conversations?customerId=${customer.id}&cursor=${next}`);
            setMore(items => [...items, ...page.items]);
            setCursor(page.nextCursor);
        }
        catch (error) {
            setError(errorText(error));
        }
        finally {
            setLoadingMore(false);
        }
    }
    return <div className="persistent-chat-layout"><aside className="conversation-sidebar"><div className="conversation-sidebar-heading"><h2>{t("My customer conversations")}</h2><button className="icon-button" aria-label={t("New conversation")} disabled={locked} onClick={() => setCreating(true)}><Plus size={17}/></button></div><ErrorBanner error={sessions.error ?? error} retry={Boolean(sessions.error)}/><div className="conversation-list">{!sessions.data ? <p className="conversation-empty">{t("Loading conversations\u2026")}</p> : list.length ? list.map(item => <button key={item.id} className={item.id === selectedId ? 'active' : ''} disabled={locked} onClick={() => select(item.id)}><strong>{item.title}</strong><span>{dateTime(item.updatedAt)}</span></button>) : <p className="conversation-empty">{t("Conversations are private. Messages and citations are retained after creation.")}</p>}</div>{next && <button className="button full-width" disabled={loadingMore || locked} onClick={() => void loadMore()}>{loadingMore ? t("Loading\u2026") : t("Load more conversations")}</button>}</aside>{selectedId ? <ConversationView key={selectedId} id={selectedId} customer={customer} pendingStore={pending} onLocked={onLocked}/> : <section className="panel chat-panel"><div className="chat-welcome"><AiMark large/><h2>{t("Better context, better decisions.")}</h2><p>{t("Start with") + " "}{customer.name}{" " + t("and create a new topic,")}<br />{t("or continue an earlier conversation from the list.")}</p><button className="button primary" onClick={() => setCreating(true)}><Plus size={15}/>{t("Create customer conversation")}</button></div><div className="session-switch-note">{t("Each conversation belongs to one customer. Selecting another customer shows that customer\u2019s private conversations.")}</div></section>}{creating && <NewConversation customer={customer} onClose={() => setCreating(false)} onCreated={item => { setCreating(false); refresh(); select(item.id); }}/>}</div>;
}
function NewConversation({ customer, onClose, onCreated }: {
    customer: Customer;
    onClose: () => void;
    onCreated: (item: Conversation) => void;
}) {
    useLocale();
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const mounted = useRef(true);
    const submitting = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (submitting.current)
            return;
        submitting.current = true;
        setBusy(true);
        setError('');
        try {
            const conversation = await api<Conversation>('/conversations', 'POST', { customerId: customer.id, title });
            if (mounted.current)
                onCreated(conversation);
        }
        catch (error) {
            if (mounted.current)
                setError(errorText(error));
        }
        finally {
            submitting.current = false;
            if (mounted.current)
                setBusy(false);
        }
    }
    return <Dialog title={t("New Intent conversation")} subtitle={t("Customer context: {0}", customer.name)} busy={busy} onClose={onClose}><form className="dialog-body form-stack product-form" onSubmit={submit}><ErrorBanner error={error}/><label>{t("Conversation title")}<input autoFocus required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder={t("For example: Weekly follow-up and proposal preparation")}/></label><p className="product-caption">{t("Only you can access this conversation. Customer permissions are checked on every visit.")}</p><div className="dialog-footer"><button className="button" type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="button primary" disabled={busy}>{busy ? t("Creating\u2026") : t("Create conversation")}</button></div></form></Dialog>;
}
function ConversationView({ id, customer, pendingStore, onLocked }: {
    id: string;
    customer: Customer;
    pendingStore: Map<string, PendingMessage>;
    onLocked: (value: boolean) => void;
}) {
    useLocale();
    const [detail, setDetail] = useState<ConversationDetail | null>(null);
    const [message, setMessage] = useState('');
    const [pending, setPending] = useState<PendingMessage | null>(pendingStore.get(id) ?? null);
    const [busy, setBusy] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const alive = useRef(true);
    const sending = useRef(false);
    const bottom = useRef<HTMLDivElement>(null);
    useEffect(() => { alive.current = true; return () => { alive.current = false; onLocked(false); }; }, []);
    useEffect(() => {
        let current = true;
        setError('');
        void api<ConversationDetail>(`/conversations/${id}`).then(value => {
            if (!current || !alive.current)
                return;
            if (value.conversation.customerId !== customer.id) {
                setError(t("This conversation belongs to another customer. Open it from that customer\u2019s context."));
                return;
            }
            setDetail(value);
            const local = pendingStore.get(id);
            if (local && value.turns.some(turn => turn.requestId === local.requestId)) {
                pendingStore.delete(id);
                setPending(null);
            }
        }).catch(error => {
            if (current && alive.current)
                setError(errorText(error));
        });
        return () => { current = false; };
    }, [id, customer.id, attempt]);
    async function loadOlder() {
        if (!detail?.olderCursor)
            return;
        setLoadingOlder(true);
        setError('');
        try {
            const older = await api<ConversationDetail>(`/conversations/${id}?before=${detail.olderCursor}`);
            if (alive.current)
                setDetail(value => value ? { ...value, turns: [...older.turns, ...value.turns].filter((turn, index, items) => items.findIndex(item => item.id === turn.id) === index), olderCursor: older.olderCursor } : value);
        }
        catch (error) {
            if (alive.current)
                setError(errorText(error));
        }
        finally {
            if (alive.current)
                setLoadingOlder(false);
        }
    }
    async function send(question: string, retry?: PendingMessage) {
        if (sending.current || !detail || !question.trim())
            return;
        sending.current = true;
        const input = retry ?? (pending?.message === question.trim() ? pending : { requestId: crypto.randomUUID(), message: question.trim() });
        pendingStore.set(id, input);
        setPending(input);
        setBusy(true);
        onLocked(true);
        setError('');
        try {
            const turn = await api<ChatTurn>(`/conversations/${id}/messages`, 'POST', input);
            if (pendingStore.get(id)?.requestId === input.requestId)
                pendingStore.delete(id);
            if (alive.current) {
                setDetail(value => value ? { ...value, turns: value.turns.some(item => item.id === turn.id) ? value.turns : [...value.turns, turn] } : value);
                setPending(null);
                setMessage('');
                refresh();
                requestAnimationFrame(() => bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
            }
        }
        catch (error) {
            if (alive.current)
                setError(errorText(error));
        }
        finally {
            sending.current = false;
            if (alive.current) {
                setBusy(false);
                onLocked(false);
            }
        }
    }
    if (!detail)
        return <section className="panel chat-panel">{error ? <div className="empty"><ErrorBanner error={error}/><button className="button" onClick={() => setAttempt(value => value + 1)}>{t("Reload conversation")}</button></div> : <Loading />}</section>;
    return <section className="panel chat-panel"><div className="chat-context"><div><strong>{detail.conversation.title}</strong><p className="product-caption">{customer.name}{" " + t("\u00B7 Private conversation \u00B7 Saved automatically")}</p></div><Badge>{t("Authorized customer context")}</Badge></div><div className="chat-messages" aria-live="polite">{detail.olderCursor && <button className="button full-width" disabled={loadingOlder || busy} onClick={() => void loadOlder()}>{loadingOlder ? t("Loading\u2026") : t("Load earlier messages")}</button>}{!detail.turns.length && !pending ? <div className="chat-welcome"><AiMark large/><h2>{t("What would you like to understand first?")}</h2><p>{t("Using the existing records and evidence for") + " "}{customer.name}{" " + t(",")}<br />{t("I can prepare traceable next-step suggestions.")}</p><div className="prompt-grid">{[t("What should I pay attention to for this customer?"), t("What should I do next to follow up?"), t("What information is missing from this customer\u2019s records?")].map((prompt, index) => <button disabled={busy} key={prompt} onClick={() => void send(prompt)}><span>{index === 0 ? <BookOpen size={17}/> : index === 1 ? <Target size={17}/> : <FileText size={17}/>}</span>{prompt}<ArrowUpRight size={14}/></button>)}</div></div> : detail.turns.map(turn => <ChatMessage key={turn.id} turn={turn}/>)}{busy && <div className="assistant-thinking"><AiMark /><span><LoaderCircle size={15} className="spin"/>{t("Preparing and saving the answer\u2026")}</span></div>}<ErrorBanner error={error}/>{pending && !busy && <div className="pending-message"><strong>{t("This message has not been confirmed as saved")}</strong><p>{pending.message}</p><p>{t("Retrying uses the same request ID. If the server already saved it, the original answer is returned.")}</p><div className="product-actions"><button className="button" onClick={() => setMessage(pending.message)}>{t("Edit message")}</button><button className="button primary" onClick={() => void send(pending.message, pending)}>{t("Retry this message")}</button></div></div>}<div ref={bottom}/></div><form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(message); }}><label className="sr-only" htmlFor="chat-message">{t("Message to Intent")}</label><textarea id="chat-message" value={message} disabled={busy} maxLength={2000} rows={2} placeholder={t("What would you like to know about {0}?", customer.name)} onChange={event => setMessage(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send(message);
            }
        }}/><div className="between"><span><ShieldCheck size={12}/>{t("Authorized customer context \u00B7 Business changes require review")}</span><button className="send-button" aria-label={t("Send message")} disabled={busy || !message.trim()}><ArrowUpRight size={19}/></button></div></form></section>;
}
function ChatMessage({ turn }: {
    turn: ChatTurn;
}) { useLocale(); return <div className="chat-turn"><div className="user-message">{turn.message}</div><div className="assistant-message"><AiMark /><div className="grow"><div className="message-author">{t("Intent") + " "}<span>{turn.reply.model} · {dateTime(turn.createdAt)}</span></div><p className="reply-text">{turn.reply.text}</p>{turn.reply.sources.length > 0 && <div className="chat-sources"><h4><FileText size={13}/>{t("Supporting evidence")}</h4>{turn.reply.sources.map(source => <blockquote key={source.id}><strong>{source.title}</strong><p>“{source.quote}”</p></blockquote>)}</div>}{turn.reply.cards.length > 0 && <div className="chat-cards">{turn.reply.cards.filter(card => isChatDestination(card.href)).map(card => <Link key={card.id} to={card.href} className={`chat-action ${card.tone}`}><div><strong>{card.title}</strong><p>{card.description}</p></div><span>{card.label}<ArrowUpRight size={14}/></span></Link>)}</div>}</div></div></div>; }
