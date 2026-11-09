import { z } from 'zod';
import { calendarDate } from './management.js';

export const localeInput = z.enum(['en', 'zh-CN']).default('en');
export type Locale = z.infer<typeof localeInput>;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const revision = z.number().int().positive();
const note = z.string().trim().min(3).max(1000);
export const modelConfigInput = z.object({
  name: z.string().trim().min(1).max(100), provider: z.enum(['fixture', 'deepseek', 'openai-compatible']),
  model: z.string().trim().min(1).max(160), purpose: z.enum(['reasoning', 'extraction']),
  baseUrl: z.url().max(500).nullable(), apiKey: z.string().trim().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(1000).max(45000).default(30000),
}).strict();
export const modelConfigUpdateInput = modelConfigInput.extend({ expectedRevision: revision });
export const modelTestInput = z.object({ expectedRevision: revision }).strict();
export const actionResolutionInput = z.object({ expectedRevision: revision, note }).strict();
export const customerHandoverInput = z.object({ expectedRevision: revision, ownerId: id, note }).strict();
export const taskUpdateInput = z.object({ expectedRevision: revision, assigneeId: id, dueDate: calendarDate, status: z.enum(['open', 'cancelled']), note }).strict();
export const financialCorrectionInput = z.object({ requestId: z.uuid(), note, evidenceId: id }).strict();
export const refundInput = financialCorrectionInput.extend({ amountCents: z.number().int().positive().max(9007199254740991), refundedDate: calendarDate, reference: z.string().trim().min(3).max(200) });
export type RuntimeDiagnostics = {
  database: 'ok'; worker: 'healthy'|'unavailable'; lastHeartbeat: string|null;
  pendingEvents: number; oldestPendingAt: string|null; stalledRuns: number; uncertainActions: number;
  stalledItems: {id:string;customerId:string;customerName:string;createdAt:string}[];
};
export const runtimeRecoveryInput = z.object({ runId: id, note }).strict();
export const deliveryConfigInput = z.object({
  expectedRevision: z.number().int().nonnegative(), mode: z.enum(['simulated', 'webhook']),
  endpoint: z.url().max(500).nullable(), sender: z.email().max(254).nullable(),
  apiKey: z.string().min(16).max(4096).optional(), webhookSecret: z.string().min(32).max(4096).optional(),
}).strict();
export type DeliverySettings = { revision:number; mode:'simulated'|'webhook'; endpoint:string|null; sender:string|null; hasApiKey:boolean; hasWebhookSecret:boolean };
export const inboundEventInput = z.discriminatedUnion('type', [
  z.object({ eventId:id, type:z.literal('delivery'), operationId:id, outcome:z.enum(['delivered','not_delivered']), reference:z.string().trim().min(3).max(200) }).strict(),
  z.object({ eventId:id, type:z.literal('reply'), operationId:id, sender:z.email(), title:z.string().trim().min(1).max(200), body:z.string().trim().min(10).max(20000) }).strict(),
]);
