import { fixtureCopy } from './fixture-copy.js';
import { z } from 'zod';
import { planSchema, advancementPlanSchema, type AdvancementContext, type AdvancementPlan, type ChatReply, type CustomerDetail, type Opportunity, type Plan, type PlanningContext, type ProductRun, type ChatTurn, type Locale } from '@intent/contracts';
export interface CapabilityDefinition<Input, Output> {
    id: string;
    version: string;
    description: string;
    inputSchema: z.ZodType<Input>;
    outputSchema: z.ZodType<Output>;
    execute(input: Input): Promise<Output>;
}
/** Registration is explicit at startup; this is not a dynamic plugin loader. */
export class CapabilityRegistry {
    private readonly capabilities = new Map<string, {
        version: string;
        description: string;
        execute(input: unknown): Promise<unknown>;
    }>();
    register<Input, Output>(capability: CapabilityDefinition<Input, Output>): this {
        if (!/^[a-z][a-z0-9.-]+$/.test(capability.id) || !/^\d+\.\d+\.\d+$/.test(capability.version)) {
            throw new Error('Capability requires an explicit id and semantic version');
        }
        if (this.capabilities.has(capability.id))
            throw new Error(`Duplicate capability: ${capability.id}`);
        this.capabilities.set(capability.id, {
            version: capability.version,
            description: capability.description,
            execute: async (input) => capability.outputSchema.parse(await capability.execute(capability.inputSchema.parse(input))),
        });
        return this;
    }
    list(): {
        id: string;
        version: string;
        description: string;
    }[] {
        return [...this.capabilities].map(([id, capability]) => ({ id, version: capability.version, description: capability.description }));
    }
    async execute(id: string, version: string, input: unknown): Promise<unknown> {
        const capability = this.capabilities.get(id);
        if (!capability || capability.version !== version)
            throw new Error('Capability/version is not registered');
        return capability.execute(input);
    }
}
// Only fields consumed by this capability cross its explicit schema boundary.
const salesInputSchema = z.object({
    locale:z.enum(['en','zh-CN']).optional(),
    customer: z.object({ id: z.string().min(1), name: z.string().min(1), contact: z.string(), email: z.email() }).strict(),
    evidence: z.object({ id: z.string().min(1), customerId: z.string().min(1), title: z.string(), body: z.string().min(1).max(20000) }).strict(),
}).strict();
export const SALES_CAPABILITY_ID = 'sales.follow-up';
export const SALES_CAPABILITY_VERSION = '1.0.0';
export const salesCapability: CapabilityDefinition<z.infer<typeof salesInputSchema>, Plan> = {
    id: SALES_CAPABILITY_ID,
    version: SALES_CAPABILITY_VERSION,
    description: "Fixture: produce sourced candidate facts and a follow-up draft from supplied meeting notes",
    inputSchema: salesInputSchema,
    outputSchema: planSchema,
    async execute({ customer, evidence, locale = 'en' }) {
        const t=(key:string,...values:unknown[])=>fixtureCopy(locale,key,...values);
        if (evidence.customerId !== customer.id)
            throw new Error('Evidence is outside the customer context');
        const quote = evidence.body.trim().slice(0, 500);
        const sentences = evidence.body.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? [evidence.body];
        const categories = [
            { key: 'budget', pattern: /预算|budget/i },
            { key: 'timeline', pattern: /本周|下周|月底|截止|时间|deadline|timeline/i },
            { key: 'requirements', pattern: /需要|需求|希望|require|need/i },
        ];
        const facts = categories.flatMap(({ key, pattern }) => {
            const sentence = sentences.find((value) => pattern.test(value))?.trim().slice(0, 500);
            return sentence ? [{ key, value: sentence, evidenceId: evidence.id, quote: sentence }] : [];
        });
        return {
            summary: t("Fixture draft based on \u201C{0}\u201D. Human verification and approval are required.", evidence.title.slice(0, 200)),
            facts,
            proposal: {
                recipient: customer.email,
                subject: t("{0} \u00B7 Meeting follow-up and proposal review", customer.name.slice(0, 100)),
                body: t("Hello {0},\n\nOur conversation notes record:\n\u201C{1}\u201D\n\nPlease confirm whether these notes are accurate and what additional information the next proposal should include.\n\nThis draft was prepared by the deterministic Fixture demo model and requires human review before sending.", customer.contact.slice(0, 100) || t("there"), quote),
                evidenceIds: [evidence.id],
            },
        };
    },
};
export function createCapabilityRegistry(): CapabilityRegistry {
    return new CapabilityRegistry().register(salesCapability);
}
export class FixtureModel {
    readonly id = 'fixture-v1' as const;
    constructor(private readonly registry = createCapabilityRegistry()) { }
    advance(context: AdvancementContext, locale: Locale = 'en'): AdvancementPlan {
        const t=(key:string,...values:unknown[])=>fixtureCopy(locale,key,...values);
        const { opportunity, fact, evidence, goal } = context;
        if (fact.customerId !== opportunity.customerId || evidence.customerId !== opportunity.customerId || fact.evidenceId !== evidence.id || fact.status !== 'confirmed' || !fact.reviewedBy || !fact.quote.trim() || !evidence.body.includes(fact.quote)) {
            throw new Error('Advancement requires a reviewed fact in the authorized customer context');
        }
        if (['won', 'lost'].includes(opportunity.stage))
            throw new Error('Advancement requires an open opportunity');
        const focus = /预算|价格|报价|budget|price/i.test(goal) ? t("verify the budget boundaries and information needed for a quote; record the response and unresolved items") : /决策|采购|签约|合同|decision|contract/i.test(goal) ? t("verify decision participants, procurement steps and prerequisites; record what remains unconfirmed") : /时间|排期|计划|进度|timeline|schedule/i.test(goal) ? t("agree on the next conversation time and prerequisites; record the arrangements confirmed by the customer") : t("verify requirements and acceptance criteria; record customer feedback and unresolved questions");
        return advancementPlanSchema.parse({
            nextStep: t("For the goal \u201C{0}\u201D, use the verified information \u201C{1}{2}\u201D to {3}.", goal.slice(0, 150), fact.quote.slice(0, 100), fact.quote.length > 100 ? '…' : '', focus),
            rationale: t("Fixture organizes a next step from your goal and the verified quote in \u201C{0}\u201D. The goal and deadline are your plan, not a customer commitment. Add the customer response as evidence and review whether the plan needs to change.", evidence.title),
        });
    }
    async plan(context: PlanningContext): Promise<Plan> {
        if (!context.model.enabled || context.model.provider !== 'fixture' || context.model.model !== this.id) {
            throw new Error('Fixture model is disabled or unsupported; no production provider is configured');
        }
        const evidence = context.evidence.find((item) => item.id === context.run.evidenceId && item.customerId === context.customer.id);
        if (!evidence || context.run.customerId !== context.customer.id)
            throw new Error('Planning evidence is missing from the authorized context');
        return planSchema.parse(await this.registry.execute(SALES_CAPABILITY_ID, SALES_CAPABILITY_VERSION, {
            locale:context.locale??'en',
            customer: { id: context.customer.id, name: context.customer.name, contact: context.customer.contact, email: context.customer.email },
            evidence: { id: evidence.id, customerId: evidence.customerId, title: evidence.title, body: evidence.body },
        }));
    }
    reply(detail: CustomerDetail, message: string, opportunities: Opportunity[] = [], runs: ProductRun[] = [], _history: ChatTurn[] = [], locale: Locale = 'en'): ChatReply {
        const t=(key:string,...values:unknown[])=>fixtureCopy(locale,key,...values);
        const customerPath = `/customers/${encodeURIComponent(detail.customer.id)}`;
        const sources = detail.evidence.filter((item) => item.customerId === detail.customer.id).slice(0, 3)
            .map(({ id, title, body }) => ({ id, title, quote: body.trim().slice(0, 180) }));
        const action = detail.actions.find((item) => item.customerId === detail.customer.id && !['succeeded','cancelled'].includes(item.status));
        const missing = detail.fields.filter((field) => field.enabled && field.required && (detail.fieldValues[field.key] === undefined || detail.fieldValues[field.key] === null || detail.fieldValues[field.key] === ''));
        const cards: ChatReply['cards'] = [];
        // The API supplies already-authorized records; a runner never queries or grants access.
        const related = opportunities.filter((item) => item.customerId === detail.customer.id);
        const stages = { discovery: t("Discovery"), qualified: t("Qualified"), proposal: t("Proposal evaluation"), negotiation: t("Negotiation"), won: t("Signed"), lost: t("Lost") };
        for (const opportunity of related.slice(0, 3)) {
            cards.push({ id: `opportunity-${opportunity.id}`, title: opportunity.title,
                description: `${stages[opportunity.stage]} · ¥${(opportunity.amountCents / 100).toLocaleString(locale==='zh-CN'?'zh-CN':'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${opportunity.nextStep || t("Next-step plan needed")}`,
                label: opportunity.stage === 'won' ? t("View contracts and collections") : /推进|下一步|跟进|next|follow|advance/i.test(message) && opportunity.stage !== 'lost' ? t("Prepare next-step proposal") : t("View and advance opportunity"),
                href: `/opportunities/${encodeURIComponent(opportunity.id)}${opportunity.stage === 'won' ? '?tab=finance' : /推进|下一步|跟进|next|follow|advance/i.test(message) && opportunity.stage !== 'lost' ? '?focus=advance' : ''}`, tone: opportunity.stage !== 'won' && opportunity.stage !== 'lost' && (!opportunity.nextStep || !opportunity.nextStepDueDate) ? 'attention' : 'neutral' });
        }
        if (action)
            cards.push({ id: action.id, title: t("View outstanding action"), description: t("Revision {0} \u00B7 {1}", action.revision, action.status === 'unknown' ? t("Outcome requires verification; do not redispatch") : t("Use the current approval status in Action center")), label: t("View action"), href: `${customerPath}?action=${encodeURIComponent(action.id)}`, tone: action.status === 'unknown' ? 'attention' : 'neutral' });
        if (missing.length)
            cards.push({ id: `fields-${detail.customer.id}`, title: t("Complete customer information"), description: t("Missing: {0}{1}", missing.slice(0, 5).map((field) => field.label).join('、'), missing.length > 5 ? t(", and {0} more", missing.length - 5) : ''), label: t("Edit fields"), href: `${customerPath}?focus=fields`, tone: 'attention' });
        const facts = detail.facts.filter(f => f.customerId === detail.customer.id);
        const candidates = facts.filter(f => f.status === 'candidate');
        const confirmed = facts.filter(f => f.status === 'confirmed');
        if (candidates.length)
            cards.push({ id: `facts-${detail.customer.id}`, title: t("{0} facts need verification", candidates.length), description: t("Read the original evidence, then verify or reject. Review results and reasons are retained for the team."), label: t("Review facts"), href: `${customerPath}?focus=facts`, tone: 'attention' });
        const failed = runs.filter(r => r.customerId === detail.customer.id && r.status === 'failed' && !r.successorRunId);
        if (failed.length)
            cards.push({ id: `runs-${detail.customer.id}`, title: t("{0} planning runs need recovery", failed.length), description: t("Review the failure, fix the settings and start a new attempt. The failed record is preserved."), label: t("View failed runs"), href: `${customerPath}?focus=runs`, tone: 'attention' });
        const priority = /失败|重试|恢复|fail|retry|recover/i.test(message) ? 'runs-' : /事实|核实|确认信息|fact|verify/i.test(message) ? 'facts-' : /补齐|资料|字段|missing|field|information/i.test(message) ? 'fields-' : /审批|发送|草稿|approve|send|draft/i.test(message) ? action?.id : undefined;
        if (priority)
            cards.sort((a, b) => Number(b.id.startsWith(priority)) - Number(a.id.startsWith(priority)));
        if (!cards.length)
            cards.push({ id: detail.customer.id, title: t("View customer and evidence"), description: t("Review saved conversation evidence and action history"), label: t("Open customer"), href: customerPath, tone: 'neutral' });
        const completed = detail.actions.filter((item) => item.customerId === detail.customer.id && item.status === 'succeeded' && item.receipt).length;
        const summary = sources.length ? t("There are {0} verifiable source records. Latest excerpt: \u201C{1}\u201D", detail.evidence.filter((item) => item.customerId === detail.customer.id).length, sources[0]!.quote) : t("No source evidence is available to establish requirements, budget or purchase commitments.");
        const state = completed ? t("There are {0} recorded delivery receipts. They do not establish customer agreement or a won deal.", completed) : t("No completed delivery receipts are recorded.");
        const limitation = /发送|send|批准|approve|修改|删除|delete/i.test(message) ? t("I provide drafts and page links. Review and approve or edit the action in its detail page.") : t("Candidate facts require human verification. Missing information cannot be inferred.");
        const commercial = related.length ? t("There are {0} related opportunities. The cards below link to saved business records, contracts and collections.", related.length) : t("There are no related opportunities yet.");
        const verification = t("Fact review: {0} verified, {1} candidates, {2} rejected. {3}", confirmed.length, candidates.length, facts.filter(f => f.status === 'rejected').length, failed.length ? t("{0} failed planning runs need attention.", failed.length) : '');
        return { model: this.id, text: t("I am Intent, using the deterministic Fixture demo model.\n{0}: {1}\n{2}\n{3}\n{4}\n{5}", detail.customer.name, summary, commercial, verification, state, limitation), sources, cards };
    }
}
export { CompatibleModel, createModel } from './compatible-model.js';
export { requestJson, isPublicAddress } from './http.js';
