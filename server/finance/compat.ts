/**
 * FATURAÇÃO / ANUAL — wrappers de compatibilidade sobre o MOTOR ÚNICO.
 *
 * Mantêm a forma do payload que InvoicesPage/AnnualPage já consomem
 * (invoices.billing e annual.breakdown), mas os números vêm todos de
 * computeFinance(). As funções antigas estão em ./legacy.ts só para a
 * comparação antes/depois (scripts/finance-parity.ts).
 */
import { getFinancialHistory } from "../db";
import { computeFinance, monthlyRowsFromTimeseries } from "./engine";
import { FINANCE_PARAMS, daysBetweenInclusive } from "./rules";

export async function getBillingData(filters: {
  from: string;
  to: string;
  projectId?: number;
  granularity?: "day" | "week" | "month" | "year";
}) {
  const r = await computeFinance({ ...filters, includePersonDetails: true });
  const periodDays = Math.max(1, daysBetweenInclusive(filters.from, filters.to));
  const summary = {
    produced: r.revenue.produced, producedCount: r.revenue.producedCount,
    collected: r.revenue.collected, collectedCount: r.revenue.collectedCount,
    producedNoVat: r.revenue.producedNet, collectedNoVat: r.revenue.collectedNet,
    extrasRevenue: r.revenue.extrasRevenue,
    expensesPaid: r.costs.expenses, expensesPaidNoVat: r.costs.expensesNet,
    // Dívida com vencimento no período — INFORMAÇÃO; já não é somada aos custos
    expensesPending: r.costs.expensesPending,
    extrasDiaCost: r.costs.extrasDia,
    salariesCost: r.costs.salaries,
    salariesBase: r.costs.salariesBase, salariesProvisions: r.costs.salariesProvisions, salariesVariable: r.costs.salariesVariable,
    employerTax: r.costs.employerTax,
    salesCommissions: r.costs.salesCommissions,
    operationalPartnersPaid: r.costs.operationalCommissions, operationalPartnersPending: 0,
    // back-compat
    invoiced: 0, marketingCost: 0,
    partnerCommissionsPaid: r.costs.operationalCommissions, partnerCommissionsPending: 0,
    totalCostsPaid: r.costs.totalGross,
    totalCostsAll: r.costs.totalGross,
    totalCostsNoVat: r.costs.totalNet,
    marginRealized: r.revenue.produced - r.costs.totalGross,
    marginAll: r.revenue.produced - r.costs.totalGross,
    marginNet: r.margin.margin,
    marginPct: r.margin.marginPct,
    vatRate: r.params.vatRate, tsuEmployerRate: r.params.tsuEmployerRate,
    periodDays,
    asOf: r.asOf,
    forecastRange: r.forecast,
    quality: r.quality,
  };
  return {
    summary,
    timeseries: r.timeseries.map((p) => ({
      bucket: p.bucket,
      produced: p.produced, producedNet: p.producedNet, producedCount: p.producedCount,
      collected: p.collected,
      expenses: p.expenses, expensesNet: p.expensesNet, expensesPaid: p.expenses,
      // "Salários" do gráfico inclui TSU para a pilha somar o custo total
      salaries: p.salaries + p.employerTax, salariesOnly: p.salaries, employerTax: p.employerTax,
      partners: p.partners, extrasCost: p.extrasCost,
      revenueForecast: p.revenueForecast,
      totalCost: p.totalCost, margin: p.margin,
    })),
    granularity: r.granularity,
    range: r.range,
    deliveries: r.details.deliveries,
    collected: r.details.collected,
    expensesPaid: r.details.expenses,
    expensesPending: r.details.expensesPending,
    forecast: r.details.forecast,
    extrasDia: r.details.extrasDia,
    partnerCommissions: [] as Array<never>,
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
    revenueGrossWithVat: round(m.revenueGrossWithVat),
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
    // Marketing já está nas despesas — 0 aqui (antes somava ads + marketing_expenses outra vez)
    marketingCost: 0,
    extrasDiaCost: round(m.extrasDiaCost),
    salaries: round(m.salaries),
    employerTax: round(m.employerTax),
    totalCosts: round(m.totalCosts),
    profit: round(m.profit),
    producedCount: m.producedCount,
    fromHistory: false,
  }));

  // Fusão com o histórico importado (anos sem dados na app): só sem filtro de
  // centro e só em meses SEM nada real; fica identificado (fromHistory).
  if (!projectId) {
    try {
      const history = await getFinancialHistory(year);
      const histByMonth = new Map(history.map((h) => [h.month, h]));
      for (const mo of months) {
        const h = histByMonth.get(mo.month);
        if (!h) continue;
        const hasReal = mo.revenueGrossWithVat > 0 || mo.expensesWithVat > 0 || mo.salaries > 0 || mo.extrasDiaCost > 0;
        if (hasReal) continue;
        const vat = FINANCE_PARAMS.vatRate;
        const revenueWithVat = h.revenueWithVat, expensesWithVat = h.expensesWithVat, salaries = h.salaries;
        const vatRevenue = round(revenueWithVat * vat / (1 + vat));
        const vatExpenses = round(expensesWithVat * vat / (1 + vat));
        const revenueNoVat = round(revenueWithVat - vatRevenue);
        const expensesNoVat = round(expensesWithVat - vatExpenses);
        const employerTax = round(salaries * FINANCE_PARAMS.tsuEmployerRate);
        const totalCosts = round(expensesNoVat + salaries + employerTax);
        Object.assign(mo, {
          revenueGrossWithVat: revenueWithVat, revenueWithVat, revenueNoVat, vatRevenue,
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
