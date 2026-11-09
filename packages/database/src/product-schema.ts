import { sql } from 'drizzle-orm';
import { pgTable, text, integer, timestamp, uuid, jsonb, primaryKey, unique, foreignKey, index, check } from 'drizzle-orm/pg-core';
import { tenants, members, customers, facts } from './schema.js';
const tenantId = () => text('tenant_id').notNull().references(() => tenants.id);
const time = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const factReviews = pgTable('fact_reviews', {
  tenantId: tenantId(), id: text('id').notNull(), factId: text('fact_id').notNull(), revision: integer('revision').notNull(),
  fromStatus: text('from_status').notNull(), toStatus: text('to_status').notNull(), note: text('note').notNull(), actorId: text('actor_id').notNull(), createdAt: time('created_at'),
}, t => [primaryKey({ columns: [t.tenantId, t.id] }), unique().on(t.tenantId, t.factId, t.revision),
  foreignKey({ columns: [t.tenantId, t.factId], foreignColumns: [facts.tenantId, facts.id] }),
  foreignKey({ columns: [t.tenantId, t.actorId], foreignColumns: [members.tenantId, members.id] }),
  check('fact_reviews_transition', sql`${t.revision}>1 AND ${t.fromStatus}<>${t.toStatus} AND length(trim(${t.note}))>0`),
]);
export const conversations = pgTable('conversations', {
  tenantId: tenantId(), id: text('id').notNull(), customerId: text('customer_id').notNull(), memberId: text('member_id').notNull(), title: text('title').notNull(), createdAt: time('created_at'), updatedAt: time('updated_at'),
}, t => [primaryKey({ columns: [t.tenantId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
  foreignKey({ columns: [t.tenantId, t.memberId], foreignColumns: [members.tenantId, members.id] }),
  index('conversations_owner_page_idx').on(t.tenantId, t.memberId, t.updatedAt, t.id),
]);
export const conversationTurns = pgTable('conversation_turns', {
  tenantId: tenantId(), id: text('id').notNull(), conversationId: text('conversation_id').notNull(), requestId: uuid('request_id').notNull(), message: text('message').notNull(), reply: jsonb('reply').notNull(), createdAt: time('created_at'),
}, t => [primaryKey({ columns: [t.tenantId, t.id] }), unique().on(t.tenantId, t.conversationId, t.requestId),
  foreignKey({ columns: [t.tenantId, t.conversationId], foreignColumns: [conversations.tenantId, conversations.id] }),
  index('conversation_turns_page_idx').on(t.tenantId, t.conversationId, t.createdAt, t.id),
]);
