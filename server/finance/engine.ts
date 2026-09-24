/**
 * MOTOR FINANCEIRO ÚNICO — Faturação, Anual, Financeiro, gráfico e detalhes
 * saem daqui.
 *
 * Vai buscar os dados uma vez, AO DIA DE LISBOA, e aplica as regras de
 * ./rules.ts. As séries do gráfico e os cartões são somas dos MESMOS mapas
 * diários, por isso batem ao cêntimo por construção.
 *
 * Regras que este motor fixa:
 *   - DIAS DE LISBOA: os timestamps das reservas e do ponto estão em UTC; o
 *     período [from, to] é [from 00:00, to+1 00:00) de Lisboa
 *     (lisbonDayRangeUtc) e cada linha cai no seu dia de Lisboa
 *     (lisbonDaySql) — igual às Operações e ao Marketing. Uma saída às
 *     23:30 UTC de 31/07 (00:30 de 1/08 em Lisboa) é AGOSTO;
 *   - receita realizada = CHECKED_OUT pelo dia de saída. Uma reserva que
 *     atravessa meses conta INTEIRA no mês da saída (sem rateio por noites) —
 *     é o momento em que o serviço fica prestado e é faturado;
 *   - despesas não canceladas pela data da despesa, contadas UMA vez
 *     (pendentes são informação); categorias marcadas "excluir da margem"
 *     (RH/salários, TSU, extras — já contados pelo pessoal/ponto) ficam fora
 *     e aparecem em `quality.excludedExpenses`; IVA pela taxa da categoria,
 *     0% em autoliquidação (Google/Meta), senão a taxa normal do dia;
 *   - comissões (venda + operacional) são CUSTO, sobre o valor SEM IVA (ou
 *     com IVA se o parceiro tiver commissionBase 'gross'); a de venda NÃO se
 *     cobra quando o parceiro é operacional e já opera o centro da reserva;
 *   - marketing NÃO entra (as faturas do Google já estão nas despesas) — a
 *     cobertura (`quality.marketingExcluded`) só se calcula a pedido;
 *   - pessoal: histórico salarial por mês, mês completo = salário mensal,
 *     início/fim de contrato, inativos sem fim de contrato contam até à data
 *     de desativação/última atualização (e ficam num aviso), extras excluídos
 *     por UM critério, provisões 13.º/14.º, variável do RH quando existe
 *     ponto, TSU sobre base + provisões + variável tributável;
 *   - equipa do dia: só extras, saída antecipada respeitada, filtrada pela
 *     cidade do centro escolhido; real (ponto) até hoje, escala depois;
 *   - custos sem centro entram no consolidado como "Por atribuir" e NUNCA num
 *     filtro de centro;
 *   - PERÍODO EM CURSO: os totais (`revenue`, `costs`, `margin`) são o
 *     "Realizado até hoje" — salários/provisões/TSU, equipa do dia e despesas
 *     cortados em hoje. `projection` é o "Fecho previsto": + receita esperada
 *     (carros estacionados e check-ins futuros com saída ≤ `to`) + custos do
 *     período inteiro. A série só põe custos realizados nos dias passados; os
 *     dias futuros vão para `costForecast`/`revenueForecast` (sem prejuízos
 *     fictícios em meses que ainda não aconteceram).
 */
import { and, eq, gte, lt, lte, sql, isNotNull, inArray, notInArray, or, isNull, type SQL } from "drizzle-orm";
import {
  multiparkBookings, projects, expenses, expenseCategories,
  employees, employeeSalaryHistory, marketingExpenses,
} from "../../drizzle/schema";
import { DEFAULT_EXTRA_RATES, loadExtraRates } from "../extraRates";
import { aggregateExtrasCost, loadExtrasCostRows } from "./extrasCost";
import { getDb, resolveProjectIds, getPayrollData } from "../db";
import { matchCityKey } from "../../shared/city";
import { lisbonDayOf, lisbonDayRangeUtc, lisbonDaySql } from "../../shared/lisbonDay";
import * as R from "./rules";
import { resolveFinanceRates, rateCaseSql, type FinanceRates, type RatePeriod } from "./rates";
import { loadPartnerIndex, operatedLeavesByPartner, partnerForCampaign } from "./partners";

export interface FinanceFilters {
  from: string;                 // YYYY-MM-DD (dia de Lisboa)
  to: string;                   // YYYY-MM-DD (inclusivo, dia de Lisboa)
  projectId?: number;           // centro de custos (com descendentes; negativo = marca global)
  granularity?: R.Granularity;
  /** "hoje" (Lisboa) — injetável para testes/paridade */
  today?: string;
  /** devolver salários POR PESSOA (só para detalhe autorizado) */
  includePersonDetails?: boolean;
  /** taxas IVA/TSU — injetável para testes; omissão = Definições (cache 60 s) */
  rates?: FinanceRates;
  /** calcula a cobertura de marketing (ads + marketing_expenses) — só a pedido (lento) */
  includeMarketingCoverage?: boolean;
}

export interface FinancePoint {
  bucket: string;
  produced: number; producedNet: number; producedCount: number;
  collected: number; collectedCount: number;
  expenses: number; expensesNet: number;
  salaries: number;             // base + provisões + variável (realizado)
  employerTax: number;
  partners: number;             // comissões venda + operacional
  salesCommissions: number;
  operationalCommissions: number;
  extrasCost: number;
  /** receita esperada (COM IVA) — saídas previstas nos dias de hoje em diante */
  revenueForecast: number;
  revenueForecastNet: number;
  /** custos dos dias FUTUROS (+ comissões da receita esperada) — não somam a totalCost */
  costForecast: number;
  totalCost: number;            // realizado, base LÍQUIDA (igual aos cartões)
  margin: number;               // producedNet − totalCost
  /** fecho previsto do bucket: (producedNet + revenueForecastNet) − (totalCost + costForecast) */
  marginForecast: number;
}

type SalesCommissionRow = { partnerId: number; partnerName: string; projectId: number | null; projectName: string | null; bookingsCount: number; revenueGross: number; revenueNet: number; commissionBase: R.CommissionBase; commissionRate: number | null; commission: number; status: R.CommissionStatus };
type OperationalRow = { partnershipId: number; partnerName: string | null; partnerType: string | null; projectNames: string[]; bookingsCount: number; revenueGross: number; revenueNet: number; commissionBase: R.CommissionBase; commissionRate: number; commission: number };

export interface FinanceProjection {
  /** período em curso (ou futuro): há previsão a somar */
  applies: boolean;
  revenueGross: number;          // realizado + esperado (COM IVA)
  revenueNet: number;
  forecastRevenueNet: number;
  costsNet: number;              // custos do período inteiro
  futureCostsNet: number;        // parte dos custos depois de hoje (+ comissões da receita esperada)
  margin: number;
  marginPct: number | null;
}

