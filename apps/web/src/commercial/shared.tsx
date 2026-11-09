import { t, useLocale, localizedLabels, intlLocale } from '../i18n';
import { useSession } from '../product/auth';
import type { ForecastCategory, OpportunityStage, Receivable } from '@intent/contracts';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { Badge } from '../components';
export const stageNames: Record<OpportunityStage, string> = localizedLabels({ discovery: "Discovery", qualified: "Qualification", proposal: "Proposal evaluation", negotiation: "Negotiation", won: "Signed", lost: "Closed \u00B7 Lost" });
export const forecastNames: Record<ForecastCategory, string> = localizedLabels({ pipeline: "Pipeline", best_case: "Best case", commit: "Commit", excluded: "Excluded" });
export const forecastDescriptions: Record<ForecastCategory, string> = localizedLabels({ pipeline: "Continue nurturing; excluded from this period\u2019s forecast", best_case: "May close if conditions are met; included in upside", commit: "Owner commits to closing this period; included in base forecast", excluded: "Keep the opportunity but exclude its amount from forecasts" });
export const openStages: OpportunityStage[] = ['discovery', 'qualified', 'proposal', 'negotiation'];
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const currentPeriod = () => today().slice(0, 7);
export const periodName = (period: string) => t("{0}-{1}", period.slice(0, 4), Number(period.slice(5)));
export const dateLabel = (date: string | null) => date ? (date.includes('T') ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date)) : date).replaceAll('-', '.') : t("Not set");
export const moneyInput = (cents: number) => (cents / 100).toFixed(2);
export const money = (cents: number, compact = false) => `¥${new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / (compact && Math.abs(cents) >= 1000000 ? 1000000 : 100))}${compact && Math.abs(cents) >= 1000000 ? t(" \u00D710k") : ''}`;
export const percent = (value: number | null) => value === null ? t("No target set") : `${(value * 100).toFixed(1)}%`;
export const opportunityUrl = (id: string, finance = false) => `/opportunities/${encodeURIComponent(id)}${finance ? '?tab=finance' : ''}`;
export function OpportunityLink({ id, title }: {
    id: string;
    title: string;
}) { useLocale(); return <Link className="commercial-link" to={opportunityUrl(id)}>{title}<ArrowUpRight size={14}/></Link>; }
export function StageBadge({ stage }: {
    stage: OpportunityStage;
}) { useLocale(); return <Badge tone={stage === 'won' ? 'green' : stage === 'lost' ? 'neutral' : 'lime'}>{stageNames[stage]}</Badge>; }
export function ReceivableStatus({ item, asOf = today() }: {
    item: Receivable;
    asOf?: string;
}) { useLocale(); return <Badge tone={item.remainingCents === 0 ? 'green' : item.dueDate < asOf ? 'amber' : 'neutral'}>{item.remainingCents === 0 ? t("Paid in full") : item.dueDate < asOf ? t("Overdue and unpaid") : t("Awaiting payment")}</Badge>; }
export function CommercialNotice() { useLocale(); const { mode } = useSession(); return <p className="commercial-footnote">{mode.demo ? t("Includes fixed example business records for October 2026.") : ''}{t("Amounts are in CNY. Contracts and payments are manually recorded business entries, not bank verification or revenue recognition.")}</p>; }
