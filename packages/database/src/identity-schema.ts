import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, integer, primaryKey, foreignKey, index, check } from 'drizzle-orm/pg-core';
import { members } from './schema.js';

export const identityCredentials = pgTable('identity_credentials', {
  tenantId: text('tenant_id').notNull(), memberId: text('member_id').notNull(), passwordHash: text('password_hash').notNull(),
  updatedAt: timestamp('updated_at', {withTimezone:true}).notNull().defaultNow(),
}, t => [primaryKey({columns:[t.tenantId,t.memberId]}),foreignKey({columns:[t.tenantId,t.memberId],foreignColumns:[members.tenantId,members.id]})]);

export const identitySessions = pgTable('identity_sessions', {
  tokenHash:text('token_hash').primaryKey(),tenantId:text('tenant_id').notNull(),memberId:text('member_id').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),revokedAt:timestamp('revoked_at',{withTimezone:true}),
},t=>[check('identity_sessions_token_hash_check',sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),check('identity_sessions_check',sql`${t.expiresAt} > ${t.createdAt}`),foreignKey({columns:[t.tenantId,t.memberId],foreignColumns:[members.tenantId,members.id]}),index('identity_sessions_member').on(t.tenantId,t.memberId),index('identity_sessions_expiry').on(t.expiresAt)]);

export const identityLoginLimits = pgTable('identity_login_limits', {
  bucketKey:text('bucket_key').primaryKey(),attempts:integer('attempts').notNull(),resetAt:timestamp('reset_at',{withTimezone:true}).notNull(),
},t=>[check('identity_login_limits_bucket_key_check',sql`${t.bucketKey} ~ '^[0-9a-f]{64}$'`),check('identity_login_limits_attempts_check',sql`${t.attempts} >= 1`),index('identity_login_limits_expiry').on(t.resetAt)]);