export interface FinanceResult {
  range: { from: string; to: string };
  asOf: string;
  granularity: R.Granularity;
  /** vatRate/tsuEmployerRate = taxa em vigor no FIM do período; os
   *  sub-períodos dizem que taxa se aplicou a cada parte (mudança a meio). */
  params: { vatRate: number; tsuEmployerRate: number; vatPeriods: RatePeriod[]; tsuPeriods: RatePeriod[]; extrasDiaRates: Record<string, number> };
  scope: { projectId: number | null; projectIds: number[] | null; cities: string[] | null };
  revenue: {
    produced: number; producedNet: number; producedCount: number;
    collected: number; collectedNet: number; collectedCount: number;
    extrasRevenue: number;
  };
  /** REALIZADO (até hoje, no período em curso) */
  costs: {
    expenses: number; expensesNet: number;
    expensesPending: number;           // informativo (vencimento no período), NÃO soma
    salariesBase: number; salariesProvisions: number; salariesVariable: number; salaries: number;
    employerTax: number;
    /** extras que entram na margem: real (ponto) até hoje */
    extrasDia: number;
    /** estimativa pela escala do Extras Dia (período inteiro) */
    extrasPlanned: number;
    /** pago pelo ponto (horas × tarifa) no período */
    extrasReal: number;
    salesCommissions: number; operationalCommissions: number;
    totalNet: number; totalGross: number;
  };
  margin: R.MarginResult;
  /** "Fecho previsto" (período em curso): realizado + esperado, custos do período inteiro */
  projection: FinanceProjection;
  timeseries: FinancePoint[];
  forecast: { revenue: number; revenueNet: number; count: number; from: string; to: string };
  details: {
    deliveries: Array<{ projectId: number | null; projectName: string | null; count: number; totalRevenue: number; parkingRevenue: number; deliveryCharges: number; extrasRevenue: number }>;
    collected: Array<{ projectId: number | null; projectName: string | null; count: number; totalRevenue: number }>;
    expenses: Array<{ projectId: number | null; projectName: string | null; categoryName: string | null; count: number; totalAmount: number; totalNet: number }>;
    /** despesas de categorias "excluir da margem" (não somam) */
    expensesExcluded: Array<{ projectId: number | null; projectName: string | null; categoryName: string | null; count: number; totalAmount: number }>;
    expensesPending: Array<{ projectId: number | null; projectName: string | null; categoryName: string | null; supplier: string | null; count: number; totalAmount: number }>;
    /** previsto (escala), por nível */
    extrasDia: Array<{ level: string; hours: number; headcount: number; cost: number }>;
    /** real (ponto), por nível */
    extrasReal: Array<{ level: string; hours: number; headcount: number; cost: number }>;
    salesCommissions: SalesCommissionRow[];
    operationalPartners: OperationalRow[];
    salariesByProject: Array<{ projectId: number | null; projectName: string | null; cost: number }>;
    salaryDetails: Array<{ employeeId: number; fullName: string; projectId: number | null; cost: number; base: number; provisions: number; variable: number; days: number; ratedTo: number[] }>;
    forecast: Array<{ projectId: number | null; projectName: string | null; count: number; totalRevenue: number }>;
    months: Array<{ year: number; month: number; from: string; to: string; days: number; daysInMonth: number }>;
  };
  quality: {
    partnerConflicts: Array<{ key: string; partnerIds: number[] }>;
    partnersRateMissing: string[];
    campaignsWithoutPartner: Array<{ campaign: string; revenueGross: number; bookingsCount: number }>;
    /** comissão de venda NÃO cobrada: parceiro operacional que já opera o centro */
    salesCommissionsCoveredByOperational: { count: number; revenueGross: number };
    expensesWithoutProject: { count: number; total: number };
    /** entregues sem centro de custos (só no consolidado) */
    bookingsWithoutProject: { count: number; total: number };
    /** despesas de categorias "excluir da margem" — já contadas por outra via */
    excludedExpenses: { count: number; total: number; categories: Array<{ name: string; total: number }> };
    employeesWithoutProject: number;
    /** inativos sem fim de contrato: contam até `assumedEnd` (desativação / última atualização) */
    inactiveWithoutContractEnd: Array<{ employeeId: number; fullName: string; assumedEnd: string | null }>;
    extrasDiaTeamLeaderShifts: number;   // analítico, não somado
    payrollVariableMonths: string[];     // meses com variável do RH aplicado
    /** null = não calculado (só com includeMarketingCoverage) */
    marketingExcluded: { adSpend: number; marketingExpenses: number } | null;
    isCurrentPeriod: boolean;
  };
}

export const DELIVERED_STATUSES = ["CHECKED_OUT"];
const COLLECTED_STATUSES = ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT", "CHECKED_OUT"];
/** Carro estacionado (entrou e ainda não saiu). */
export const PARKED_STATUSES = ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT"];

const num = (v: unknown) => Number(v ?? 0) || 0;
const dayOf = (v: unknown) => String(v ?? "").slice(0, 10);

function addTo(map: Map<string, number>, key: string, v: number) {
  if (!v) return;
  map.set(key, (map.get(key) ?? 0) + v);
}

/** Coluna TIMESTAMP (UTC) das reservas como SQL qualificado para lisbonDaySql. */
const BOOKING_COL = { checkOut: "`multipark_bookings`.`checkOut`", checkIn: "`multipark_bookings`.`checkIn`" } as const;

/** Dia de Lisboa de uma coluna das reservas (literais validados; sem parâmetros → igual no SELECT e no GROUP BY). */
export function bookingLisbonDay(col: keyof typeof BOOKING_COL, from: string, to: string): SQL<string> {
  return sql<string>`${sql.raw(lisbonDaySql(BOOKING_COL[col], from, to))}`;
}

/**
 * Condições da RECEITA REALIZADA — a mesma regra em todo o lado (motor,
 * Diagnóstico, Parcerias): CHECKED_OUT com saída no período de Lisboa.
 */
export function deliveredConditions(from: string, to: string, projectIds?: number[] | null): SQL[] {
  const r = lisbonDayRangeUtc(from, to);
  const conds: SQL[] = [gte(multiparkBookings.checkOut, r.start), lt(multiparkBookings.checkOut, r.end), inArray(multiparkBookings.status, DELIVERED_STATUSES)];
  if (projectIds) conds.push(inArray(multiparkBookings.projectId, projectIds));
  return conds;
}

