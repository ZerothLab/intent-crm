import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Controller, Get, Post, Patch, Param, Body, Query, Req, Module, Injectable, Inject, UseGuards, Catch, HttpException, type ExceptionFilter, type ArgumentsHost } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z, ZodError } from 'zod';
import { createDatabase } from '@intent/database';
import { IntentService, CommercialService, ProductService, ModelSettingsService, DeliveryService, AiRequestService, DomainError } from '@intent/domain';
import { FixtureModel, CompatibleModel, createModel } from '@intent/harness';
import { evidenceInput, actionEditInput, approvalInput, reconcileInput, memberInput, memberUpdateInput, modelInput, fieldInput, fieldValuesInput, chatInput, workspaceUpdateInput, type Actor } from '@intent/contracts';
import { opportunityInput, opportunityUpdateInput, opportunityQuery, managementQuery, contractInput, paymentInput, targetInput, snapshotInput, opportunityTaskInput, taskCompletionInput } from '@intent/contracts';
import { IdentityService } from '../../../packages/domain/src/identity.js';
import { SERVICE, COMMERCIAL, PRODUCT, IDENTITY, type Request } from './tokens.js';
import { AuthController, AuthService, SessionGuard, validateAuthConfiguration } from './auth.js';
import { customerInput, customerUpdateInput, factReviewInput, retryRunInput, conversationInput, conversationQuery, conversationDetailQuery, conversationMessageInput } from '@intent/contracts';
import { deliveryConfigInput, inboundEventInput, runtimeRecoveryInput, financialCorrectionInput, refundInput, actionResolutionInput, customerHandoverInput, taskUpdateInput, modelConfigInput, modelConfigUpdateInput, modelTestInput, type ChatTurn, type Locale, advancementInput, advancementDecisionInput } from '@intent/contracts';
import { auditQuery } from '@intent/contracts';
import { trustedProxies } from './proxy.js';
interface Response {
    status(code: number): Response;
    setHeader(name: string, value: string): void;
    json(body: unknown): void;
}
@Catch()
class ErrorFilter implements ExceptionFilter {
    catch(error: unknown, host: ArgumentsHost) {
        let status = 500, code = 'INTERNAL', message = "The service is temporarily unavailable. Try again later.";
        if (error instanceof DomainError) {
            status = error.status;
            code = error.code;
            message = error.message;
        }
        else if (error instanceof ZodError) {
            status = 400;
            code = 'VALIDATION';
            message = "Invalid input. Check required fields and data types.";
        }
        else if (error instanceof HttpException) {
            status = error.getStatus();
            code = status === 404 ? 'NOT_FOUND' : 'VALIDATION';
            message = status === 404 ? "Endpoint not found." : "Invalid request format.";
        }
        else if (error && typeof error === 'object' && 'code' in error) {
            if (error.code === '23505') {
                status = 409;
                code = 'CONFLICT';
                message = "This record or unique identifier already exists.";
            }
            else if (error.code === '23503') {
                status = 409;
                code = 'CONFLICT';
                message = "The related record is invalid.";
            }
        }
        const response = host.switchToHttp().getResponse<Response>();
        if (status === 429) response.setHeader('Retry-After', String(error instanceof DomainError ? error.retryAfter ?? 60 : 60));
        response.status(status).json({ code, message });
    }
}
@Controller('api')
class PublicController {
    constructor(
    @Inject(SERVICE)
    private readonly service: IntentService) { }
    @Post('integrations/:workspaceId/events')
    async inbound(
    @Req()
    r: Request,
    @Param('workspaceId')
    workspaceId: string,
    @Body()
    b: unknown) {
        const timestamp = r.headers['x-intent-timestamp'], signature = r.headers['x-intent-signature'];
        if (!r.rawBody || typeof timestamp !== 'string' || typeof signature !== 'string')
            throw new DomainError('UNAUTHENTICATED', 401, 'A signed integration event is required.');
        await new DeliveryService(this.service.db).verify(workspaceId, r.rawBody, timestamp, signature);
        return this.service.receiveIntegrationEvent(workspaceId, inboundEventInput.parse(b));
    }
    @Get('ready')
    async ready() { const result = await this.service.db.query("SELECT 1 FROM runtime_heartbeats WHERE heartbeat_at>now()-interval '30 seconds' LIMIT 1"); if (!result.rowCount)
        throw new DomainError('UNAVAILABLE', 503, 'Execution workers are unavailable.'); return { status: 'ready' }; }
    @Get('health')
    async health() { try {
        await this.service.db.query('SELECT 1');
        return { status: 'ok', database: 'ok' };
    }
    catch {
        throw new DomainError('UNAVAILABLE', 503, "The database is unavailable.");
    } }
}
@Injectable()
class ReplyService {
    constructor(
    @Inject(SERVICE)
    private readonly service: IntentService,
    @Inject(COMMERCIAL)
    private readonly commercial: CommercialService,
    @Inject(PRODUCT)
    private readonly product: ProductService) { }
    async reply(actor: Actor, customerId: string, message: string, history: ChatTurn[] = [], locale: Locale = 'en') {
        const detail = await this.service.getCustomer(actor, customerId);
        const runtime = await new ModelSettingsService(this.service.db).forActor(actor);
        const model = createModel(runtime);
        const opportunities = await this.commercial.listOpportunities(actor, customerId);
        const runs = await this.product.listRuns(actor, customerId);
        const reply = await model.reply(detail, message, opportunities, runs, history, locale);
        const current = await new ModelSettingsService(this.service.db).forActor(actor);
        if (current.connection.id !== runtime.connection.id || current.connection.revision !== runtime.connection.revision)
            throw new DomainError('CONFLICT', 409, 'Model settings changed while generating the answer.');
        await this.service.getCustomer(actor, customerId);
        const path = `/customers/${encodeURIComponent(customerId)}`;
        const allowed = new Set([path, `${path}?focus=fields`, `${path}?focus=facts`, `${path}?focus=runs`, ...detail.actions.map(a => `${path}?action=${encodeURIComponent(a.id)}`), ...opportunities.flatMap(o => { const p = `/opportunities/${encodeURIComponent(o.id)}`; return [p, `${p}?tab=finance`, `${p}?tab=tasks`, `${p}?focus=advance`]; })]);
        if (reply.cards.some(c => !allowed.has(c.href)))
            throw new DomainError('VALIDATION', 400, "The answer contains a page link outside the authorized context.");
        if (reply.sources.some(s => !detail.evidence.some(e => e.id === s.id && e.title === s.title && e.body.includes(s.quote))))
            throw new DomainError('VALIDATION', 400, "The answer cites content outside the authorized evidence.");
        return reply;
    }
}
@Controller('api')
@UseGuards(SessionGuard)
class ApiController {
    constructor(
    @Inject(SERVICE)
    private readonly service: IntentService,
    @Inject(ReplyService)
    private readonly replies: ReplyService) { }
    @Get('settings/audit')
    audit(@Req() r: Request, @Query() query: unknown) { return this.service.listAudit(r.actor!, auditQuery.parse(query)); }
    @Get('settings/delivery')
    delivery(
    @Req()
    r: Request) { return new DeliveryService(this.service.db).get(r.actor!); }
    @Patch('settings/delivery')
    saveDelivery(
    @Req()
    r: Request,
    @Body()
    b: unknown) { return new DeliveryService(this.service.db).save(r.actor!, deliveryConfigInput.parse(b)); }
    @Get('settings/runtime')
    diagnostics(
    @Req()
    r: Request) { return this.service.runtimeDiagnostics(r.actor!); }
    @Post('settings/runtime/recover')
    async recover(
    @Req()
    r: Request,
    @Body()
    b: unknown) { const input = runtimeRecoveryInput.parse(b); await this.service.recoverRun(r.actor!, input); return new ProductService(this.service.db).retryRun(r.actor!, input.runId, { reason: input.note }); }
    @Get('bootstrap')
    bootstrap(
    @Req()
    r: Request) { return this.service.bootstrap(r.actor!); }
    @Get('workspace')
    workspace(
    @Req()
    r: Request,
    @Query()
    q: unknown) { z.object({}).strict().parse(q); return this.service.getWorkspace(r.actor!); }
    @Patch('workspace')
    updateWorkspace(
    @Req()
    r: Request,
    @Query()
    q: unknown,
    @Body()
    b: unknown) { z.object({}).strict().parse(q); return this.service.updateWorkspace(r.actor!, workspaceUpdateInput.parse(b)); }
    @Get('customers')
    customers(
    @Req()
    r: Request) { return this.service.listCustomers(r.actor!); }
    @Get('customers/:id')
    customer(
    @Req()
    r: Request,
    @Param('id')
    id: string) { return this.service.getCustomer(r.actor!, id); }
    @Post('customers/:id/evidence')
    evidence(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.addEvidence(r.actor!, id, evidenceInput.parse(b)); }
    @Get('runs/:id')
    run(
    @Req()
    r: Request,
    @Param('id')
    id: string) { return this.service.getRun(r.actor!, id); }
    @Get('actions')
    actions(
    @Req()
    r: Request) { return this.service.listActions(r.actor!); }
    @Patch('actions/:id')
    edit(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.updateAction(r.actor!, id, actionEditInput.parse(b)); }
    @Post('actions/:id/approve')
    approve(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.approveAction(r.actor!, id, approvalInput.parse(b)); }
    @Post('actions/:id/reconcile')
    reconcile(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.reconcileAction(r.actor!, id, reconcileInput.parse(b)); }
    @Post('actions/:id/cancel')
    cancel(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.cancelAction(r.actor!, id, actionResolutionInput.parse(b)); }
    @Post('actions/:id/takeover')
    takeover(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.takeOverAction(r.actor!, id, actionResolutionInput.parse(b)); }
    @Get('members')
    members(
    @Req()
    r: Request) { return this.service.listMembers(r.actor!); }
    @Post('members')
    createMember(
    @Req()
    r: Request,
    @Body()
    b: unknown) { return this.service.createMember(r.actor!, memberInput.parse(b)); }
    @Patch('members/:id')
    updateMember(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.updateMember(r.actor!, id, memberUpdateInput.parse(b)); }
    @Get('models')
    models(
    @Req()
    r: Request) { return this.service.listModels(r.actor!); }
    @Post('models')
    createModel(
    @Req()
    r: Request,
    @Body()
    b: unknown) { return new ModelSettingsService(this.service.db).save(r.actor!, modelConfigInput.parse(b)); }
    @Patch('models/:id/configuration')
    configureModel(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return new ModelSettingsService(this.service.db).save(r.actor!, modelConfigUpdateInput.parse(b), id); }
    @Post('models/:id/test')
    async testModel(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) {
        const { expectedRevision } = modelTestInput.parse(b);
        const settings = new ModelSettingsService(this.service.db);
        await settings.forTest(r.actor!, id, expectedRevision);
        return new AiRequestService(this.service.db).run(r.actor!, `test:${id}:${expectedRevision}`, async () => {
            const runtime = await settings.forTest(r.actor!, id, expectedRevision);
            let error: string | null = null;
            try {
                if (runtime.connection.provider !== 'fixture')
                    await new CompatibleModel(runtime).test();
            }
            catch {
                error = 'Connection test failed. Check the endpoint, model, credential and network access.';
            }
            return settings.recordTest(r.actor!, id, expectedRevision, error);
        });
    }
    @Patch('models/:id')
    updateModel(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.updateModel(r.actor!, id, modelInput.parse(b)); }
    @Get('fields')
    fields(
    @Req()
    r: Request) { return this.service.listFields(r.actor!); }
    @Post('fields')
    createField(
    @Req()
    r: Request,
    @Body()
    b: unknown) { return this.service.createField(r.actor!, fieldInput.parse(b)); }
    @Patch('fields/:id')
    updateField(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.updateField(r.actor!, id, fieldInput.parse(b)); }
    @Patch('customers/:id/fields')
    updateValues(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.updateFieldValues(r.actor!, id, fieldValuesInput.parse(b)); }
    @Post('chat')
    async chat(
    @Req()
    r: Request,
    @Body()
    b: unknown) {
        const input = chatInput.parse(b);
        await this.service.getCustomer(r.actor!, input.customerId);
        return new AiRequestService(this.service.db).run(r.actor!, `chat:${randomUUID()}`, () => this.replies.reply(r.actor!, input.customerId, input.message));
    }
}
@Controller('api')
@UseGuards(SessionGuard)
class CommercialController {
    constructor(
    @Inject(COMMERCIAL)
    private readonly service: CommercialService) { }
    @Get('opportunities')
    list(
    @Req()
    r: Request,
    @Query()
    q: unknown) { return this.service.listOpportunities(r.actor!, opportunityQuery.parse(q).customerId); }
    @Post('opportunities')
    create(
    @Req()
    r: Request,
    @Body()
    b: unknown) { return this.service.createOpportunity(r.actor!, opportunityInput.parse(b)); }
    @Get('opportunities/:id')
    detail(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Query()
    q: unknown) { z.object({}).strict().parse(q); return this.service.getOpportunity(r.actor!, id); }
    @Get('opportunities/:id/advancements')
    advancements(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Query()
    q: unknown) { z.object({}).strict().parse(q); return this.service.listAdvancements(r.actor!, id); }
    @Post('opportunities/:id/advancements')
    async propose(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Query()
    q: unknown,
    @Body()
    b: unknown) {
        z.object({}).strict().parse(q);
        const input = advancementInput.parse(b);
        const prepared = await this.service.prepareAdvancement(r.actor!, id, input);
        if (prepared.kind === 'existing')
            return prepared.proposal;
        return new AiRequestService(this.service.db).run(r.actor!, `advance:${input.requestId}`, async () => {
            const current = await this.service.prepareAdvancement(r.actor!, id, input);
            if (current.kind === 'existing') return current.proposal;
            const runtime = await new ModelSettingsService(this.service.db).forActor(r.actor!);
            const plan = await createModel(runtime).advance(current.context, input.locale);
            return this.service.saveAdvancement(r.actor!, id, input, plan, runtime.connection);
        });
    }
    @Post('opportunities/:id/advancements/:proposalId/decision')
    decide(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Param('proposalId')
    proposalId: string,
    @Query()
    q: unknown,
    @Body()
    b: unknown) { z.object({}).strict().parse(q); return this.service.decideAdvancement(r.actor!, id, proposalId, advancementDecisionInput.parse(b)); }
    @Patch('opportunities/:id')
    edit(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.updateOpportunity(r.actor!, id, opportunityUpdateInput.parse(b)); }
    @Post('opportunities/:id/contract')
    contract(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.recordContract(r.actor!, id, contractInput.parse(b)); }
    @Post('receivables/:id/payments')
    payment(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.recordPayment(r.actor!, id, paymentInput.parse(b)); }
    @Post('payments/:id/refunds')
    refund(@Req() r:Request,@Param('id') id:string,@Body() b:unknown) { return this.service.recordRefund(r.actor!,id,refundInput.parse(b)); }
    @Post('refunds/:id/reverse')
    reverseRefund(@Req() r:Request,@Param('id') id:string,@Body() b:unknown) { return this.service.correctFinancialRecord(r.actor!,'refund_reversed',id,financialCorrectionInput.parse(b)); }
    @Post('contracts/:id/cancel')
    cancelContract(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.correctFinancialRecord(r.actor!, 'contract_cancelled', id, financialCorrectionInput.parse(b)); }
    @Post('payments/:id/reverse')
    reversePayment(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.correctFinancialRecord(r.actor!, 'payment_reversed', id, financialCorrectionInput.parse(b)); }
    @Post('opportunities/:id/tasks')
    task(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.createTask(r.actor!, id, opportunityTaskInput.parse(b)); }
    @Post('opportunity-tasks/:id/complete')
    completeTask(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.completeTask(r.actor!, id, taskCompletionInput.parse(b)); }
    @Patch('opportunity-tasks/:id')
    updateTask(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.updateTask(r.actor!, id, taskUpdateInput.parse(b)); }
    @Get('management/overview')
    overview(
    @Req()
    r: Request,
    @Query()
    q: unknown) { return this.service.getOverview(r.actor!, managementQuery.parse(q)); }
    @Post('management/targets')
    target(
    @Req()
    r: Request,
    @Body()
    b: unknown) { return this.service.saveTarget(r.actor!, targetInput.parse(b)); }
    @Post('management/snapshots')
    capture(
    @Req()
    r: Request,
    @Body()
    b: unknown) { return this.service.captureSnapshot(r.actor!, snapshotInput.parse(b)); }
    @Get('management/snapshots')
    snapshots(
    @Req()
    r: Request,
    @Query()
    q: unknown) { return this.service.listSnapshots(r.actor!, managementQuery.parse(q)); }
}
@Controller('api')
@UseGuards(SessionGuard)
class ProductController {
    constructor(
    @Inject(PRODUCT)
    private readonly service: ProductService,
    @Inject(ReplyService)
    private readonly replies: ReplyService) { }
    @Post('customers')
    createCustomer(
    @Req()
    r: Request,
    @Body()
    b: unknown) { return this.service.createCustomer(r.actor!, customerInput.parse(b)); }
    @Patch('customers/:id')
    updateCustomer(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.updateCustomer(r.actor!, id, customerUpdateInput.parse(b)); }
    @Post('customers/:id/handover')
    handover(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.handoverCustomer(r.actor!, id, customerHandoverInput.parse(b)); }
    @Post('facts/:id/review')
    reviewFact(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.reviewFact(r.actor!, id, factReviewInput.parse(b)); }
    @Get('facts/:id/reviews')
    factReviews(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Query()
    q: unknown) { z.object({}).strict().parse(q); return this.service.listFactReviews(r.actor!, id); }
    @Get('customers/:id/runs')
    runs(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Query()
    q: unknown) { z.object({}).strict().parse(q); return this.service.listRuns(r.actor!, id); }
    @Post('runs/:id/retry')
    retry(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) { return this.service.retryRun(r.actor!, id, retryRunInput.parse(b)); }
    @Get('work/inbox')
    inbox(
    @Req()
    r: Request,
    @Query()
    q: unknown) { z.object({}).strict().parse(q); return this.service.getWorkInbox(r.actor!); }
    @Get('conversations')
    conversations(
    @Req()
    r: Request,
    @Query()
    q: unknown) { return this.service.listConversations(r.actor!, conversationQuery.parse(q)); }
    @Post('conversations')
    createConversation(
    @Req()
    r: Request,
    @Body()
    b: unknown) { return this.service.createConversation(r.actor!, conversationInput.parse(b)); }
    @Get('conversations/:id')
    conversation(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Query()
    q: unknown) { return this.service.getConversation(r.actor!, id, conversationDetailQuery.parse(q)); }
    @Post('conversations/:id/messages')
    async message(
    @Req()
    r: Request,
    @Param('id')
    id: string,
    @Body()
    b: unknown) {
        const input = conversationMessageInput.parse(b);
        const previous = await this.service.getTurnByRequest(r.actor!, id, input.requestId);
        if (previous) {
            if (previous.message !== input.message)
                throw new DomainError('CONFLICT', 409, "This request ID has already been used for a different message.");
            return previous;
        }
        return new AiRequestService(this.service.db).run(r.actor!, `message:${id}`, async () => {
            const completed = await this.service.getTurnByRequest(r.actor!, id, input.requestId);
            if (completed) {
                if (completed.message !== input.message)
                    throw new DomainError('CONFLICT', 409, "This request ID has already been used for a different message.");
                return completed;
            }
            const { conversation, turns } = await this.service.getConversation(r.actor!, id);
            const reply = await this.replies.reply(r.actor!, conversation.customerId, input.message, turns, input.locale);
            return this.service.saveTurn(r.actor!, id, input, reply);
        });
    }
}
export async function createApi() {
    validateAuthConfiguration();
    const proxyTrust = trustedProxies();
    const url = process.env.DATABASE_URL;
    if (!url)
        throw new Error('DATABASE_URL is required.');
    const db = createDatabase(url);
    const service = new IntentService(db);
    const commercial = new CommercialService(db);
    const product = new ProductService(db);
    const identity = new IdentityService(db);
    // A process signal must drain HTTP work before closing its database pool.
    // Programmatic callers retain ownership of db.close() after app.close().
    const databaseShutdown = { onApplicationShutdown: (signal?: string) => signal ? db.close() : undefined };
    @Module({ controllers: [PublicController, AuthController, ApiController, CommercialController, ProductController], providers: [{ provide: SERVICE, useValue: service }, { provide: COMMERCIAL, useValue: commercial }, { provide: PRODUCT, useValue: product }, { provide: IDENTITY, useValue: identity }, { provide: 'DATABASE_SHUTDOWN', useValue: databaseShutdown }, AuthService, SessionGuard, ReplyService] })
    class AppModule {
    }
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: process.env.NODE_ENV === 'test' ? ['error'] : ['error', 'warn', 'log'] });
    app.set('trust proxy', proxyTrust);
    app.setGlobalPrefix('');
    app.useGlobalFilters(new ErrorFilter());
    app.enableShutdownHooks();
    app.use((req: {
        path: string;
    }, res: {
        setHeader(k: string, v: string): void;
    }, next: () => void) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('X-Frame-Options', 'DENY');
        if (req.path.startsWith('/api'))
            res.setHeader('Cache-Control', 'no-store');
        if (process.env.INTENT_SERVE_WEB === 'true')
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        next();
    });
    // Same-origin production assets avoid cross-origin credential handling. API routes never fall back to HTML.
    if (process.env.INTENT_SERVE_WEB === 'true') {
        const webRoot = resolve(fileURLToPath(new URL('../../web/dist/', import.meta.url)));
        if (!existsSync(resolve(webRoot, 'index.html'))) {
            await app.close();
            await db.close();
            throw new Error('Web build missing. Run pnpm build before starting.');
        }
        app.useStaticAssets(webRoot, { index: false, fallthrough: true, setHeaders: (res, path) => { res.setHeader('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store'); } });
        app.use((req: {
            method: string;
            path: string;
        }, res: {
            sendFile(path: string): void;
            setHeader(k: string, v: string): void;
        }, next: () => void) => {
            if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api') && !req.path.startsWith('/assets/') && !req.path.includes('.')) {
                res.setHeader('Cache-Control', 'no-store');
                res.sendFile(resolve(webRoot, 'index.html'));
            }
            else
                next();
        });
    }
    return { app, db, service, commercial, product, identity };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { app, db } = await createApi();
    const host = process.env.HOST ?? '127.0.0.1', port = Number(process.env.PORT ?? process.env.API_PORT ?? 3100);
    try {
        await app.listen(port, host);
        console.info(`Intent API listening on ${host}:${port}; authentication: ${process.env.INTENT_AUTH_MODE ?? (process.env.INTENT_DEV_AUTH === 'true' ? 'development' : 'password')}; model and delivery settings are workspace-specific.`);
    }
    catch (error) {
        await app.close();
        await db.close();
        throw error;
    }
}
