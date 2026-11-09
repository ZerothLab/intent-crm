import { pgTable, text, integer, timestamp, date, uuid, primaryKey, unique, foreignKey, index } from 'drizzle-orm/pg-core';
import { tenants, members, opportunities, facts, evidence } from './schema.js';

export const advancementProposals = pgTable('advancement_proposals', {
  tenantId: text('tenant_id').notNull().references(() => tenants.id), id: text('id').notNull(),
  opportunityId: text('opportunity_id').notNull(), customerId: text('customer_id').notNull(),
  requestId: uuid('request_id').notNull(), createdBy: text('created_by').notNull(),
  opportunityRevision: integer('opportunity_revision').notNull(), factId: text('fact_id').notNull(), factRevision: integer('fact_revision').notNull(),
  evidenceId: text('evidence_id').notNull(), evidenceTitle: text('evidence_title').notNull(), quote: text('quote').notNull(), factValue: text('fact_value').notNull(),
  goal: text('goal').notNull(), dueDate: date('due_date').notNull(), nextStep: text('next_step').notNull(), rationale: text('rationale').notNull(),
  previousNextStep: text('previous_next_step').notNull(), previousDueDate: date('previous_due_date'),
  model: text('model').notNull().default('fixture-v1'), status: text('status').notNull().default('pending'), revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: text('decided_by'), decisionNote: text('decision_note'), appliedOpportunityRevision: integer('applied_opportunity_revision'),
}, t => [
  primaryKey({ columns: [t.tenantId, t.id] }), unique().on(t.tenantId, t.createdBy, t.requestId),
  foreignKey({ columns: [t.tenantId, t.customerId, t.opportunityId], foreignColumns: [opportunities.tenantId, opportunities.customerId, opportunities.id] }),
  foreignKey({ columns: [t.tenantId, t.customerId, t.factId], foreignColumns: [facts.tenantId, facts.customerId, facts.id] }),
  foreignKey({ columns: [t.tenantId, t.customerId, t.evidenceId], foreignColumns: [evidence.tenantId, evidence.customerId, evidence.id] }),
  foreignKey({ columns: [t.tenantId, t.createdBy], foreignColumns: [members.tenantId, members.id] }),
  foreignKey({ columns: [t.tenantId, t.decidedBy], foreignColumns: [members.tenantId, members.id] }),
  index('advancement_opportunity_idx').on(t.tenantId, t.opportunityId, t.createdAt.desc(), t.id.desc()),
]);