export function emptyFinanceResult(filters: FinanceFilters): FinanceResult {
  const zeroMargin = R.computeMargin({ revenueGross: 0, expensesGross: 0, salariesBase: 0, salariesProvisions: 0, salariesVariable: 0, employerTax: 0, extrasDia: 0, salesCommissions: 0, operationalCommissions: 0 });
  return {
    range: { from: filters.from, to: filters.to }, asOf: filters.today ?? "", granularity: filters.granularity ?? "day",
    params: {
      vatRate: R.FINANCE_PARAMS.vatRate, tsuEmployerRate: R.FINANCE_PARAMS.tsuEmployerRate,
      vatPeriods: [{ from: filters.from, to: filters.to, rate: R.FINANCE_PARAMS.vatRate }],
      tsuPeriods: [{ from: filters.from, to: filters.to, rate: R.FINANCE_PARAMS.tsuEmployerRate }],
      extrasDiaRates: { ...DEFAULT_EXTRA_RATES },
    },
    scope: { projectId: filters.projectId ?? null, projectIds: null, cities: null },
    revenue: { produced: 0, producedNet: 0, producedCount: 0, collected: 0, collectedNet: 0, collectedCount: 0, extrasRevenue: 0 },
    costs: { expenses: 0, expensesNet: 0, expensesPending: 0, salariesBase: 0, salariesProvisions: 0, salariesVariable: 0, salaries: 0, employerTax: 0, extrasDia: 0, extrasPlanned: 0, extrasReal: 0, salesCommissions: 0, operationalCommissions: 0, totalNet: 0, totalGross: 0 },
    margin: zeroMargin,
    projection: { applies: false, revenueGross: 0, revenueNet: 0, forecastRevenueNet: 0, costsNet: 0, futureCostsNet: 0, margin: 0, marginPct: null },
    timeseries: [],
    forecast: { revenue: 0, revenueNet: 0, count: 0, from: filters.from, to: filters.to },
    details: { deliveries: [], collected: [], expenses: [], expensesExcluded: [], expensesPending: [], extrasDia: [], extrasReal: [], salesCommissions: [], operationalPartners: [], salariesByProject: [], salaryDetails: [], forecast: [], months: [] },
    quality: {
      partnerConflicts: [], partnersRateMissing: [], campaignsWithoutPartner: [], salesCommissionsCoveredByOperational: { count: 0, revenueGross: 0 },
      expensesWithoutProject: { count: 0, total: 0 }, bookingsWithoutProject: { count: 0, total: 0 },
      excludedExpenses: { count: 0, total: 0, categories: [] },
      employeesWithoutProject: 0, inactiveWithoutContractEnd: [], extrasDiaTeamLeaderShifts: 0, payrollVariableMonths: [],
      marketingExcluded: null, isCurrentPeriod: false,
    },
  };
}

function lisbonToday(): string {
  return lisbonDayOf(Date.now());
}

