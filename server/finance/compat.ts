/**
 * FATURAÇÃO / ANUAL — wrappers de compatibilidade sobre o MOTOR ÚNICO.
 *
 * Mantêm a forma do payload que InvoicesPage/AnnualPage já consomem
 * (invoices.billing e annual.breakdown), mas os números vêm todos de
 * computeFinance(). (O código antigo, legacy.ts, e o script de paridade
 * foram removidos em 24 set 2026, com a fase 1 validada.)
 */
import { getFinancialHistory } from "../db";
import { computeFinance, monthlyRowsFromTimeseries, type FinanceResult } from "./engine";
import { daysBetweenInclusive, monthsOverlapping } from "./rules";
import { loadFinanceRates } from "./rates";

export async function getBillingData(filters: {
  from: string;
  to: string;
  projectId?: number;
  granularity?: "day" | "week" | "month" | "year";
}) {
  const r = await computeFinance({ ...filters, includePersonDetails: true });
  return billingPayload(r, filters);
}

/** Forma do payload da Faturação (também usada pela exportação). */
export function billingPayload(r: FinanceResult, filters: { from: string; to: string }) {
  const periodDays = Math.max(1, daysBetweenInclusive(filters.from, filters.to));
  const summary = {
    produced: r.revenue.produced, producedCount: r.revenue.producedCount,
    collected: r.revenue.collected, collectedCount: r.revenue.collectedCount,
    producedNoVat: r.revenue.producedNet, collectedNoVat: r.revenue.collectedNet,
    extrasRevenue: r.revenue.extrasRevenue,
    expensesPaid: r.costs.expenses, expensesPaidNoVat: r.costs.expensesNet,
    // Dívida com vencimento no período — INFORMAÇÃO; não é somada aos custos
    expensesPending: r.costs.expensesPending,
    extrasDiaCost: r.costs.extrasDia,
    salariesCost: r.costs.salaries,
    salariesBase: r.costs.salariesBase, salariesProvisions: r.costs.salariesProvisions, salariesVariable: r.costs.salariesVariable,
    employerTax: r.costs.employerTax,
    salesCommissions: r.costs.salesCommissions,
    operationalCommissions: r.costs.operationalCommissions,
    totalCostsGross: r.costs.totalGross,
    totalCostsNoVat: r.costs.totalNet,
    marginNet: r.margin.margin,
    marginPct: r.margin.marginPct,
    vatRate: r.params.vatRate, tsuEmployerRate: r.params.tsuEmployerRate,
    periodDays,
    asOf: r.asOf,
    isCurrentPeriod: r.quality.isCurrentPeriod,
    projection: r.projection,
    forecastRange: r.forecast,
    quality: r.quality,
  };
  return {
    summary,
    timeseries: r.timeseries.map((p) => ({
      bucket: p.bucket,
      produced: p.produced, producedNet: p.producedNet, producedCount: p.producedCount,
      collected: p.collected,
      expenses: p.expenses, expensesNet: p.expensesNet,
      // "Salários" do gráfico inclui TSU para a pilha somar o custo total
      salaries: p.salaries + p.employerTax, salariesOnly: p.salaries, employerTax: p.employerTax,
      partners: p.partners, extrasCost: p.extrasCost,
      revenueForecast: p.revenueForecast, revenueForecastNet: p.revenueForecastNet, costForecast: p.costForecast,
      totalCost: p.totalCost, margin: p.margin, marginForecast: p.marginForecast,
    })),
    granularity: r.granularity,
    range: r.range,
    deliveries: r.details.deliveries,
    collected: r.details.collected,
    expensesPaid: r.details.expenses,
    expensesExcluded: r.details.expensesExcluded,
    expensesPending: r.details.expensesPending,
    forecast: r.details.forecast,
    extrasDia: r.details.extrasDia,
    salesCommissions: r.details.salesCommissions,
    operationalPartners: r.details.operationalPartners,
    salaries: { byProject: r.details.salariesByProject, details: r.details.salaryDetails, total: r.costs.salaries },
    quality: r.quality,
  };
}

export async function getAnnualBreakdown(year: number, projectId?: number) {
  const r = await computeFinance({ from: `${year}-01-01`, to: `${year}-12-31`, projectId, granularity: "month" });
  const round = (v: number) => Math.round(v * 100) / 100;
  const months = monthlyRowsFromTimeseries(r).map((m) => ({
    month: m.month,
    status: m.status,
    // Comissões são CUSTO: a receita "líquida" deixa de as deduzir
    salesCommissions: round(m.salesCommissions),
    operationalCommissions: round(m.operationalCommissions),
    revenueWithVat: round(m.revenueWithVat),
    revenueNoVat: round(m.revenueNoVat),
    vatRevenue: round(m.vatRevenue),
    expensesWithVat: round(m.expensesWithVat),
    expensesNoVat: round(m.expensesNoVat),
    vatExpenses: round(m.vatExpenses),
    vatToPay: round(m.vatToPay),
    extrasDiaCost: round(m.extrasDiaCost),
    salaries: round(m.salaries),
    employerTax: round(m.employerTax),
    totalCosts: round(m.totalCosts),
    profit: round(m.profit),
    producedCount: m.producedCount,
    // Fecho previsto (meses em curso/futuros): sem prejuízos fictícios
    forecastRevenueNoVat: round(m.forecastRevenueNoVat),
    forecastCosts: round(m.forecastCosts),
    forecastProfit: round(m.forecastProfit),
    fromHistory: false,
  }));

  // Fusão com o histórico importado (anos sem dados na app): só sem filtro de
  // centro e só em meses SEM nada real; fica identificado (fromHistory).
  if (!projectId) {
    try {
      const history = await getFinancialHistory(year);
      const histByMonth = new Map(history.map((h) => [h.month, h]));
      // O histórico importado só tem totais MENSAIS (não dá para partir por
      // dia): usa-se o IVA/TSU das Definições em vigor no ÚLTIMO dia do mês.
      const rates = await loadFinanceRates();
      const monthEnd = new Map(monthsOverlapping(`${year}-01-01`, `${year}-12-31`).map((m) => [m.month, m.to]));
      for (const mo of months) {
        const h = histByMonth.get(mo.month);
        if (!h) continue;
        const hasReal = mo.revenueWithVat > 0 || mo.expensesWithVat > 0 || mo.salaries > 0 || mo.extrasDiaCost > 0;
        if (hasReal) continue;
        const end = monthEnd.get(mo.month) ?? `${year}-12-31`;
        const vat = rates.vatOn(end), tsu = rates.tsuOn(end);
        const revenueWithVat = h.revenueWithVat, expensesWithVat = h.expensesWithVat, salaries = h.salaries;
        const vatRevenue = round(revenueWithVat * vat / (1 + vat));
        const vatExpenses = round(expensesWithVat * vat / (1 + vat));
        const revenueNoVat = round(revenueWithVat - vatRevenue);
        const expensesNoVat = round(expensesWithVat - vatExpenses);
        const employerTax = round(salaries * tsu);
        const totalCosts = round(expensesNoVat + salaries + employerTax);
        Object.assign(mo, {
          revenueWithVat, revenueNoVat, vatRevenue,
          expensesWithVat, expensesNoVat, vatExpenses, vatToPay: round(vatRevenue - vatExpenses),
          salaries, employerTax, totalCosts, profit: round(revenueNoVat - totalCosts), fromHistory: true,
        });
      }
    } catch (err) {
      console.warn("[annual] fusão histórico falhou:", err);
    }
  }
  return months;
}
