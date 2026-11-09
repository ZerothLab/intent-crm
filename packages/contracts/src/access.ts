import { z } from 'zod';

export const auditQuery = z.object({
    category: z.enum(['all', 'access', 'models', 'delivery', 'workspace']).default('all'),
    actorId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
    cursor: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
}).strict();

export type AuditEntry = {
    id: string;
    actorId: string | null;
    actorName: string | null;
    event: string;
    entityId: string;
    createdAt: string;
    accessChange: { before?: { role: string; active: boolean }; after: { role: string; active: boolean }; sessionsRevoked: boolean } | null;
};
export type AuditPage = { items: AuditEntry[]; nextCursor: string | null };