export async function computeFinance(filters: FinanceFilters): Promise<FinanceResult> {
  R.assertIsoDay(filters.from, "from");
  R.assertIsoDay(filters.to, "to");
  const db = await getDb();
  const today = filters.today ?? lisbonToday();
  const gran: R.Granularity = filters.granularity ?? "day";
  const out = emptyFinanceResult({ ...filters, today, granularity: gran });
  if (!db) return out;
  const { from, to } = filters;
  // Datas das despesas/pendentes são dias de calendário (sem fuso).
  const fromStr = `${from} 00:00:00`;
  const toStr = `${to} 23:59:59`;
  // Reservas e ponto: instantes UTC → período de LISBOA [from 00:00, to+1 00:00).
  const utc = lisbonDayRangeUtc(from, to);
  const months = R.monthsOverlapping(from, to);
  out.details.months = months;
  out.quality.isCurrentPeriod = to >= today && from <= today;
  /** dia já realizado (≤ hoje) */
  const isPast = (d: string) => d <= today;

  // ─── Taxas IVA / TSU (Definições, com data de efeito) ─────────────────────
  const fr = await resolveFinanceRates(from, to, filters.rates);
  const rates = fr.rates;
  out.params = { ...out.params, vatRate: fr.vatAtEnd, tsuEmployerRate: fr.tsuAtEnd, vatPeriods: fr.vatPeriods, tsuPeriods: fr.tsuPeriods };
  const netOn = (gross: number, day: string) => R.netOfVat(gross, rates.vatOn(day));

  // ─── Árvore de projetos (uma leitura; serve filtro, rateio e cidades) ─────
  const allProjects = await db.select({ id: projects.id, name: projects.name, parentId: projects.parentId, level: projects.level }).from(projects);
  const projById = new Map(allProjects.map((p) => [p.id, p]));
  const childrenMap = new Map<number, number[]>();
  for (const p of allProjects) if (p.parentId != null) { if (!childrenMap.has(p.parentId)) childrenMap.set(p.parentId, []); childrenMap.get(p.parentId)!.push(p.id); }
  const leafDescendants = (pid: number): number[] => {
    const self = projById.get(pid);
    if (!self) return [pid];
    if (self.level === "project") return [pid];
    const kids = childrenMap.get(pid) ?? [];
    if (kids.length === 0) return [pid];
    const res: number[] = [];
    for (const k of kids) res.push(...leafDescendants(k));
    return res.length ? res : [pid];
  };
  const cityKeyOf = (pid: number | null): string | null => {
    let cur = pid == null ? undefined : projById.get(pid);
    let guard = 0;
    while (cur && guard++ < 20) {
      if (cur.level === "city") return matchCityKey(cur.name);
      cur = cur.parentId != null ? projById.get(cur.parentId) : undefined;
    }
    return null;
  };

  let projectIds: number[] | undefined;
  let projectSet: Set<number> | undefined;
  let cities: string[] | null = null;
  if (filters.projectId) {
    const ids = await resolveProjectIds(filters.projectId);
    projectIds = ids;
    projectSet = new Set(ids);
    const keys = new Set<string>();
    let hasUnscoped = false;
    for (const pid of ids) { const k = cityKeyOf(pid); if (k) keys.add(R.extrasCityFromKey(k)!); else if (projById.get(pid)?.level === "group") hasUnscoped = true; }
    cities = hasUnscoped || keys.size === 0 ? null : Array.from(keys);
  }
  out.scope = { projectId: filters.projectId ?? null, projectIds: projectIds ?? null, cities };

  // ─── 1. Entregues (por dia de Lisboa × centro) e por campanha ─────────────
  const deliveryConds = deliveredConditions(from, to, projectIds);
  const dayExpr = bookingLisbonDay("checkOut", from, to);
  const deliveryRows = await db
    .select({
      day: dayExpr, projectId: multiparkBookings.projectId, projectName: projects.name,
      count: sql<number>`COUNT(*)`, totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
      parkingRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.parkingPrice}), 0)`,
      deliveryCharges: sql<number>`COALESCE(SUM(${multiparkBookings.deliveryCharges}), 0)`,
      extrasRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.extrasTotal}), 0)`,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...deliveryConds))
    .groupBy(dayExpr, multiparkBookings.projectId, projects.name);

  const campaignRows = await db
    .select({
      day: dayExpr, projectId: multiparkBookings.projectId, projectName: projects.name, campaign: multiparkBookings.campaign,
      count: sql<number>`COUNT(*)`, totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...deliveryConds, isNotNull(multiparkBookings.campaign), sql`${multiparkBookings.campaign} <> ''`))
    .groupBy(dayExpr, multiparkBookings.projectId, projects.name, multiparkBookings.campaign);

  // ─── 2. Recolhidos (por dia de Lisboa × centro) ───────────────────────────
  const collectedConds: SQL[] = [gte(multiparkBookings.checkIn, utc.start), lt(multiparkBookings.checkIn, utc.end), inArray(multiparkBookings.status, COLLECTED_STATUSES)];
  if (projectIds) collectedConds.push(inArray(multiparkBookings.projectId, projectIds));
  const dayInExpr = bookingLisbonDay("checkIn", from, to);
  const collectedRows = await db
    .select({ day: dayInExpr, projectId: multiparkBookings.projectId, projectName: projects.name, count: sql<number>`COUNT(*)`, totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)` })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...collectedConds))
    .groupBy(dayInExpr, multiparkBookings.projectId, projects.name);

  // ─── 3. Despesas (data da despesa, não canceladas) — contadas UMA vez ─────
  const expConds: SQL[] = [sql`${expenses.status} <> 'cancelled'`, gte(expenses.expenseDate, fromStr), lte(expenses.expenseDate, toStr)];
  if (projectIds) expConds.push(inArray(expenses.projectId, projectIds));
  const expDayExpr = sql<string>`DATE(${expenses.expenseDate})`;
  // IVA da linha: autoliquidação → 0; taxa da categoria; senão a normal do dia.
  const expVat = sql`(CASE WHEN COALESCE(${expenseCategories.reverseCharge}, 0) = 1 THEN 0 ELSE COALESCE(${expenseCategories.vatRate} / 100, ${rateCaseSql(expDayExpr, fr.vatPeriods, R.FINANCE_PARAMS.vatRate)}) END)`;
  const expenseRows = await db
    .select({ day: expDayExpr, projectId: expenses.projectId, projectName: projects.name, categoryId: expenseCategories.id, categoryName: expenseCategories.name,
      excluded: sql<number>`MAX(COALESCE(${expenseCategories.excludeFromMargin}, 0))`,
      count: sql<number>`COUNT(*)`, totalAmount: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
      totalNet: sql<number>`COALESCE(SUM(${expenses.amount} / (1 + ${expVat})), 0)` })
    .from(expenses)
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(and(...expConds))
    .groupBy(expDayExpr, expenses.projectId, projects.name, expenseCategories.id, expenseCategories.name);

  // Pendentes com vencimento no período — INFORMAÇÃO (dívida), não custo.
  const pendConds: SQL[] = [inArray(expenses.status, ["pending", "overdue"]), isNotNull(expenses.paymentDueDate), gte(expenses.paymentDueDate, fromStr), lte(expenses.paymentDueDate, toStr)];
  if (projectIds) pendConds.push(inArray(expenses.projectId, projectIds));
  const pendingRows = await db
    .select({ projectId: expenses.projectId, projectName: projects.name, categoryName: expenseCategories.name, supplier: expenses.supplier, count: sql<number>`COUNT(*)`, totalAmount: sql<number>`COALESCE(SUM(${expenses.amount}), 0)` })
    .from(expenses)
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(and(...pendConds))
    .groupBy(expenses.projectId, projects.name, expenseCategories.name, expenses.supplier);

  // ─── 4. Equipa do dia: só extras, saída antecipada, cidade do centro ──────
  // Ponto em dias de LISBOA (mesma janela UTC das reservas).
  const extraRatesLive = await loadExtraRates();
  out.params = { ...out.params, extrasDiaRates: extraRatesLive };
  const extrasCostRows = await loadExtrasCostRows(db, { from, to, projectIds, cities, pontoRange: { start: utc.start, endExclusive: utc.end } });

  // ─── 5. Parceiros: UMA regra de correspondência (./partners.ts) ───────────
  const { partners: partnerRows, index: partnerIndex } = await loadPartnerIndex(db);
  const operatedLeaves = await operatedLeavesByPartner(partnerRows, resolveProjectIds, projectSet);

  // ─── 6. Pessoal: colaboradores + histórico salarial ───────────────────────
  const empRows = await db
    .select({ id: employees.id, fullName: employees.fullName, projectId: employees.projectId, contractType: employees.contractType, position: employees.position, monthlySalary: employees.monthlySalary, isActive: employees.isActive, contractStart: employees.contractStart, contractEnd: employees.contractEnd, deactivatedAt: employees.deactivatedAt, updatedAt: employees.updatedAt })
    .from(employees);
  const empIds = empRows.map((e) => e.id);
  const histRows = empIds.length ? await db
    .select({ employeeId: employeeSalaryHistory.employeeId, monthlySalary: employeeSalaryHistory.monthlySalary, effectiveFrom: employeeSalaryHistory.effectiveFrom, effectiveUntil: employeeSalaryHistory.effectiveUntil })
    .from(employeeSalaryHistory)
    .where(and(inArray(employeeSalaryHistory.employeeId, empIds), lte(employeeSalaryHistory.effectiveFrom, to), or(isNull(employeeSalaryHistory.effectiveUntil), gte(employeeSalaryHistory.effectiveUntil, from))!)) : [];
  const histByEmp = new Map<number, typeof histRows>();
  for (const h of histRows) { if (!histByEmp.has(h.employeeId)) histByEmp.set(h.employeeId, []); histByEmp.get(h.employeeId)!.push(h); }

  // ─── 7. Receita esperada (Fecho previsto): saída prevista ≤ `to` ──────────
  // Carros ESTACIONADOS com saída no período + reservas que ainda entram
  // (check-in de hoje em diante) com saída no período. Só com o período em
  // curso/futuro; um período fechado não tem previsão.
  const fcFrom = R.maxDay(from, today);
  const todayStartUtc = lisbonDayRangeUtc(today).start;
  const forecastRows = to >= today ? await db
    .select({ day: dayExpr, projectId: multiparkBookings.projectId, projectName: projects.name, campaign: multiparkBookings.campaign, count: sql<number>`COUNT(*)`, totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)` })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(
      gte(multiparkBookings.checkOut, utc.start), lt(multiparkBookings.checkOut, utc.end),
      notInArray(multiparkBookings.status, ["CANCELLED", ...DELIVERED_STATUSES]),
      or(inArray(multiparkBookings.status, PARKED_STATUSES), gte(multiparkBookings.checkIn, todayStartUtc))!,
      ...(projectIds ? [inArray(multiparkBookings.projectId, projectIds)] : []),
    ))
    .groupBy(dayExpr, multiparkBookings.projectId, projects.name, multiparkBookings.campaign) : [];

  // ─── 8. Marketing (EXCLUÍDO dos custos) — só a pedido ─────────────────────
  if (filters.includeMarketingCoverage) {
    const mktConds: SQL[] = [gte(marketingExpenses.date, fromStr), lte(marketingExpenses.date, toStr)];
    if (projectIds) mktConds.push(inArray(marketingExpenses.projectId, projectIds));
    const [mkt] = await db.select({ total: sql<number>`COALESCE(SUM(${marketingExpenses.amount}), 0)` }).from(marketingExpenses).where(and(...mktConds));
    const { getAdMetrics } = await import("../integrations/googleAds/adMetrics");
    const adsMetrics = await getAdMetrics({ from, to, projectIds: projectIds ?? null });
    out.quality.marketingExcluded = { adSpend: num(adsMetrics.totals.cost), marketingExpenses: num(mkt?.total) };
  }

  // ═══════════════════════════════ CÁLCULO ══════════════════════════════════
  const producedByDay = new Map<string, number>();
  const producedCountByDay = new Map<string, number>();
  const collectedByDay = new Map<string, number>();
  const collectedCountByDay = new Map<string, number>();
  const expensesByDay = new Map<string, number>();
  const expensesNetByDay = new Map<string, number>();
  const salariesByDay = new Map<string, number>();
  const employerTaxByDay = new Map<string, number>();
  const salesByDay = new Map<string, number>();
  const opByDay = new Map<string, number>();
  const extrasByDay = new Map<string, number>();
  const forecastByDay = new Map<string, number>();
  /** custos dos dias futuros (não realizados) — só para o Fecho previsto */
  const futureCostByDay = new Map<string, number>();

  // Receita
  const delivByProject = new Map<string, FinanceResult["details"]["deliveries"][number]>();
  let extrasRevenue = 0;
  const bookingsWithoutProject = { count: 0, total: 0 };
  for (const r of deliveryRows) {
    const day = dayOf(r.day);
    addTo(producedByDay, day, num(r.totalRevenue));
    addTo(producedCountByDay, day, num(r.count));
    extrasRevenue += num(r.extrasRevenue);
    if (r.projectId == null) { bookingsWithoutProject.count += num(r.count); bookingsWithoutProject.total += num(r.totalRevenue); }
    const k = String(r.projectId ?? "null");
    const ex = delivByProject.get(k) ?? { projectId: r.projectId ?? null, projectName: r.projectName ?? null, count: 0, totalRevenue: 0, parkingRevenue: 0, deliveryCharges: 0, extrasRevenue: 0 };
    ex.count += num(r.count); ex.totalRevenue += num(r.totalRevenue); ex.parkingRevenue += num(r.parkingRevenue); ex.deliveryCharges += num(r.deliveryCharges); ex.extrasRevenue += num(r.extrasRevenue);
    delivByProject.set(k, ex);
  }
  out.quality.bookingsWithoutProject = bookingsWithoutProject;
  const collByProject = new Map<string, FinanceResult["details"]["collected"][number]>();
  for (const r of collectedRows) {
    const day = dayOf(r.day);
    addTo(collectedByDay, day, num(r.totalRevenue));
    addTo(collectedCountByDay, day, num(r.count));
    const k = String(r.projectId ?? "null");
    const ex = collByProject.get(k) ?? { projectId: r.projectId ?? null, projectName: r.projectName ?? null, count: 0, totalRevenue: 0 };
    ex.count += num(r.count); ex.totalRevenue += num(r.totalRevenue);
    collByProject.set(k, ex);
  }

  // Despesas — realizadas até hoje; datadas no futuro só entram no Fecho previsto.
  const expByProjCat = new Map<string, FinanceResult["details"]["expenses"][number]>();
  const expExcludedByProjCat = new Map<string, FinanceResult["details"]["expensesExcluded"][number]>();
  const excludedCats = new Map<string, number>();
  const excluded = { count: 0, total: 0 };
  const expensesWithoutProject = { count: 0, total: 0 };
  for (const r of expenseRows) {
    const day = dayOf(r.day);
    const projectName = r.projectName ?? (r.projectId == null ? "Por atribuir" : null);
    const k = `${r.projectId ?? "null"}|${r.categoryName ?? ""}`;
    if (num(r.excluded) === 1) {
      excluded.count += num(r.count); excluded.total += num(r.totalAmount);
      excludedCats.set(r.categoryName ?? "Sem categoria", (excludedCats.get(r.categoryName ?? "Sem categoria") ?? 0) + num(r.totalAmount));
      const ex = expExcludedByProjCat.get(k) ?? { projectId: r.projectId ?? null, projectName, categoryName: r.categoryName ?? null, count: 0, totalAmount: 0 };
      ex.count += num(r.count); ex.totalAmount += num(r.totalAmount);
      expExcludedByProjCat.set(k, ex);
      continue;
    }
    if (!isPast(day)) { addTo(futureCostByDay, day, num(r.totalNet)); continue; }
    addTo(expensesByDay, day, num(r.totalAmount));
    addTo(expensesNetByDay, day, num(r.totalNet));
    if (r.projectId == null) { expensesWithoutProject.count += num(r.count); expensesWithoutProject.total += num(r.totalAmount); }
    const ex = expByProjCat.get(k) ?? { projectId: r.projectId ?? null, projectName, categoryName: r.categoryName ?? null, count: 0, totalAmount: 0, totalNet: 0 };
    ex.count += num(r.count); ex.totalAmount += num(r.totalAmount); ex.totalNet += num(r.totalNet);
    expByProjCat.set(k, ex);
  }
  out.quality.expensesWithoutProject = expensesWithoutProject;
  out.quality.excludedExpenses = { ...excluded, categories: Array.from(excludedCats, ([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total) };
  const expensesPending = pendingRows.reduce((s, r) => s + num(r.totalAmount), 0);

  // Equipa do dia — REAL (ponto) até hoje; a ESCALA (previsto) nos dias futuros
  // vai para o Fecho previsto.
  const extrasAgg = aggregateExtrasCost(extrasCostRows, extraRatesLive, { dayOfRecord: (v) => (v ? lisbonDayOf(v) : ""), cityOfProject: () => null });
  out.quality.extrasDiaTeamLeaderShifts = extrasAgg.teamLeaderShifts;
  for (const [d, v] of extrasAgg.realByDay) if (isPast(d)) addTo(extrasByDay, d, v);
  for (const [d, v] of extrasAgg.plannedByDay) if (!isPast(d)) addTo(futureCostByDay, d, v);

  // Comissões — venda (campanha → parceiro) e operacional (centros operados).
  // Base SEM IVA (taxa do dia) salvo parceiro 'gross'; sem comissão a dobrar.
  const rateMissing = new Set<string>();
  const noPartner = new Map<string, { campaign: string; revenueGross: number; bookingsCount: number }>();
  const covered = { count: 0, revenueGross: 0 };
  const salesAgg = new Map<string, SalesCommissionRow>();
  const salesCommissionOf = (
    rows: Array<{ day: unknown; projectId: number | null; projectName: string | null; campaign: string | null; count: unknown; totalRevenue: unknown }>,
    sink: (day: string, v: number) => void, track: boolean,
  ) => {
    for (const r of rows) {
      if (!r.campaign || !String(r.campaign).trim()) continue;
      const day = dayOf(r.day);
      const partner = partnerForCampaign(partnerIndex, r.campaign);
      const gross = num(r.totalRevenue), net = netOn(gross, day);
      if (!partner) {
        if (track) {
          const key = String(r.campaign).trim().toLowerCase();
          const ex = noPartner.get(key) ?? { campaign: r.campaign ?? "", revenueGross: 0, bookingsCount: 0 };
          ex.revenueGross += gross; ex.bookingsCount += num(r.count);
          noPartner.set(key, ex);
        }
        continue;
      }
      if (R.salesCommissionCoveredByOperational(partner, r.projectId, operatedLeaves)) {
        if (track) { covered.count += num(r.count); covered.revenueGross += gross; }
        continue;
      }
      const { commission, status } = R.commissionFor(gross, partner, net);
      sink(day, commission);
      if (!track) continue;
      if (status === "rate_missing") rateMissing.add(partner.name);
      const k = `${partner.id}|${r.projectId ?? "null"}`;
      const ex = salesAgg.get(k) ?? { partnerId: partner.id, partnerName: partner.name, projectId: r.projectId ?? null, projectName: r.projectName ?? null, bookingsCount: 0, revenueGross: 0, revenueNet: 0, commissionBase: R.commissionBaseOf(partner), commissionRate: partner.commissionRate, commission: 0, status };
      ex.bookingsCount += num(r.count); ex.revenueGross += gross; ex.revenueNet += net; ex.commission += commission;
      salesAgg.set(k, ex);
    }
  };
  const opAgg = new Map<number, OperationalRow>();
  const operationalCommissionOf = (
    rows: Array<{ day: unknown; projectId: number | null; projectName: string | null; count: unknown; totalRevenue: unknown }>,
    sink: (day: string, v: number) => void, track: boolean,
  ) => {
    for (const p of partnerRows) {
      const leaves = operatedLeaves.get(p.id);
      if (!leaves) continue;
      const rate = num(p.commissionRate);
      const base = R.commissionBaseOf(p);
      const agg = opAgg.get(p.id) ?? { partnershipId: p.id, partnerName: p.name, partnerType: p.partnerType ?? null, projectNames: [], bookingsCount: 0, revenueGross: 0, revenueNet: 0, commissionBase: base, commissionRate: rate, commission: 0 };
      for (const r of rows) {
        if (r.projectId == null || !leaves.has(r.projectId)) continue;
        const day = dayOf(r.day);
        const gross = num(r.totalRevenue), net = netOn(gross, day);
        const commission = (base === "gross" ? gross : net) * (rate / 100);
        sink(day, commission);
        if (!track) continue;
        agg.revenueGross += gross; agg.revenueNet += net; agg.bookingsCount += num(r.count); agg.commission += commission;
        if (r.projectName && !agg.projectNames.includes(r.projectName)) agg.projectNames.push(r.projectName);
      }
      if (track) opAgg.set(p.id, agg);
    }
  };
  salesCommissionOf(campaignRows, (d, v) => addTo(salesByDay, d, v), true);
  operationalCommissionOf(deliveryRows, (d, v) => addTo(opByDay, d, v), true);
  // Receita esperada paga as mesmas comissões (Fecho previsto).
  const forecastCommissionByDay = new Map<string, number>();
  salesCommissionOf(forecastRows, (d, v) => addTo(forecastCommissionByDay, d, v), false);
  operationalCommissionOf(forecastRows, (d, v) => addTo(forecastCommissionByDay, d, v), false);

  out.quality.partnerConflicts = partnerIndex.conflicts;
  out.quality.partnersRateMissing = Array.from(rateMissing);
  out.quality.campaignsWithoutPartner = Array.from(noPartner.values()).sort((a, b) => b.revenueGross - a.revenueGross).slice(0, 50);
  out.quality.salesCommissionsCoveredByOperational = covered;
  const salesCommissions = Array.from(salesAgg.values()).sort((a, b) => b.commission - a.commission);
  const operationalPartners = Array.from(opAgg.values()).sort((a, b) => b.commission - a.commission);

  // Pessoal — base + provisões por dia de calendário, histórico por mês.
  // Realizado = dias ≤ hoje; os dias futuros vão para o Fecho previsto.
  const salaryByProject = new Map<number, number>();
  const salaryDetails: FinanceResult["details"]["salaryDetails"] = [];
  let salariesBase = 0, salariesProvisions = 0, employerTax = 0;
  let employeesWithoutProject = 0;
  const inactiveList: FinanceResult["quality"]["inactiveWithoutContractEnd"] = [];
  let salariesUnallocated = 0;
  const empShare = new Map<number, { share: number; targets: number[] }>();
  for (const e of empRows) {
    if (R.isExtraEmployee(e)) continue;
    const contractStart = e.contractStart ? dayOf(e.contractStart) : null;
    const endInfo = R.assumedContractEnd(e);
    // aviso só para quem pesa neste período (saiu depois do início)
    if (endInfo.assumed && (!endInfo.end || endInfo.end >= from)) inactiveList.push({ employeeId: e.id, fullName: e.fullName, assumedEnd: endInfo.end });
    // inativo sem fim de contrato NEM data nenhuma: não há como saber até quando contou
    if (endInfo.assumed && !endInfo.end) continue;
    const contractEnd = endInfo.end;
    // salário vigente em cada mês (snapshot ao dia 1, como o payroll)
    const salaryByMonth: Record<string, number> = {};
    const hist = histByEmp.get(e.id) ?? [];
    for (const mo of months) {
      const first = `${mo.year}-${String(mo.month).padStart(2, "0")}-01`;
      const snap = hist.filter((h) => h.effectiveFrom <= first && (!h.effectiveUntil || h.effectiveUntil >= first)).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
      salaryByMonth[`${mo.year}-${String(mo.month).padStart(2, "0")}`] = snap ? num(snap.monthlySalary) : num(e.monthlySalary);
    }
    const sal = R.salaryForPeriod({ monthlySalary: num(e.monthlySalary), from, to, contractStart, contractEnd, salaryByMonth });
    if (sal.days === 0 || (sal.base === 0 && sal.provisions === 0)) continue;
    const targets = e.projectId == null ? [] : leafDescendants(e.projectId);
    const { matching, share } = R.shareTargets(targets, projectSet);
    if (e.projectId == null) employeesWithoutProject++;
    // Sem centro: só entra no consolidado (sem filtro) — "Por atribuir".
    const effShare = targets.length === 0 ? (projectSet ? 0 : 1) : share;
    if (effShare === 0) continue;
    empShare.set(e.id, { share: effShare, targets: matching });
    let base = 0, prov = 0, days = 0;
    for (const d of sal.perDay) {
      const b = d.base * effShare, p = d.provisions * effShare;
      // TSU com a taxa do dia sobre base + provisões (13.º/14.º pagam TSU)
      const dayTax = R.employerTaxFor(b + p, rates.tsuOn(d.day));
      if (!isPast(d.day)) { addTo(futureCostByDay, d.day, b + p + dayTax); continue; }
      base += b; prov += p; days++;
      addTo(salariesByDay, d.day, b + p);
      employerTax += dayTax;
      addTo(employerTaxByDay, d.day, dayTax);
    }
    salariesBase += base; salariesProvisions += prov;
    if (base + prov === 0) continue;
    if (matching.length === 0) salariesUnallocated += base + prov;
    else for (const t of matching) salaryByProject.set(t, (salaryByProject.get(t) ?? 0) + (base + prov) / matching.length);
    salaryDetails.push({ employeeId: e.id, fullName: e.fullName, projectId: e.projectId ?? null, cost: base + prov, base, provisions: prov, variable: 0, days, ratedTo: matching });
  }
  out.quality.employeesWithoutProject = employeesWithoutProject;
  out.quality.inactiveWithoutContractEnd = inactiveList;

  // Pessoal — variável do RH (horas extra / noturnas / FDS / alimentação) por mês
  // com ponto registado. Só meses já iniciados; repartido pelos dias JÁ
  // decorridos desse mês (o ponto é do que já aconteceu). Extras NÃO entram
  // aqui: o custo deles já está na equipa do dia.
  let salariesVariable = 0;
  const payrollMonths: string[] = [];
  const detailById = new Map(salaryDetails.map((d) => [d.employeeId, d]));
  for (const mo of months) {
    if (mo.from > today) continue;
    let payroll: Awaited<ReturnType<typeof getPayrollData>>;
    try { payroll = await getPayrollData(mo.year, mo.month); } catch { continue; }
    let monthVariable = 0, monthTaxable = 0;
    for (const p of payroll) {
      if (p.isExtra) continue;
      const sh = empShare.get(p.employeeId);
      if (!sh) continue;
      const frac = mo.days / mo.daysInMonth;
      const taxable = (p.overtimePayment + p.nightPayment + p.weekendPayment) * sh.share * frac;
      const variable = taxable + p.mealAllowance * sh.share * frac;
      if (!variable) continue;
      monthVariable += variable; monthTaxable += taxable;
      const d = detailById.get(p.employeeId);
      if (d) { d.variable += variable; d.cost += variable; }
      if (sh.targets.length) for (const t of sh.targets) salaryByProject.set(t, (salaryByProject.get(t) ?? 0) + variable / sh.targets.length);
      else salariesUnallocated += variable;
    }
    if (monthVariable) {
      payrollMonths.push(`${mo.year}-${String(mo.month).padStart(2, "0")}`);
      salariesVariable += monthVariable;
      const lastDay = R.minDay(mo.to, today);
      const nDays = R.daysBetweenInclusive(mo.from, lastDay);
      const perDayV = monthVariable / nDays, perDayTaxable = monthTaxable / nDays;
      for (let d = mo.from; d <= lastDay; d = R.addDays(d, 1)) {
        const dayTax = R.employerTaxFor(perDayTaxable, rates.tsuOn(d));
        employerTax += dayTax;
        addTo(salariesByDay, d, perDayV); addTo(employerTaxByDay, d, dayTax);
      }
    }
  }
  out.quality.payrollVariableMonths = payrollMonths;

  // Receita esperada — saídas atrasadas de carros estacionados contam HOJE.
  const forecastByProject = new Map<string, FinanceResult["details"]["forecast"][number]>();
  let forecastCount = 0;
  for (const r of forecastRows) {
    const day = R.maxDay(dayOf(r.day), today);
    addTo(forecastByDay, day, num(r.totalRevenue));
    forecastCount += num(r.count);
    const k = String(r.projectId ?? "null");
    const ex = forecastByProject.get(k) ?? { projectId: r.projectId ?? null, projectName: r.projectName ?? null, count: 0, totalRevenue: 0 };
    ex.count += num(r.count); ex.totalRevenue += num(r.totalRevenue);
    forecastByProject.set(k, ex);
  }
  for (const [d, v] of forecastCommissionByDay) addTo(futureCostByDay, R.maxDay(d, today), v);

  // ─── Totais (somas dos mapas diários) ─────────────────────────────────────
  const sum = (m: Map<string, number>) => { let s = 0; for (const v of m.values()) s += v; return s; };
  const netByDay = (m: Map<string, number>) => { const o = new Map<string, number>(); for (const [d, v] of m) addTo(o, d, netOn(v, d)); return o; };
  const producedNetByDay = netByDay(producedByDay), collectedNetByDay = netByDay(collectedByDay), forecastNetByDay = netByDay(forecastByDay);
  const produced = sum(producedByDay), collected = sum(collectedByDay), expensesGross = sum(expensesByDay);
  const extrasDia = sum(extrasByDay);
  const salesCommissionsTotal = salesCommissions.reduce((s, r) => s + r.commission, 0);
  const operationalTotal = operationalPartners.reduce((s, r) => s + r.commission, 0);
  const margin = R.computeMargin({ revenueGross: produced, revenueNet: sum(producedNetByDay), vatRate: fr.vatAtEnd, expensesGross, expensesNet: sum(expensesNetByDay), salariesBase, salariesProvisions, salariesVariable, employerTax, extrasDia, salesCommissions: salesCommissionsTotal, operationalCommissions: operationalTotal });

  out.revenue = {
    produced, producedNet: margin.revenueNet, producedCount: sum(producedCountByDay),
    collected, collectedNet: sum(collectedNetByDay), collectedCount: sum(collectedCountByDay), extrasRevenue,
  };
  out.costs = {
    expenses: expensesGross, expensesNet: margin.expensesNet, expensesPending,
    salariesBase, salariesProvisions, salariesVariable, salaries: margin.salaries, employerTax,
    extrasDia, extrasPlanned: sum(extrasAgg.plannedByDay), extrasReal: sum(extrasAgg.realByDay),
    salesCommissions: salesCommissionsTotal, operationalCommissions: operationalTotal,
    totalNet: margin.totalCostsNet, totalGross: margin.totalCostsGross,
  };
  out.margin = margin;
  const forecastRevenue = sum(forecastByDay), forecastRevenueNet = sum(forecastNetByDay);
  const futureCostsNet = sum(futureCostByDay);
  const projRevenueNet = margin.revenueNet + forecastRevenueNet;
  const projCosts = margin.totalCostsNet + futureCostsNet;
  out.projection = {
    applies: to >= today,
    revenueGross: produced + forecastRevenue, revenueNet: projRevenueNet, forecastRevenueNet,
    costsNet: projCosts, futureCostsNet, margin: projRevenueNet - projCosts,
    marginPct: projRevenueNet > 0 ? ((projRevenueNet - projCosts) / projRevenueNet) * 100 : null,
  };
  out.forecast = { revenue: forecastRevenue, revenueNet: forecastRevenueNet, count: forecastCount, from: fcFrom <= to ? fcFrom : to, to };

  // ─── Série temporal: TODOS os mapas diários → buckets (mesma função) ──────
  const buckets = new Map<string, FinancePoint>();
  const point = (day: string) => {
    const bk = R.bucketKey(day, gran);
    let p = buckets.get(bk);
    if (!p) { p = { bucket: bk, produced: 0, producedNet: 0, producedCount: 0, collected: 0, collectedCount: 0, expenses: 0, expensesNet: 0, salaries: 0, employerTax: 0, partners: 0, salesCommissions: 0, operationalCommissions: 0, extrasCost: 0, revenueForecast: 0, revenueForecastNet: 0, costForecast: 0, totalCost: 0, margin: 0, marginForecast: 0 }; buckets.set(bk, p); }
    return p;
  };
  const fold = (m: Map<string, number>, key: keyof FinancePoint) => { for (const [day, v] of m) { if (day >= from && day <= to) (point(day)[key] as number) += v; } };
  fold(producedByDay, "produced"); fold(producedNetByDay, "producedNet"); fold(producedCountByDay, "producedCount");
  fold(collectedByDay, "collected"); fold(collectedCountByDay, "collectedCount");
  fold(expensesByDay, "expenses"); fold(expensesNetByDay, "expensesNet"); fold(salariesByDay, "salaries"); fold(employerTaxByDay, "employerTax");
  fold(salesByDay, "salesCommissions"); fold(opByDay, "operationalCommissions");
  fold(extrasByDay, "extrasCost"); fold(forecastByDay, "revenueForecast"); fold(forecastNetByDay, "revenueForecastNet");
  fold(futureCostByDay, "costForecast");
  for (const p of buckets.values()) {
    p.partners = p.salesCommissions + p.operationalCommissions;
    p.totalCost = p.expensesNet + p.salaries + p.employerTax + p.partners + p.extrasCost;
    p.margin = p.producedNet - p.totalCost;
    p.marginForecast = p.producedNet + p.revenueForecastNet - p.totalCost - p.costForecast;
  }
  out.timeseries = Array.from(buckets.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));

  // ─── Detalhes ─────────────────────────────────────────────────────────────
  const salariesByProjectRows: FinanceResult["details"]["salariesByProject"] = Array.from(salaryByProject.entries())
    .map(([pid, cost]) => ({ projectId: pid, projectName: projById.get(pid)?.name ?? null, cost }))
    .sort((a, b) => b.cost - a.cost);
  if (salariesUnallocated > 0) salariesByProjectRows.push({ projectId: null, projectName: "Por atribuir", cost: salariesUnallocated });
  out.details = {
    deliveries: Array.from(delivByProject.values()).sort((a, b) => b.totalRevenue - a.totalRevenue),
    collected: Array.from(collByProject.values()).sort((a, b) => b.totalRevenue - a.totalRevenue),
    expenses: Array.from(expByProjCat.values()).sort((a, b) => b.totalAmount - a.totalAmount),
    expensesExcluded: Array.from(expExcludedByProjCat.values()).sort((a, b) => b.totalAmount - a.totalAmount),
    expensesPending: pendingRows.map((r) => ({ projectId: r.projectId ?? null, projectName: r.projectName ?? (r.projectId == null ? "Por atribuir" : null), categoryName: r.categoryName ?? null, supplier: r.supplier ?? null, count: num(r.count), totalAmount: num(r.totalAmount) })),
    extrasDia: Array.from(extrasAgg.plannedByLevel.values()),
    extrasReal: Array.from(extrasAgg.realByLevel.values()),
    salesCommissions,
    operationalPartners,
    salariesByProject: salariesByProjectRows,
    salaryDetails: filters.includePersonDetails ? salaryDetails : [],
    forecast: Array.from(forecastByProject.values()).sort((a, b) => b.totalRevenue - a.totalRevenue),
    months,
  };
  return out;
}

