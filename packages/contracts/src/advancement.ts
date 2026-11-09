import { z } from 'zod';
import { calendarDate } from './management.js';
import type { Evidence, Fact, Opportunity, IntentAction, OpportunityDetail } from './index.js';

export const advancementInput = z.object({
  requestId: z.uuid(), expectedRevision: z.number().int().positive(),
  factId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), factRevision: z.number().int().positive(),
  goal: z.string().trim().min(3).max(200), dueDate: calendarDate, locale:z.enum(['en','zh-CN']).default('en'),
}).strict();
export const advancementPlanSchema = z.object({
  nextStep: z.string().trim().min(3).max(500), rationale: z.string().trim().min(3).max(1000),
}).strict();
export const advancementDecisionInput = z.object({
  expectedRevision: z.number().int().positive(), decision: z.enum(['apply', 'dismiss']),
  note: z.string().trim().min(3).max(1000),
}).strict();
export type AdvancementInput = z.input<typeof advancementInput>;
export type AdvancementPlan = z.infer<typeof advancementPlanSchema>;
export type AdvancementContext = { opportunity: Opportunity; fact: Fact; evidence: Evidence; goal: string; dueDate: string; previousDecisions?: AdvancementProposal[]; outcomes?: { actions: Pick<IntentAction,'id'|'status'|'receipt'|'resolutionNote'|'updatedAt'>[]; tasks: OpportunityDetail['tasks']; contract: OpportunityDetail['contract']; payments: OpportunityDetail['payments']; refunds: OpportunityDetail['refunds'] } };
export type AdvancementProposal = AdvancementPlan & {
  id: string; opportunityId: string; customerId: string; requestId: string; createdBy: string;
  opportunityRevision: number; factId: string; factRevision: number; evidenceId: string;
  evidenceTitle: string; quote: string; factValue: string; goal: string; dueDate: string;
  previousNextStep: string; previousDueDate: string|null;
  model: string; status: 'pending'|'applied'|'dismissed'; revision: number;
  createdAt: string; decidedAt: string|null; decidedBy: string|null; decisionNote: string|null;
  appliedOpportunityRevision: number|null;
};
