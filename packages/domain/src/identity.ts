import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { loginInput, changePasswordInput, setPasswordInput, passwordValue, type Actor, type Member } from '@intent/contracts';
import type { Database, Connection } from '@intent/database';
import { DomainError } from './index.js';
import { currentActor } from './authorization.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (code: string, status: number, message: string): never => { throw new DomainError(code, status, message); };
const invalid = () => fail('UNAUTHENTICATED', 401, "Invalid workspace, email or password, or the account is unavailable.");
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => { const result = schema.safeParse(input); if (!result.success)
    return fail('VALIDATION', 400, "Invalid input. Check required fields and password length."); return result.data; };
const member = (row: Record<string, unknown>): Member => ({ id: String(row.id), name: String(row.name), email: String(row.email), role: row.role as Member['role'], active: Boolean(row.active), revision: Number(row.revision) });
// OWASP scrypt minimum: N=2^17, r=8, p=1. Limit concurrent memory use to 256 MiB.
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
let activeHashes = 0;
async function derive(password: string, salt: Buffer): Promise<Buffer> {
    if (activeHashes >= 2)
        throw new DomainError('RATE_LIMITED', 429, "Authentication is busy. Try again shortly.", 1);
    activeHashes++;
    try {
        return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, SCRYPT, (error, key) => error ? reject(error) : resolve(key)));
    }
    finally {
        activeHashes--;
    }
}
async function encodePassword(password: string): Promise<string> {
    const salt = randomBytes(16), key = await derive(password, salt);
    return `scrypt$131072$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
const dummyHash = `scrypt$131072$8$1$${randomBytes(16).toString('base64url')}$${randomBytes(64).toString('base64url')}`;
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
    const match = /^scrypt\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(encoded);
    // Invalid/unconfigured credentials still pay the same password derivation cost.
    if (!match) {
        await verifyPassword(password, dummyHash);
        return false;
    }
    const actual = await derive(password, Buffer.from(match[1]!, 'base64url'));
    return timingSafeEqual(actual, Buffer.from(match[2]!, 'base64url'));
}
const bootstrapInput = z.object({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), workspaceName: z.string().trim().min(1).max(160), adminName: z.string().trim().min(1).max(80), email: z.email().max(254), password: passwordValue }).strict();
export class IdentityService {
    constructor(readonly db: Database) { }
    private async audit(tx: Connection, actor: Actor, event: string, entityId: string) {
        await tx.query('INSERT INTO audit_events(tenant_id,id,actor_id,event,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)', [actor.tenantId, `aud_${randomUUID().replaceAll('-', '')}`, actor.memberId, event, entityId, '{}']);
    }
    private async actor(tx: Connection, ctx: Actor): Promise<Actor> {
        return currentActor(tx, ctx);
    }
    private async reserveLogin(workspaceId: string, email: string, clientKey: string) {
        // Commit attempts before checking credentials: rejected logins must not roll back throttling.
        const allowed = await this.db.transaction(async (tx) => {
            for (const [key, limit] of [[`source:${clientKey.slice(0, 200)}`, 100], [`account:${workspaceId}:${email}`, 5]] as const) {
                const row = (await tx.query(`INSERT INTO identity_login_limits(bucket_key,attempts,reset_at) VALUES($1,1,now()+interval '15 minutes')
          ON CONFLICT(bucket_key) DO UPDATE SET attempts=CASE WHEN identity_login_limits.reset_at<=now() THEN 1 ELSE LEAST(identity_login_limits.attempts+1,$2+1) END,
          reset_at=CASE WHEN identity_login_limits.reset_at<=now() THEN now()+interval '15 minutes' ELSE identity_login_limits.reset_at END RETURNING attempts`, [hash(key), limit])).rows[0];
                if (row.attempts > limit)
                    return false;
            }
            await tx.query("DELETE FROM identity_login_limits WHERE bucket_key IN(SELECT bucket_key FROM identity_login_limits WHERE reset_at<now()-interval '1 day' LIMIT 100)");
            return true;
        });
        if (!allowed)
            throw new DomainError('RATE_LIMITED', 429, "Too many sign-in attempts. Try again in 15 minutes.", 900);
    }
    async login(input: z.input<typeof loginInput>, clientKey: string): Promise<{
        token: string;
        user: Member;
        actor: Actor;
        expiresAt: string;
    }> {
        const data = parse(loginInput, input), email = data.email.toLowerCase();
        await this.reserveLogin(data.workspaceId, email, clientKey);
        return this.db.transaction(async (tx) => {
            // Member and credential locks serialize login with deactivation and password changes.
            const row = (await tx.query('SELECT m.*,c.password_hash FROM members m JOIN identity_credentials c ON c.tenant_id=m.tenant_id AND c.member_id=m.id WHERE m.tenant_id=$1 AND lower(m.email)=$2 FOR SHARE OF m,c', [data.workspaceId, email])).rows[0];
            const valid = await verifyPassword(data.password, row?.password_hash ?? dummyHash);
            if (!row || !row.active || !valid)
                return invalid();
            const token = randomBytes(32).toString('base64url'), actor: Actor = { tenantId: data.workspaceId, memberId: row.id, role: row.role, authorizationVersion: row.authorization_version };
            const session = (await tx.query("INSERT INTO identity_sessions(token_hash,tenant_id,member_id,expires_at) VALUES($1,$2,$3,now()+interval '8 hours') RETURNING expires_at", [hash(token), actor.tenantId, actor.memberId])).rows[0];
            await tx.query('DELETE FROM identity_login_limits WHERE bucket_key=$1', [hash(`account:${data.workspaceId}:${email}`)]);
            await tx.query("DELETE FROM identity_sessions WHERE expires_at<now()-interval '30 days'");
            await this.audit(tx, actor, 'identity.login', actor.memberId);
            return { token, user: member(row), actor, expiresAt: new Date(session.expires_at).toISOString() };
        });
    }
    async authenticate(token: string): Promise<Actor> {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token))
            return invalid();
        const row = (await this.db.query('SELECT s.tenant_id,s.member_id,m.role,m.authorization_version FROM identity_sessions s JOIN members m ON m.tenant_id=s.tenant_id AND m.id=s.member_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND m.active=true', [hash(token)])).rows[0];
        if (!row)
            return invalid();
        return { tenantId: row.tenant_id, memberId: row.member_id, role: row.role, authorizationVersion: row.authorization_version };
    }
    async logout(token: string): Promise<void> {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token))
            return;
        await this.db.transaction(async (tx) => {
            const row = (await tx.query('UPDATE identity_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING tenant_id,member_id', [hash(token)])).rows[0];
            if (row)
                await this.audit(tx, { tenantId: row.tenant_id, memberId: row.member_id, role: 'sales' }, 'identity.logout', row.member_id);
        });
    }
    async changePassword(ctx: Actor, input: z.input<typeof changePasswordInput>): Promise<void> {
        const data = parse(changePasswordInput, input);
        await this.db.transaction(async (tx) => {
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`members:${ctx.tenantId}`]);
            const actor = await currentActor(tx, ctx, 'UPDATE');
            const current = (await tx.query('SELECT password_hash FROM identity_credentials WHERE tenant_id=$1 AND member_id=$2 FOR UPDATE', [actor.tenantId, actor.memberId])).rows[0];
            if (!await verifyPassword(data.currentPassword, current?.password_hash ?? dummyHash) || !current)
                return invalid();
            const encoded = await encodePassword(data.newPassword);
            await tx.query('UPDATE identity_credentials SET password_hash=$3,updated_at=now() WHERE tenant_id=$1 AND member_id=$2', [actor.tenantId, actor.memberId, encoded]);
            await tx.query('UPDATE members SET authorization_version=authorization_version+1 WHERE tenant_id=$1 AND id=$2', [actor.tenantId, actor.memberId]);
            await tx.query('UPDATE identity_sessions SET revoked_at=now() WHERE tenant_id=$1 AND member_id=$2 AND revoked_at IS NULL', [actor.tenantId, actor.memberId]);
            await this.audit(tx, actor, 'identity.password.changed', actor.memberId);
        });
    }
    async setMemberPassword(ctx: Actor, id: string, input: z.input<typeof setPasswordInput>): Promise<void> {
        const data = parse(setPasswordInput, input);
        await this.db.transaction(async (tx) => {
            // Match member administration lock order; concurrent cross-resets cannot deadlock.
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`members:${ctx.tenantId}`]);
            const actor = await this.actor(tx, ctx);
            if (actor.role !== 'admin')
                fail('FORBIDDEN', 403, "Only administrators can set member passwords.");
            const target = (await tx.query('SELECT id FROM members WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [actor.tenantId, id])).rows[0];
            if (!target)
                fail('NOT_FOUND', 404, "Member not found.");
            await tx.query('SELECT member_id FROM identity_credentials WHERE tenant_id=$1 AND member_id=$2 FOR UPDATE', [actor.tenantId, id]);
            const encoded = await encodePassword(data.password);
            await tx.query('INSERT INTO identity_credentials(tenant_id,member_id,password_hash) VALUES($1,$2,$3) ON CONFLICT(tenant_id,member_id) DO UPDATE SET password_hash=excluded.password_hash,updated_at=now()', [actor.tenantId, id, encoded]);
            await tx.query('UPDATE members SET authorization_version=authorization_version+1 WHERE tenant_id=$1 AND id=$2', [actor.tenantId, id]);
            await tx.query('UPDATE identity_sessions SET revoked_at=now() WHERE tenant_id=$1 AND member_id=$2 AND revoked_at IS NULL', [actor.tenantId, id]);
            await this.audit(tx, actor, 'identity.password.set', id);
        });
    }
    async bootstrapWorkspace(input: z.input<typeof bootstrapInput>): Promise<{
        tenantId: string;
        memberId: string;
    }> {
        const data = parse(bootstrapInput, input), encoded = await encodePassword(data.password);
        return this.db.transaction(async (tx) => {
            await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bootstrap:${data.workspaceId}`]);
            if ((await tx.query('SELECT 1 FROM tenants WHERE id=$1', [data.workspaceId])).rowCount)
                fail('CONFLICT', 409, "The workspace already exists. Initialization does not reset existing accounts or passwords.");
            const memberId = `usr_${randomUUID().replaceAll('-', '')}`;
            await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [data.workspaceId, data.workspaceName]);
            await tx.query("INSERT INTO members(tenant_id,id,name,email,role,active) VALUES($1,$2,$3,$4,'admin',true)", [data.workspaceId, memberId, data.adminName, data.email.toLowerCase()]);
            await tx.query('INSERT INTO identity_credentials(tenant_id,member_id,password_hash) VALUES($1,$2,$3)', [data.workspaceId, memberId, encoded]);
            for (const purpose of ['reasoning', 'extraction'])
                await tx.query("INSERT INTO model_connections(tenant_id,id,name,provider,model,purpose) VALUES($1,$2,$3,'fixture','fixture-v1',$4)", [data.workspaceId, `model_${purpose}`, purpose === 'reasoning' ? "Fixture reasoning (deterministic demo)" : "Fixture extraction (deterministic demo)", purpose]);
            await this.audit(tx, { tenantId: data.workspaceId, memberId, role: 'admin' }, 'identity.workspace.created', data.workspaceId);
            return { tenantId: data.workspaceId, memberId };
        });
    }
}