/** Estado de um mês face a hoje: passado, em curso ou futuro. */
export function monthStatus(mo: { from: string; to: string }, today: string): "past" | "current" | "future" {
  if (mo.from > today) return "future";
  if (mo.to >= today) return "current";
  return "past";
}

/** Linhas mensais (Anual) a partir do motor: um período por mês, mesma fórmula. */
export function monthlyRowsFromTimeseries(result: FinanceResult) {
  const byMonth = new Map(result.timeseries.map((p) => [p.bucket, p]));
  return result.details.months.map((mo) => {
    const key = `${mo.year}-${String(mo.month).padStart(2, "0")}`;
    const p = byMonth.get(key);
    const produced = p?.produced ?? 0, expensesGross = p?.expenses ?? 0;
    // Sem IVA já vêm dia a dia do motor (taxa em vigor em cada dia)
    const revenueNet = p?.producedNet ?? 0, expensesNet = p?.expensesNet ?? 0;
    const salaries = p?.salaries ?? 0, employerTax = p?.employerTax ?? 0, partners = p?.partners ?? 0, extras = p?.extrasCost ?? 0;
    const totalCosts = expensesNet + salaries + employerTax + partners + extras;
    const forecastRevenueNoVat = p?.revenueForecastNet ?? 0, forecastCosts = p?.costForecast ?? 0;
    return {
      year: mo.year, month: mo.month,
      status: monthStatus(mo, result.asOf),
      revenueWithVat: produced, revenueNoVat: revenueNet, vatRevenue: produced - revenueNet,
      commissions: partners, salesCommissions: p?.salesCommissions ?? 0, operationalCommissions: p?.operationalCommissions ?? 0,
      expensesWithVat: expensesGross, expensesNoVat: expensesNet, vatExpenses: expensesGross - expensesNet,
      vatToPay: (produced - revenueNet) - (expensesGross - expensesNet),
      extrasDiaCost: extras, salaries, employerTax, totalCosts, profit: revenueNet - totalCosts,
      producedCount: p?.producedCount ?? 0,
      // Fecho previsto do mês (em curso/futuro): realizado + esperado − custos do mês inteiro
      forecastRevenueNoVat, forecastCosts,
      forecastProfit: revenueNet + forecastRevenueNoVat - totalCosts - forecastCosts,
    };
  });
}
