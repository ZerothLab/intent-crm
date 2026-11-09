import type { ForecastChange, ForecastItem, ForecastSnapshot, ManagementData, ManagementMetrics, ManagementOverview, ManagementRisk, Opportunity, OpportunityStage, Receivable, SalesTarget, } from '@intent/contracts';
const OPEN_STAGES = ['discovery', 'qualified', 'proposal', 'negotiation'] as const;
const DAY_MS = 86400000;
const shanghaiDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
function money(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`${label} must be non-negative safe integer cents`);
    return value;
}
function add(left: number, right: number): number {
    const result = left + right;
    if (!Number.isSafeInteger(result))
        throw new RangeError('Monetary aggregate exceeds safe integer cents');
    return result;
}
function date(value: string, label: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
        throw new RangeError(`${label} must be a valid calendar date`);
    }
    return value;
}
function localDate(value: string): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value))
        return date(value, 'stageEnteredAt');
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || Number.isNaN(Date.parse(value)))
        throw new RangeError('stageEnteredAt must be a valid timestamp with an explicit timezone');
    const parts = shanghaiDate.formatToParts(new Date(value));
    return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}-${parts.find(p => p.type === 'day')!.value}`;
}
function indexed<T extends {
    id: string;
}>(rows: T[], label: string): Map<string, T> {
    const result = new Map<string, T>();
    for (const row of rows) {
        if (result.has(row.id))
            throw new Error(`Duplicate ${label} id: ${row.id}`);
        result.set(row.id, row);
    }
    return result;
}
const open = (opportunity: Opportunity) => OPEN_STAGES.some(stage => stage === opportunity.stage);
const forecastItem = (opportunity: Opportunity): ForecastItem => ({
    id: opportunity.id, title: opportunity.title, customerName: opportunity.customerName,
    amountCents: opportunity.amountCents, stage: opportunity.stage, forecastCategory: opportunity.forecastCategory,
    expectedCloseDate: opportunity.expectedCloseDate, ownerId: opportunity.ownerId,
});
const projectionKeys: (keyof ForecastItem)[] = ['id', 'title', 'customerName', 'amountCents', 'stage', 'forecastCategory', 'expectedCloseDate', 'ownerId'];
function compareSnapshot(snapshot: ForecastSnapshot | null, current: Opportunity[], all: Map<string, Opportunity>): ForecastChange[] {
    if (!snapshot)
        return [];
    const previous = indexed(snapshot.items, 'snapshot item');
    const selected = new Map(current.map(item => [item.id, forecastItem(item)]));
    const changes: ForecastChange[] = [];
    for (const before of previous.values()) {
        const after = selected.get(before.id);
        if (!after) {
            const latest = all.get(before.id);
            changes.push({ opportunityId: before.id, title: latest?.title ?? before.title, kind: 'removed', before: { ...before }, after: latest ? forecastItem(latest) : null });
        }
        else if (projectionKeys.some(key => before[key] !== after[key])) {
            changes.push({ opportunityId: before.id, title: after.title, kind: 'changed', before: { ...before }, after: { ...after } });
        }
    }
    for (const after of selected.values()) {
        if (!previous.has(after.id))
            changes.push({ opportunityId: after.id, title: after.title, kind: 'added', before: null, after: { ...after } });
    }
    return changes.sort((a, b) => a.opportunityId.localeCompare(b.opportunityId));
}
/**
 * Current operational view, not a historical reconstruction of opportunity state.
 * Forecast/items/stages use the selected month's OPEN opportunities; signed actuals use
 * immutable contract ownership. Owner rows also include cross-period risk ownership.
 * Dated actuals and receipts stop at asOfDate; future installments in the month remain due.
 * Snapshot inputs and all returned business objects are detached to preserve frozen evidence.
 */
export function calculateManagementOverview(data: ManagementData, options: {
    period: string;
    ownerId?: string | null;
    asOfDate: string;
    generatedAt: string;
    target: SalesTarget | null;
    latestSnapshot: ForecastSnapshot | null;
}): ManagementOverview {
    const { period, generatedAt } = options;
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period))
        throw new RangeError('period must be YYYY-MM');
    const asOfDate = date(options.asOfDate, 'asOfDate');
    const ownerId = options.ownerId ?? null;
    const inMonth = (value: string) => value.slice(0, 7) === period;
    const inScope = (owner: string) => ownerId === null || owner === ownerId;
    const actualInMonth = (value: string) => inMonth(value) && value <= asOfDate;
    if (options.target && (options.target.period !== period || options.target.ownerId !== ownerId))
        throw new Error('Target scope does not match overview scope');
    if (options.latestSnapshot && (options.latestSnapshot.period !== period || options.latestSnapshot.ownerId !== ownerId))
        throw new Error('Snapshot scope does not match overview scope');
    const opportunitiesById = indexed(data.opportunities, 'opportunity');
    const contractsById = indexed(data.contracts, 'contract');
    const receivablesById = indexed(data.receivables, 'receivable');
    const paymentsById=indexed(data.payments, 'payment');
    const refunds=(data.refunds??[]).filter(r=>!r.reversedAt);
    indexed(refunds,'refund');
    indexed(data.tasks, 'task');
    const membersById = indexed(data.members, 'member');
    const contractsByOpportunity = new Map<string, ManagementData['contracts'][number]>();
    for (const opportunity of data.opportunities) {
        money(opportunity.amountCents, 'Opportunity amount');
        date(opportunity.expectedCloseDate, 'expectedCloseDate');
        if (opportunity.closedDate)
            date(opportunity.closedDate, 'closedDate');
        if (opportunity.nextStepDueDate)
            date(opportunity.nextStepDueDate, 'nextStepDueDate');
        localDate(opportunity.stageEnteredAt);
    }
    for (const contract of data.contracts) {
        money(contract.amountCents, 'Contract amount');
        date(contract.signedDate, 'signedDate');
        if (!opportunitiesById.has(contract.opportunityId))
            throw new Error('Contract references an absent opportunity');
        if(contract.cancelledAt) continue;
        if (contractsByOpportunity.has(contract.opportunityId))
            throw new Error('Multiple contracts for one opportunity');
        contractsByOpportunity.set(contract.opportunityId, contract);
    }
    const paidAsOf = new Map<string, number>();
    const paidAll = new Map<string, number>();
    for (const receivable of data.receivables) {
        money(receivable.amountCents, 'Receivable amount');
        date(receivable.dueDate, 'dueDate');
        const contract = contractsById.get(receivable.contractId);
        if (!contract || contract.opportunityId !== receivable.opportunityId)
            throw new Error('Receivable contract relationship is invalid');
    }
    for (const payment of data.payments) {
        money(payment.amountCents, 'Payment amount');
        date(payment.paidDate, 'paidDate');
        const receivable = receivablesById.get(payment.receivableId);
        if (!receivable || receivable.contractId !== payment.contractId || receivable.opportunityId !== payment.opportunityId)
            throw new Error('Payment receivable relationship is invalid');
        const total = add(paidAll.get(payment.receivableId) ?? 0, payment.amountCents);

        paidAll.set(payment.receivableId, total);
        if (payment.paidDate <= asOfDate)
            paidAsOf.set(payment.receivableId, add(paidAsOf.get(payment.receivableId) ?? 0, payment.amountCents));
    }
    const refundedByPayment=new Map<string,number>();
    for(const refund of refunds){
        money(refund.amountCents,'Refund amount'); date(refund.refundedDate,'refundedDate');
        const payment=paymentsById.get(refund.paymentId);
        if(!payment||payment.reversedAt||payment.contractId!==refund.contractId||payment.receivableId!==refund.receivableId||payment.opportunityId!==refund.opportunityId||refund.refundedDate<payment.paidDate) throw new Error('Refund payment relationship is invalid');
        const total=add(refundedByPayment.get(payment.id)??0,refund.amountCents);
        if(total>payment.amountCents) throw new RangeError('Refunds exceed payment amount');
        refundedByPayment.set(payment.id,total);
        paidAll.set(refund.receivableId,add(paidAll.get(refund.receivableId)??0,-refund.amountCents));
        if(refund.refundedDate<=asOfDate) paidAsOf.set(refund.receivableId,add(paidAsOf.get(refund.receivableId)??0,-refund.amountCents));
    }
    for(const [id,total] of paidAll) if(total>receivablesById.get(id)!.amountCents||total<0) throw new RangeError('Payments exceed receivable amount');
    const metrics: ManagementMetrics = {
        bookedCents: 0, collectedCents: 0, dueCents: 0, dueCollectedCents: 0, overdueCents: 0,
        commitCents: 0, bestCaseCents: 0, pipelineCents: 0, forecastCents: 0, upsideCents: 0,
        bookingAttainment: null, collectionAttainment: null, forecastGapCents: null,
        openCount: 0, wonCount: 0, lostCount: 0, winRate: null,
    };
    const ownerRows = new Map<string, ManagementOverview['owners'][number]>();
    function ownerRow(id: string) {
        let row = ownerRows.get(id);
        if (!row) {
            row = { ownerId: id, name: membersById.get(id)?.name ?? data.opportunities.find(o => o.ownerId === id)?.ownerName ?? id, bookedCents: 0, openCents: 0, commitCents: 0, atRiskCents: 0, openCount: 0 };
            ownerRows.set(id, row);
        }
        return row;
    }
    for (const contract of data.contracts) {
        if (contract.cancelledAt || !inScope(contract.ownerId) || !actualInMonth(contract.signedDate))
            continue;
        metrics.bookedCents = add(metrics.bookedCents, contract.amountCents);
        const row = ownerRow(contract.ownerId);
        row.bookedCents = add(row.bookedCents, contract.amountCents);
    }
    for (const payment of data.payments) {
        const contract = contractsById.get(payment.contractId)!;
        if (inScope(contract.ownerId) && actualInMonth(payment.paidDate))
            metrics.collectedCents = add(metrics.collectedCents, payment.amountCents);
    }
    for(const refund of refunds) if(inScope(refund.ownerId)&&actualInMonth(refund.refundedDate)) metrics.collectedCents=add(metrics.collectedCents,-refund.amountCents);
    const receivables: Receivable[] = [];
    for (const source of data.receivables) {
        const contract = contractsById.get(source.contractId)!;
        if (contract.cancelledAt || !inScope(contract.ownerId) || contract.signedDate > asOfDate)
            continue;
        const paidCents = paidAsOf.get(source.id) ?? 0;
        const remainingCents = source.amountCents - paidCents;
        const overdue = source.dueDate < asOfDate && remainingCents > 0;
        if (inMonth(source.dueDate)) {
            metrics.dueCents = add(metrics.dueCents, source.amountCents);
            metrics.dueCollectedCents = add(metrics.dueCollectedCents, paidCents);
        }
        if (overdue)
            metrics.overdueCents = add(metrics.overdueCents, remainingCents);
        if (inMonth(source.dueDate) || overdue)
            receivables.push({ ...source, ownerId: contract.ownerId, paidCents, remainingCents });
    }
    receivables.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
    const currentOpen = data.opportunities.filter(o => open(o) && inScope(o.ownerId));
    const opportunities = currentOpen.filter(o => inMonth(o.expectedCloseDate));
    const stages: ManagementOverview['stages'] = OPEN_STAGES.map(stage => ({ stage, count: 0, amountCents: 0 }));
    const stagesByName = new Map<OpportunityStage, ManagementOverview['stages'][number]>(stages.map(row => [row.stage, row]));
    for (const opportunity of opportunities) {
        metrics.openCount++;
        if (opportunity.forecastCategory === 'commit')
            metrics.commitCents = add(metrics.commitCents, opportunity.amountCents);
        else if (opportunity.forecastCategory === 'best_case')
            metrics.bestCaseCents = add(metrics.bestCaseCents, opportunity.amountCents);
        else if (opportunity.forecastCategory === 'pipeline')
            metrics.pipelineCents = add(metrics.pipelineCents, opportunity.amountCents);
        const stage = stagesByName.get(opportunity.stage)!;
        stage.count++;
        stage.amountCents = add(stage.amountCents, opportunity.amountCents);
        const row = ownerRow(opportunity.ownerId);
        row.openCount++;
        row.openCents = add(row.openCents, opportunity.amountCents);
        if (opportunity.forecastCategory === 'commit')
            row.commitCents = add(row.commitCents, opportunity.amountCents);
    }
    for (const opportunity of data.opportunities) {
        const closedOwner = opportunity.stage === 'won' ? contractsByOpportunity.get(opportunity.id)?.ownerId ?? opportunity.ownerId : opportunity.ownerId;
        if (!inScope(closedOwner) || !opportunity.closedDate || !actualInMonth(opportunity.closedDate))
            continue;
        if (opportunity.stage === 'won')
            metrics.wonCount++;
        if (opportunity.stage === 'lost')
            metrics.lostCount++;
    }
    const closedCount = metrics.wonCount + metrics.lostCount;
    metrics.winRate = closedCount ? metrics.wonCount / closedCount : null;
    metrics.forecastCents = add(metrics.bookedCents, metrics.commitCents);
    metrics.upsideCents = add(metrics.forecastCents, metrics.bestCaseCents);
    if (options.target) {
        const bookingsTarget = money(options.target.bookingsTargetCents, 'Bookings target');
        const collectionTarget = money(options.target.collectionTargetCents, 'Collection target');
        metrics.bookingAttainment = bookingsTarget ? metrics.bookedCents / bookingsTarget : null;
        metrics.collectionAttainment = collectionTarget ? metrics.collectedCents / collectionTarget : null;
        metrics.forecastGapCents = Math.max(bookingsTarget - metrics.forecastCents, 0);
    }
    const risks: ManagementRisk[] = [];
    const atRisk = new Set<string>();
    function risk(opportunity: Opportunity, kind: ManagementRisk['kind'], reason: string, severity: ManagementRisk['severity']) {
        risks.push({ id: `${opportunity.id}:${kind}`, opportunityId: opportunity.id, customerId: opportunity.customerId, title: opportunity.title, reason, kind, severity, amountCents: opportunity.amountCents, evidenceId: opportunity.evidenceId });
        atRisk.add(opportunity.id);
    }
    for (const opportunity of currentOpen) {
        if (opportunity.expectedCloseDate < asOfDate)
            risk(opportunity, 'close_overdue', "The expected close date " + opportunity.expectedCloseDate + " has passed; the opportunity remains open as of " + asOfDate + ".", 'high');
        const hasNextStep = opportunity.nextStep.trim().length > 0;
        if (hasNextStep && opportunity.nextStepDueDate && opportunity.nextStepDueDate < asOfDate)
            risk(opportunity, 'next_step_overdue', "The next-step deadline " + opportunity.nextStepDueDate + " has passed. Verify the outcome.", 'high');
        if (!hasNextStep || !opportunity.nextStepDueDate)
            risk(opportunity, 'next_step_missing', "The next-step plan or a clear deadline is missing.", 'medium');
        const entered = localDate(opportunity.stageEnteredAt);
        const days = Math.floor((Date.parse(asOfDate) - Date.parse(entered)) / DAY_MS);
        if (days >= 14)
            risk(opportunity, 'stage_stalled', "This stage has lasted " + days + " calendar days, reaching the 14-day review threshold.", 'medium');
        if (!opportunity.evidenceId)
            risk(opportunity, 'evidence_missing', "No customer evidence supports this opportunity yet.", 'medium');
    }
    for (const id of atRisk) {
        const opportunity = opportunitiesById.get(id)!;
        const row = ownerRow(opportunity.ownerId);
        row.atRiskCents = add(row.atRiskCents, opportunity.amountCents);
    }
    risks.sort((a, b) => Number(b.severity === 'high') - Number(a.severity === 'high') || a.opportunityId.localeCompare(b.opportunityId) || a.kind.localeCompare(b.kind));
    const tasks = data.tasks.filter(task => {
        const opportunity = opportunitiesById.get(task.opportunityId);
        if (!opportunity)
            throw new Error('Task references an absent opportunity');
        return inScope(opportunity.ownerId);
    }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
    if (options.latestSnapshot)
        money(options.latestSnapshot.metrics.forecastCents, 'Snapshot forecast');
    const snapshotDeltaCents = options.latestSnapshot ? metrics.forecastCents - options.latestSnapshot.metrics.forecastCents : null;
    if (snapshotDeltaCents !== null && !Number.isSafeInteger(snapshotDeltaCents))
        throw new RangeError('Snapshot delta exceeds safe integer cents');
    return {
        period, ownerId, asOfDate, generatedAt, currency: 'CNY', target: options.target ? structuredClone(options.target) : null,
        metrics, stages, owners: [...ownerRows.values()].sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
        opportunities: structuredClone(opportunities), risks, receivables, tasks: structuredClone(tasks),
        latestSnapshot: options.latestSnapshot ? structuredClone(options.latestSnapshot) : null,
        snapshotDeltaCents, snapshotChanges: compareSnapshot(options.latestSnapshot, opportunities, opportunitiesById),
    };
}
