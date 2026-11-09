import { z } from 'zod';
export * from './management.js';
export * from './product.js';
export * from './advancement.js';
export * from './production.js';
export * from './access.js';
export const CONTRACT_VERSION = '1' as const;
export const roles = ['admin', 'manager', 'sales', 'engineer'] as const;
export type Role = typeof roles[number];
export type Actor = {
    tenantId: string;
    memberId: string;
    role: Role;
    authorizationVersion?: number;
};
export type Member = {
    id: string;
    name: string;
    email: string;
    role: Role;
    active: boolean;
    revision: number;
};
export type Customer = {
    id: string;
    name: string;
    industry: string;
    contact: string;
    email: string;
    ownerId: string;
    stage: string;
    revision: number;
};
export type Evidence = {
    id: string;
    customerId: string;
    kind: 'meeting' | 'reply' | 'note';
    title: string;
    body: string;
    createdAt: string;
};
export type Fact = {
    id: string;
    customerId: string;
    key: string;
    value: string;
    evidenceId: string;
    quote: string;
    status: 'candidate' | 'confirmed' | 'rejected';
    revision: number;
    reviewedBy: string | null;
    reviewNote: string | null;
    reviewedAt: string | null;
};
export type ActionStatus = 'draft' | 'approved' | 'executing' | 'succeeded' | 'unknown' | 'failed' | 'cancelled';
export type Receipt = {
    id: string;
    operationId: string;
    reference: string;
    recordedAt: string;
    simulated: boolean;
};
export type IntentAction = {
    id: string;
    customerId: string;
    runId: string;
    kind: 'send_proposal';
    status: ActionStatus;
    revision: number;
    approvedRevision: number | null;
    approvedBy: string | null;
    recipient: string;
    subject: string;
    body: string;
    evidenceIds: string[];
    operationId: string;
    receipt: Receipt | null;
    lastError: string | null;
    updatedAt: string;
    executionActorId?: string | null;
    resolutionNote?: string | null;
    transport?: 'simulated' | 'webhook';
};
export type Commitment = {
    id: string;
    customerId: string;
    actionId: string;
    title: string;
    status: 'open' | 'fulfilled' | 'cancelled';
    dueAt: string | null;
    evidenceId: string;
    completionReceiptId: string | null;
};
export type PlanningRun = {
    id: string;
    customerId: string;
    evidenceId: string;
    status: 'queued' | 'planning' | 'waiting_approval' | 'waiting_reconciliation' | 'completed' | 'failed';
    actionId: string | null;
    model: string;
    error: string | null;
    createdAt: string;
};
export type FieldDefinition = {
    id: string;
    key: string;
    label: string;
    type: 'text' | 'number' | 'date' | 'select';
    required: boolean;
    enabled: boolean;
    options: string[];
};
export type FieldValue = string | number | null;
export type ModelConnection = {
    id: string;
    name: string;
    provider: 'fixture' | 'deepseek' | 'openai-compatible';
    model: string;
    enabled: boolean;
    purpose: 'reasoning' | 'extraction';
    baseUrl?: string | null;
    hasApiKey?: boolean;
    revision?: number;
    timeoutMs?: number;
    testedRevision?: number | null;
    testedAt?: string | null;
    testError?: string | null;
};
export type CustomerDetail = {
    customer: Customer;
    evidence: Evidence[];
    facts: Fact[];
    actions: IntentAction[];
    commitments: Commitment[];
    fields: FieldDefinition[];
    fieldValues: Record<string, FieldValue>;
};
export type Workspace = {
    name: string;
    tagline: string;
    assistantName: string;
};
export type WorkspaceSettings = {
    id: string;
    name: string;
    revision: number;
    memberCount: number;
    activeMemberCount: number;
};
export const workspaceUpdateInput = z.object({ name: z.string().trim().min(1).max(160), expectedRevision: z.number().int().positive() }).strict();
export type Bootstrap = {
    workspace: Workspace;
    user: Member;
    execution: {
        workflow: 'temporal';
        model: 'fixture' | 'configured';
        transport: 'simulated' | 'webhook';
    };
    stats: {
        decisions: number;
        active: number;
        completed: number;
    };
};
export type ActionCard = {
    id: string;
    title: string;
    description: string;
    label: string;
    href: string;
    tone: 'neutral' | 'attention' | 'success';
};
export type ChatReply = {
    text: string;
    model: string;
    sources: {
        id: string;
        title: string;
        quote: string;
    }[];
    cards: ActionCard[];
};
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const evidenceInput = z.object({ kind: z.enum(['meeting', 'reply', 'note']).default('meeting'), title: z.string().trim().min(1).max(200), body: z.string().trim().min(10).max(20000), locale: z.enum(['en', 'zh-CN']).default('en') }).strict();
export const actionEditInput = z.object({ expectedRevision: z.number().int().positive(), recipient: z.email().max(254), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20000) }).strict();
export const approvalInput = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const reconcileInput = z.object({ expectedRevision: z.number().int().positive(), outcome: z.enum(['delivered', 'not_delivered']), reference: z.string().trim().min(3).max(200) }).strict();
export const memberInput = z.object({ name: z.string().trim().min(1).max(80), email: z.email(), role: z.enum(roles), active: z.boolean() }).strict();
export const memberUpdateInput = memberInput.extend({ expectedRevision: z.number().int().positive() }).strict();
export const modelInput = z.object({ enabled: z.boolean(), expectedRevision: z.number().int().positive().optional() }).strict();
export const fieldInput = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).refine(value => !['constructor', 'prototype', '__proto__'].includes(value), "Field identifiers cannot use reserved system names"), label: z.string().trim().min(1).max(50), type: z.enum(['text', 'number', 'date', 'select']), required: z.boolean(), enabled: z.boolean(), options: z.array(z.string().trim().min(1).max(80)).max(20) }).strict().superRefine((v, ctx) => { if (v.type === 'select' && (v.options.length === 0 || new Set(v.options).size !== v.options.length))
    ctx.addIssue({ code: 'custom', message: "Choice options must be nonempty and unique", path: ['options'] }); });
export const fieldValuesInput = z.object({ expectedRevision: z.number().int().positive(), values: z.record(z.string(), z.union([z.string().max(2000), z.number().finite(), z.null()])) }).strict();
export const chatInput = z.object({ customerId: id, message: z.string().trim().min(1).max(2000) }).strict();
export const planSchema = z.object({ summary: z.string().min(1).max(2000), facts: z.array(z.object({ key: z.string().min(1).max(80), value: z.string().min(1).max(500), evidenceId: id, quote: z.string().min(1).max(2000) }).strict()).max(20), proposal: z.object({ recipient: z.email(), subject: z.string().min(1).max(200), body: z.string().min(1).max(20000), evidenceIds: z.array(id).min(1).max(20) }).strict() }).strict();
export type Plan = z.infer<typeof planSchema>;
export type PlanningContext = {
    run: PlanningRun;
    customer: Customer;
    evidence: Evidence[];
    fields: FieldDefinition[];
    fieldValues: Record<string, FieldValue>;
    model: ModelConnection;
    extractionModel?: ModelConnection;
    facts?: Fact[];
    actions?: IntentAction[];
    locale?: 'en' | 'zh-CN';
};
export type OutboxEvent = {
    id: string;
    tenantId: string;
    type: 'plan.requested' | 'action.approved' | 'action.reconciled';
    aggregateId: string;
    payload: {
        runId: string;
        revision?: number;
    };
};
export const WORKFLOW_QUEUE = 'intent-crm';
export const workflowId = (tenantId: string, runId: string) => `intent-${tenantId}-${runId}`;
