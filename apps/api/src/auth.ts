import { createHash, randomBytes } from 'node:crypto';
import { Controller, Get, Post, Param, Body, Query, Req, Res, Injectable, Inject, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { z } from 'zod';
import { IntentService, DomainError } from '@intent/domain';
import { loginInput, changePasswordInput, setPasswordInput, type Actor, type AuthMode } from '@intent/contracts';
import { IdentityService } from '../../../packages/domain/src/identity.js';
import { SERVICE, IDENTITY, type Request } from './tokens.js';
type Configuration = {
    mode: 'password' | 'development';
    origin: string | null;
    secure: boolean;
    cookieName: string;
};
interface Response {
    setHeader(name: string, value: string): void;
}
const fail = (code: string, status: number, message: string): never => { throw new DomainError(code, status, message); };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const loopback = (ip: string | undefined) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const localHostname = (hostname: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
const sessionInput = z.object({ memberId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional() }).strict();
export function validateAuthConfiguration(): Configuration {
    const configured = process.env.INTENT_AUTH_MODE;
    const mode = configured ?? (process.env.INTENT_DEV_AUTH === 'true' ? 'development' : 'password');
    if (mode !== 'development' && mode !== 'password')
        throw new Error('INTENT_AUTH_MODE must be password or development.');
    const secure = process.env.NODE_ENV === 'production';
    if (mode === 'development') {
        if (secure || process.env.INTENT_DEV_AUTH !== 'true')
            throw new Error('Production authentication cannot use development sessions; development requires INTENT_DEV_AUTH=true.');
        return { mode, origin: null, secure: false, cookieName: 'intent_session' };
    }
    const origin = process.env.INTENT_PUBLIC_ORIGIN;
    try {
        if (!origin)
            throw new Error();
        const url = new URL(origin);
        if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (secure && url.protocol !== 'https:'))
            throw new Error();
    }
    catch {
        throw new Error(`${secure ? 'Production authentication' : 'Password authentication'} requires INTENT_PUBLIC_ORIGIN as an exact ${secure ? 'HTTPS' : 'HTTP(S)'} origin without a path.`);
    }
    return { mode, origin, secure, cookieName: secure ? '__Host-intent_session' : 'intent_session' };
}
@Injectable()
export class AuthService {
    readonly configuration = validateAuthConfiguration();
    private readonly sessions = new Map<string, {
        memberId: string;
        expiresAt: number;
        authorizationVersion: number;
    }>();
    constructor(
    @Inject(SERVICE)
    private readonly service: IntentService,
    @Inject(IDENTITY)
    readonly identity: IdentityService) { }
    mode(): AuthMode { return { mode: this.configuration.mode, demo: this.configuration.mode === 'development', passwordMinLength: 12 }; }
    assertOrigin(req: Request) {
        if (this.configuration.mode === 'password' && req.headers.origin !== this.configuration.origin)
            fail('FORBIDDEN', 403, "The request origin does not match. Sign in from your workspace page.");
    }
    private cookie(req: Request): string {
        const header = req.headers.cookie;
        if (typeof header !== 'string')
            return '';
        const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${this.configuration.cookieName}=`));
        if (values.length !== 1)
            return '';
        return values[0]!.slice(this.configuration.cookieName.length + 1);
    }
    setCookie(response: Response, token: string | null) {
        response.setHeader('Set-Cookie', `${this.configuration.cookieName}=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 28800 : 0}${this.configuration.secure ? '; Secure' : ''}`);
        response.setHeader('Cache-Control', 'no-store');
    }
    async login(req: Request, body: unknown, response: Response) {
        if (this.configuration.mode !== 'password')
            return fail('FORBIDDEN', 403, "This workspace uses explicit demo authentication. Use the demo entrance.");
        this.assertOrigin(req);
        // Express resolves the nearest untrusted address using the explicit proxy allowlist.
        const result = await this.identity.login(loginInput.parse(body), req.ip ?? req.socket.remoteAddress ?? 'unknown');
        this.setCookie(response, result.token);
        return { user: result.user };
    }
    async issue(req: Request, body: unknown) {
        if (this.configuration.mode !== 'development' || !loopback(req.socket.remoteAddress))
            return fail('FORBIDDEN', 403, "Development sessions are available only locally with development authentication enabled.");
        const host = req.headers.host, origin = req.headers.origin;
        try {
            if (typeof host !== 'string' || !localHostname(new URL(`http://${host}`).hostname))
                throw new Error();
            if (origin) {
                if (typeof origin !== 'string')
                    throw new Error();
                const source = new URL(origin);
                if (source.protocol !== 'http:' || !localHostname(source.hostname) || ![String(process.env.PORT ?? process.env.API_PORT ?? 3100), '5173'].includes(source.port))
                    throw new Error();
            }
        }
        catch {
            return fail('FORBIDDEN', 403, "This request origin is not allowed for development sessions.");
        }
        const { memberId = 'usr_liming' } = sessionInput.parse(body), actor = await this.service.getActor(memberId, 'tenant_demo'), { user } = await this.service.bootstrap(actor);
        const now = Date.now();
        for (const [key, session] of this.sessions)
            if (session.expiresAt <= now)
                this.sessions.delete(key);
        if (this.sessions.size >= 10000)
            return fail('CONFLICT', 409, "Too many development sessions. Restart the development API.");
        const token = randomBytes(32).toString('base64url');
        this.sessions.set(digest(token), { memberId, authorizationVersion: actor.authorizationVersion!, expiresAt: now + 8 * 60 * 60 * 1000 });
        return { token, user };
    }
    async authenticate(req: Request): Promise<Actor> {
        if (this.configuration.mode === 'password') {
            if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? ''))
                this.assertOrigin(req);
            return this.identity.authenticate(this.cookie(req));
        }
        if (!loopback(req.socket.remoteAddress))
            return fail('UNAUTHENTICATED', 401, "Development sessions require a local connection.");
        const authorization = req.headers.authorization, token = typeof authorization === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1] : undefined;
        const session = token ? this.sessions.get(digest(token)) : undefined;
        if (!session || session.expiresAt <= Date.now())
            return fail('UNAUTHENTICATED', 401, "Establish a local development session first.");
        const actor = await this.service.getActor(session.memberId, 'tenant_demo');
        if (actor.authorizationVersion !== session.authorizationVersion)
            return fail('UNAUTHENTICATED', 401, 'Your access changed. Sign in again to continue.');
        return actor;
    }
    async logout(req: Request, response: Response) {
        this.assertOrigin(req);
        if (this.configuration.mode === 'password')
            await this.identity.logout(this.cookie(req));
        else {
            if (!loopback(req.socket.remoteAddress))
                return fail('UNAUTHENTICATED', 401, "Development sessions require a local connection.");
            const auth = req.headers.authorization;
            if (typeof auth === 'string' && auth.startsWith('Bearer '))
                this.sessions.delete(digest(auth.slice(7)));
        }
        this.setCookie(response, null);
        return { ok: true as const };
    }
    revokeDevelopmentSessions(actor: Actor, memberId: string) {
        if (actor.tenantId === 'tenant_demo')
            for (const [key, session] of this.sessions)
                if (session.memberId === memberId)
                    this.sessions.delete(key);
    }
}
@Injectable()
export class SessionGuard implements CanActivate {
    constructor(
    @Inject(AuthService)
    private readonly auth: AuthService) { }
    async canActivate(context: ExecutionContext) { const req = context.switchToHttp().getRequest<Request>(); req.actor = await this.auth.authenticate(req); return true; }
}
@Controller('api')
export class AuthController {
    constructor(
    @Inject(AuthService)
    private readonly auth: AuthService) { }
    @Get('auth/mode')
    mode(
    @Query()
    query: unknown) { z.object({}).strict().parse(query); return this.auth.mode(); }
    @Post('dev/session')
    development(
    @Req()
    req: Request,
    @Body()
    body: unknown) { return this.auth.issue(req, body); }
    @Post('auth/login')
    login(
    @Req()
    req: Request,
    @Body()
    body: unknown,
    @Res({ passthrough: true })
    response: Response) { return this.auth.login(req, body, response); }
    @Post('auth/logout')
    logout(
    @Req()
    req: Request,
    @Body()
    body: unknown,
    @Res({ passthrough: true })
    response: Response) { z.object({}).strict().parse(body); return this.auth.logout(req, response); }
    @Post('auth/password')
    @UseGuards(SessionGuard)
    async password(
    @Req()
    req: Request,
    @Body()
    body: unknown,
    @Res({ passthrough: true })
    response: Response) {
        await this.auth.identity.changePassword(req.actor!, changePasswordInput.parse(body));
        this.auth.revokeDevelopmentSessions(req.actor!, req.actor!.memberId);
        this.auth.setCookie(response, null);
        return { ok: true };
    }
    @Post('members/:id/credentials')
    @UseGuards(SessionGuard)
    async credentials(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Res({ passthrough: true })
    response: Response) {
        await this.auth.identity.setMemberPassword(req.actor!, id, setPasswordInput.parse(body));
        this.auth.revokeDevelopmentSessions(req.actor!, id);
        if (id === req.actor!.memberId)
            this.auth.setCookie(response, null);
        return { ok: true };
    }
}
