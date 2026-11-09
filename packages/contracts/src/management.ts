import { z } from 'zod';
import type { Evidence, Member } from './index.js';
export const opportunityStages = ['discovery', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
export const forecastCategories = ['pipeline', 'best_case', 'commit', 'excluded'] as const;
export type OpportunityStage = typeof opportunityStages[number];
export type ForecastCategory = typeof forecastCategories[number];
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const calendarDate = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, "Invalid date");
export const monthPeriod = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const moneyCents = z.number().int().min(1).max(1000000000000);
const opportunityFields = {
    title: z.string().trim().min(2).max(160), customerId: id, ownerId: id, amountCents: moneyCents,
    expectedCloseDate: calendarDate, stage: z.enum(opportunityStages), forecastCategory: z.enum(forecastCategories),
    nextStep: z.string().trim().max(500), nextStepDueDate: calendarDate.nullable(), evidenceId: id.nullable(),
    lostReason: z.string().trim().max(500).nullable(),
};
export const opportunityInput = z.object(opportunityFields).strict();
export const opportunityUpdateInput = z.object({ ...opportunityFields, expectedRevision: z.number().int().positive(), note: z.string().trim().min(3).max(1000) }).strict();
export const opportunityQuery = z.object({ customerId: id.optional() }).strict();
export const managementQuery = z.object({ period: monthPeriod, ownerId: id.optional() }).strict();
export const targetInput = z.object({ period: monthPeriod, ownerId: id.nullable(), bookingsTargetCents: moneyCents, collectionTargetCents: moneyCents, expectedRevision: z.number().int().min(0) }).strict();
export const snapshotInput = z.object({ period: monthPeriod, ownerId: id.nullable() }).strict();
export const contractInput = z.object({ expectedRevision: z.number().int().positive(), amountCents: moneyCents, signedDate: calendarDate, reference: z.string().trim().min(3).max(180), installments: z.array(z.object({ dueDate: calendarDate, amountCents: moneyCents }).strict()).min(1).max(24) }).strict();
export const paymentInput = z.object({ amountCents: moneyCents, paidDate: calendarDate, reference: z.string().trim().min(3).max(180) }).strict();
export const opportunityTaskInput = z.object({ title: z.string().trim().min(3).max(200), assigneeId: id, dueDate: calendarDate }).strict();
export const taskCompletionInput = z.object({ expectedRevision: z.number().int().positive(), completionNote: z.string().trim().min(3).max(1000) }).strict();
export type Opportunity = z.infer<typeof opportunityInput> & {
    id: string;
    currency: 'CNY';
    customerName: string;
    ownerName: string;
    revision: number;
    stageEnteredAt: string;
    closedDate: string | null;
    createdAt: string;
    updatedAt: string;
};
export type OpportunityHistory = {
    id: string;
    opportunityId: string;
    revision: number;
    actorId: string;
    actorName: string;
    note: string;
    before: Opportunity | null;
    after: Opportunity;
    createdAt: string;
};
export type SalesContract = {
    id: string;
    opportunityId: string;
    customerId: string;
    ownerId: string;
    amountCents: number;
    currency: 'CNY';
    signedDate: string;
    reference: string;
    createdAt: string;
    cancelledAt?: string | null;
};
export type Receivable = {
    id: string;
    contractId: string;
    opportunityId: string;
    ownerId: string;
    dueDate: string;
    amountCents: number;
    paidCents: number;
    remainingCents: number;
};
export type PaymentRecord = {
    id: string;
    receivableId: string;
    contractId: string;
    opportunityId: string;
    ownerId: string;
    amountCents: number;
    paidDate: string;
    reference: string;
    createdAt: string;
    reversedAt?: string | null;
};
export type RefundRecord = Omit<PaymentRecord, 'paidDate'> & { paymentId: string; refundedDate: string; evidenceId: string; actorId: string; note: string; };
export type OpportunityTask = {
    id: string;
    opportunityId: string;
    title: string;
    assigneeId: string;
    assigneeName: string;
    dueDate: string;
    status: 'open' | 'completed' | 'cancelled';
    completionNote: string | null;
    revision: number;
    createdAt: string;
    completedAt: string | null;
};
export type OpportunityDetail = {
    opportunity: Opportunity;
    history: OpportunityHistory[];
    evidence: Evidence[];
    contract: SalesContract | null;
    cancelledContracts?: SalesContract[];
    corrections?: {
        id: string;
        kind: string;
        note: string;
        evidenceId: string;
        actorId: string;
        createdAt: string;
    }[];
    receivables: Receivable[];
    payments: PaymentRecord[];
    refunds?: RefundRecord[];
    tasks: OpportunityTask[];
};
export type SalesTarget = Omit<z.infer<typeof targetInput>, 'expectedRevision'> & {
    revision: number;
    updatedAt: string;
};
export type ManagementMetrics = {
    bookedCents: number;
    collectedCents: number;
    dueCents: number;
    dueCollectedCents: number;
    overdueCents: number;
    commitCents: number;
    bestCaseCents: number;
    pipelineCents: number;
    forecastCents: number;
    upsideCents: number;
    bookingAttainment: number | null;
    collectionAttainment: number | null;
    forecastGapCents: number | null;
    openCount: number;
    wonCount: number;
    lostCount: number;
    winRate: number | null;
};
export type ManagementRisk = {
    id: string;
    opportunityId: string;
    customerId: string;
    title: string;
    reason: string;
    kind: 'close_overdue' | 'next_step_overdue' | 'next_step_missing' | 'stage_stalled' | 'evidence_missing';
    severity: 'high' | 'medium';
    amountCents: number;
    evidenceId: string | null;
};
export type ForecastItem = Pick<Opportunity, 'id' | 'title' | 'customerName' | 'amountCents' | 'stage' | 'forecastCategory' | 'expectedCloseDate' | 'ownerId'>;
export type ForecastSnapshot = {
    id: string;
    period: string;
    ownerId: string | null;
    capturedAt: string;
    capturedBy: string;
    metrics: ManagementMetrics;
    items: ForecastItem[];
};
export type ForecastChange = {
    opportunityId: string;
    title: string;
    kind: 'added' | 'removed' | 'changed';
    before: ForecastItem | null;
    after: ForecastItem | null;
};
export type ManagementOverview = {
    period: string;
    ownerId: string | null;
    asOfDate: string;
    generatedAt: string;
    currency: 'CNY';
    target: SalesTarget | null;
    metrics: ManagementMetrics;
    stages: {
        stage: OpportunityStage;
        count: number;
        amountCents: number;
    }[];
    owners: {
        ownerId: string;
        name: string;
        bookedCents: number;
        openCents: number;
        commitCents: number;
        atRiskCents: number;
        openCount: number;
    }[];
    opportunities: Opportunity[];
    risks: ManagementRisk[];
    receivables: Receivable[];
    tasks: OpportunityTask[];
    latestSnapshot: ForecastSnapshot | null;
    snapshotDeltaCents: number | null;
    snapshotChanges: ForecastChange[];
};
export type ManagementData = {
    opportunities: Opportunity[];
    contracts: SalesContract[];
    receivables: Receivable[];
    payments: PaymentRecord[];
    refunds?: RefundRecord[];
    tasks: OpportunityTask[];
    members: Member[];
};
