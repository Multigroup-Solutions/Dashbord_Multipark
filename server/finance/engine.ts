/**
 * MOTOR FINANCEIRO ÚNICO — Faturação, Anual, gráfico e detalhes saem daqui.
 *
 * Vai buscar os dados uma vez, AO DIA, e aplica as regras de ./rules.ts. As
 * séries do gráfico e os cartões são somas dos MESMOS mapas diários, por isso
 * batem ao cêntimo por construção. Substitui getBillingData/getAnnualBreakdown
 * (agora em ./legacy.ts, só para a comparação antes/depois).
 *
 * Regras que este motor fixa (antes divergiam entre as duas vistas):
 *   - receita realizada = CHECKED_OUT pela data de saída (as duas vistas);
 *   - despesas não canceladas pela data da despesa, contadas UMA vez
 *     (pendentes são informação, não custo adicional);
 *   - comissões (venda + operacional) são CUSTO; nunca deduzidas à receita;
 *   - marketing NÃO entra (as faturas do Google já estão nas despesas) — fica
 *     em `quality.marketingExcluded` para comparação;
 *   - pessoal: histórico salarial por mês, mês completo = salário mensal,
 *     início/fim de contrato, inclui inativos com vínculo no período, extras
 *     excluídos por UM critério, provisões 13.º/14.º, variável do RH (horas
 *     extra/noturnas/FDS/alimentação) quando existe ponto, TSU sobre a base
 *     tributável;
 *   - equipa do dia: só extras (team leader assalariado NÃO conta duas vezes),
 *     saída antecipada respeitada, filtrada pela cidade do centro escolhido;
 *   - custos sem centro entram no consolidado como "Por atribuir" e NUNCA num
 *     filtro de centro.
 */
import { and, eq, gte, lte, sql, isNotNull, inArray, notInArray, or, isNull } from "drizzle-orm";
import {
  multiparkBookings, projects, expenses, expenseCategories, extrasDiaAssignments,
  partnerships, partnerAliases, employees, employeeSalaryHistory, marketingExpenses,
  campaignDailyStats, campaigns,
} from "../../drizzle/schema";
import { getDb, resolveProjectIds, toMysqlDateTime, getPayrollData } from "../db";
import { matchCityKey } from "../../shared/city";
import { parsePartnerConfig } from "../../shared/partnerTypes";
import * as R from "./rules";

export interface FinanceFilters {
  from: string;                 // YYYY-MM-DD
  to: string;                   // YYYY-MM-DD (inclusivo)
  projectId?: number;           // centro de custos (com descendentes; negativo = marca global)
  granularity?: R.Granularity;
  /** "hoje" (Lisboa) — injetável para testes/paridade */
  today?: string;
  /** devolver salários POR PESSOA (só para detalhe autorizado) */
  includePersonDetails?: boolean;
}

export interface FinancePoint {
  bucket: string;
  produced: number; producedNet: number; producedCount: number;
  collected: number; collectedCount: number;
  expenses: number; expensesNet: number;
  salaries: number;             // base + provisões + variável
  employerTax: number;
  partners: number;             // comissões venda + operacional
  salesCommissions: number;
  operationalCommissions: number;
  extrasCost: number;
  revenueForecast: number;
  totalCost: number;            // base LÍQUIDA (igual aos cartões)
  margin: number;               // producedNet − totalCost
}

export interface FinanceResult {
  range: { from: string; to: string };
  asOf: string;
  granularity: R.Granularity;
  params: { vatRate: number; tsuEmployerRate: number; extrasDiaRates: Record<string, number> };
  scope: { projectId: number | null; projectIds: number[] | null; cities: string[] | null };
  revenue: {
    produced: number; producedNet: number; producedCount: number;
    collected: number; collectedNet: number; collectedCount: number;
    extrasRevenue: number;
  };
  costs: {
    expenses: number; expensesNet: number;
    expensesPending: number;           // informativo (vencimento no período), NÃO soma
    salariesBase: number; salariesProvisions: number; salariesVariable: number; salaries: number;
    employerTax: number;
    extrasDia: number;
    salesCommissions: number; operationalCommissions: number;
    totalNet: number; totalGross: number;
  };
  margin: R.MarginResult;
  timeseries: FinancePoint[];
  forecast: { revenue: number; count: number; from: string; to: string; extended: boolean };
  details: {
    deliveries: Array<{ projectId: number | null; projectName: string | null; count: number; totalRevenue: number; parkingRevenue: number; deliveryCharges: number; extrasRevenue: number }>;
    collected: Array<{ projectId: number | null; projectName: string | null; count: number; totalRevenue: number }>;
    expenses: Array<{ projectId: number | null; projectName: string | null; categoryName: string | null; count: number; totalAmount: number }>;
    expensesPending: Array<{ projectId: number | null; projectName: string | null; categoryName: string | null; supplier: string | null; count: number; totalAmount: number }>;
    extrasDia: Array<{ level: string; hours: number; headcount: number; cost: number }>;
    salesCommissions: Array<{ partnerId: number; partnerName: string; projectId: number | null; projectName: string | null; bookingsCount: number; revenueGross: number; commissionRate: number | null; commission: number; status: R.CommissionStatus }>;
    operationalPartners: Array<{ partnershipId: number; partnerName: string | null; partnerType: string | null; projectNames: string[]; bookingsCount: number; revenueGross: number; commissionRate: number; commission: number }>;
    salariesByProject: Array<{ projectId: number | null; projectName: string | null; cost: number }>;
    salaryDetails: Array<{ employeeId: number; fullName: string; projectId: number | null; cost: number; base: number; provisions: number; variable: number; days: number; ratedTo: number[] }>;
    forecast: Array<{ projectId: number | null; projectName: string | null; count: number; totalRevenue: number }>;
    months: Array<{ year: number; month: number; from: string; to: string; days: number; daysInMonth: number }>;
  };
  quality: {
    partnerConflicts: Array<{ key: string; partnerIds: number[] }>;
    partnersRateMissing: string[];
    campaignsWithoutPartner: Array<{ campaign: string; revenueGross: number; bookingsCount: number }>;
    expensesWithoutProject: { count: number; total: number };
    employeesWithoutProject: number;
    inactiveWithoutContractEnd: number;
    extrasDiaTeamLeaderShifts: number;   // analítico, não somado
    payrollVariableMonths: string[];     // meses com variável do RH aplicado
    marketingExcluded: { adSpend: number; marketingExpenses: number };
    isCurrentPeriod: boolean;
  };
}

const DELIVERED_STATUSES = ["CHECKED_OUT"];
const COLLECTED_STATUSES = ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT", "CHECKED_OUT"];

const num = (v: unknown) => Number(v ?? 0) || 0;
const dayOf = (v: unknown) => String(v ?? "").slice(0, 10);

function addTo(map: Map<string, number>, key: string, v: number) {
  if (!v) return;
  map.set(key, (map.get(key) ?? 0) + v);
}

export function emptyFinanceResult(filters: FinanceFilters): FinanceResult {
  const zeroMargin = R.computeMargin({ revenueGross: 0, expensesGross: 0, salariesBase: 0, salariesProvisions: 0, salariesVariable: 0, employerTax: 0, extrasDia: 0, salesCommissions: 0, operationalCommissions: 0 });
  return {
    range: { from: filters.from, to: filters.to }, asOf: filters.today ?? "", granularity: filters.granularity ?? "day",
    params: { vatRate: R.FINANCE_PARAMS.vatRate, tsuEmployerRate: R.FINANCE_PARAMS.tsuEmployerRate, extrasDiaRates: R.FINANCE_PARAMS.extrasDiaRates },
    scope: { projectId: filters.projectId ?? null, projectIds: null, cities: null },
    revenue: { produced: 0, producedNet: 0, producedCount: 0, collected: 0, collectedNet: 0, collectedCount: 0, extrasRevenue: 0 },
    costs: { expenses: 0, expensesNet: 0, expensesPending: 0, salariesBase: 0, salariesProvisions: 0, salariesVariable: 0, salaries: 0, employerTax: 0, extrasDia: 0, salesCommissions: 0, operationalCommissions: 0, totalNet: 0, totalGross: 0 },
    margin: zeroMargin, timeseries: [],
    forecast: { revenue: 0, count: 0, from: filters.from, to: filters.to, extended: false },
    details: { deliveries: [], collected: [], expenses: [], expensesPending: [], extrasDia: [], salesCommissions: [], operationalPartners: [], salariesByProject: [], salaryDetails: [], forecast: [], months: [] },
    quality: { partnerConflicts: [], partnersRateMissing: [], campaignsWithoutPartner: [], expensesWithoutProject: { count: 0, total: 0 }, employeesWithoutProject: 0, inactiveWithoutContractEnd: 0, extrasDiaTeamLeaderShifts: 0, payrollVariableMonths: [], marketingExcluded: { adSpend: 0, marketingExpenses: 0 }, isCurrentPeriod: false },
  };
}

function lisbonToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
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
  const fromStr = `${from} 00:00:00`;
  const toStr = `${to} 23:59:59`;
  const months = R.monthsOverlapping(from, to);
  out.details.months = months;
  out.quality.isCurrentPeriod = to >= today && from <= today;

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

  // ─── 1. Entregues (por dia × centro) e por campanha (comissões de venda) ─
  const deliveryConds: any[] = [gte(multiparkBookings.checkOut, fromStr), lte(multiparkBookings.checkOut, toStr), inArray(multiparkBookings.status, DELIVERED_STATUSES)];
  if (projectIds) deliveryConds.push(inArray(multiparkBookings.projectId, projectIds));
  const dayExpr = sql<string>`DATE(${multiparkBookings.checkOut})`;
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

  // ─── 2. Recolhidos (por dia × centro) ─────────────────────────────────────
  const collectedConds: any[] = [gte(multiparkBookings.checkIn, fromStr), lte(multiparkBookings.checkIn, toStr), inArray(multiparkBookings.status, COLLECTED_STATUSES)];
  if (projectIds) collectedConds.push(inArray(multiparkBookings.projectId, projectIds));
  const dayInExpr = sql<string>`DATE(${multiparkBookings.checkIn})`;
  const collectedRows = await db
    .select({ day: dayInExpr, projectId: multiparkBookings.projectId, projectName: projects.name, count: sql<number>`COUNT(*)`, totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)` })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...collectedConds))
    .groupBy(dayInExpr, multiparkBookings.projectId, projects.name);

  // ─── 3. Despesas (data da despesa, não canceladas) — contadas UMA vez ─────
  const expConds: any[] = [sql`${expenses.status} <> 'cancelled'`, gte(expenses.expenseDate, fromStr), lte(expenses.expenseDate, toStr)];
  if (projectIds) expConds.push(inArray(expenses.projectId, projectIds));
  const expDayExpr = sql<string>`DATE(${expenses.expenseDate})`;
  const expenseRows = await db
    .select({ day: expDayExpr, projectId: expenses.projectId, projectName: projects.name, categoryName: expenseCategories.name, count: sql<number>`COUNT(*)`, totalAmount: sql<number>`COALESCE(SUM(${expenses.amount}), 0)` })
    .from(expenses)
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(and(...expConds))
    .groupBy(expDayExpr, expenses.projectId, projects.name, expenseCategories.name);

  // Pendentes com vencimento no período — INFORMAÇÃO (dívida), não custo.
  const pendConds: any[] = [inArray(expenses.status, ["pending", "overdue"]), isNotNull(expenses.paymentDueDate), gte(expenses.paymentDueDate, fromStr), lte(expenses.paymentDueDate, toStr)];
  if (projectIds) pendConds.push(inArray(expenses.projectId, projectIds));
  const pendingRows = await db
    .select({ projectId: expenses.projectId, projectName: projects.name, categoryName: expenseCategories.name, supplier: expenses.supplier, count: sql<number>`COUNT(*)`, totalAmount: sql<number>`COALESCE(SUM(${expenses.amount}), 0)` })
    .from(expenses)
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(and(...pendConds))
    .groupBy(expenses.projectId, projects.name, expenseCategories.name, expenses.supplier);

  // ─── 4. Equipa do dia: só extras, saída antecipada, cidade do centro ──────
  const extrasConds: any[] = [gte(extrasDiaAssignments.assignmentDate, from), lte(extrasDiaAssignments.assignmentDate, to)];
  if (cities) extrasConds.push(inArray(extrasDiaAssignments.city, cities));
  const extrasRows = await db
    .select({ date: extrasDiaAssignments.assignmentDate, level: extrasDiaAssignments.level, isTeamLeader: extrasDiaAssignments.isTeamLeader, startHour: extrasDiaAssignments.startHour, endHour: extrasDiaAssignments.endHour, sentHomeHour: extrasDiaAssignments.sentHomeHour })
    .from(extrasDiaAssignments)
    .where(and(...extrasConds));

  // ─── 5. Parceiros (índice com conflitos) + operacionais ───────────────────
  const partnerRows = await db.select({ id: partnerships.id, name: partnerships.name, campaignKey: partnerships.campaignKey, commissionRate: partnerships.commissionRate, partnerType: partnerships.partnerType, notes: partnerships.notes, updatedAt: partnerships.updatedAt }).from(partnerships);
  const aliasRows = await db.select({ partnershipId: partnerAliases.partnershipId, aliasValue: partnerAliases.aliasValue }).from(partnerAliases);
  const partnerIndex = R.buildPartnerIndex(
    partnerRows.map((p) => ({ id: p.id, name: p.name, campaignKey: p.campaignKey, commissionRate: p.commissionRate == null ? null : Number(p.commissionRate), updatedAt: p.updatedAt ?? "" })) as any,
    aliasRows,
  );

  // ─── 6. Pessoal: colaboradores com vínculo no período + histórico salarial ─
  const empRows = await db
    .select({ id: employees.id, fullName: employees.fullName, projectId: employees.projectId, contractType: employees.contractType, position: employees.position, monthlySalary: employees.monthlySalary, isActive: employees.isActive, contractStart: employees.contractStart, contractEnd: employees.contractEnd })
    .from(employees);
  const empIds = empRows.map((e) => e.id);
  const histRows = empIds.length ? await db
    .select({ employeeId: employeeSalaryHistory.employeeId, monthlySalary: employeeSalaryHistory.monthlySalary, effectiveFrom: employeeSalaryHistory.effectiveFrom, effectiveUntil: employeeSalaryHistory.effectiveUntil })
    .from(employeeSalaryHistory)
    .where(and(inArray(employeeSalaryHistory.employeeId, empIds), lte(employeeSalaryHistory.effectiveFrom, to), or(isNull(employeeSalaryHistory.effectiveUntil), gte(employeeSalaryHistory.effectiveUntil, from))!)) : [];
  const histByEmp = new Map<number, typeof histRows>();
  for (const h of histRows) { if (!histByEmp.has(h.employeeId)) histByEmp.set(h.employeeId, []); histByEmp.get(h.employeeId)!.push(h); }

  // ─── 7. Previsão (semântica preservada da fase 0: check-in futuro) ────────
  // ⚠️ Fase 2 muda isto para saída prevista + carros estacionados e acaba com o
  // prolongamento; por agora mantém-se igual para a paridade ser comparável.
  const nowTs = new Date();
  const forecastFromDate = nowTs > new Date(from + "T00:00:00") ? nowTs : new Date(from + "T00:00:00");
  let forecastToDate = new Date(to + "T23:59:59");
  let extended = false;
  if (forecastToDate.getTime() <= nowTs.getTime()) { forecastToDate = new Date(nowTs.getTime() + 30 * 86400000); extended = true; }
  const forecastConds: any[] = [gte(multiparkBookings.checkIn, toMysqlDateTime(forecastFromDate)), lte(multiparkBookings.checkIn, toMysqlDateTime(forecastToDate)), notInArray(multiparkBookings.status, ["CANCELLED", ...COLLECTED_STATUSES])];
  if (projectIds) forecastConds.push(inArray(multiparkBookings.projectId, projectIds));
  const forecastRows = await db
    .select({ day: dayInExpr, projectId: multiparkBookings.projectId, projectName: projects.name, count: sql<number>`COUNT(*)`, totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)` })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...forecastConds))
    .groupBy(dayInExpr, multiparkBookings.projectId, projects.name);

  // ─── 8. Marketing (EXCLUÍDO dos custos — só informação de cobertura) ──────
  const mktConds: any[] = [gte(marketingExpenses.date, fromStr), lte(marketingExpenses.date, toStr)];
  if (projectIds) mktConds.push(inArray(marketingExpenses.projectId, projectIds));
  const [mkt] = await db.select({ total: sql<number>`COALESCE(SUM(${marketingExpenses.amount}), 0)` }).from(marketingExpenses).where(and(...mktConds));
  const adsConds: any[] = [gte(campaignDailyStats.date, fromStr), lte(campaignDailyStats.date, toStr)];
  if (projectIds) adsConds.push(inArray(campaigns.projectId, projectIds));
  const [ads] = await db.select({ total: sql<number>`COALESCE(SUM(${campaignDailyStats.spend}), 0)` }).from(campaignDailyStats).innerJoin(campaigns, eq(campaigns.id, campaignDailyStats.campaignId)).where(and(...adsConds));
  out.quality.marketingExcluded = { adSpend: num(ads?.total), marketingExpenses: num(mkt?.total) };

  // ═══════════════════════════════ CÁLCULO ══════════════════════════════════
  const producedByDay = new Map<string, number>();
  const producedCountByDay = new Map<string, number>();
  const collectedByDay = new Map<string, number>();
  const collectedCountByDay = new Map<string, number>();
  const expensesByDay = new Map<string, number>();
  const salariesByDay = new Map<string, number>();
  const employerTaxByDay = new Map<string, number>();
  const salesByDay = new Map<string, number>();
  const opByDay = new Map<string, number>();
  const extrasByDay = new Map<string, number>();
  const forecastByDay = new Map<string, number>();

  // Receita
  const delivByProject = new Map<string, FinanceResult["details"]["deliveries"][number]>();
  const revenueByProjectDay = new Map<string, number>(); // `${projectId}|${day}` → receita (p/ operacionais)
  let extrasRevenue = 0;
  for (const r of deliveryRows) {
    const day = dayOf(r.day);
    addTo(producedByDay, day, num(r.totalRevenue));
    addTo(producedCountByDay, day, num(r.count));
    addTo(revenueByProjectDay, `${r.projectId ?? "null"}|${day}`, num(r.totalRevenue));
    extrasRevenue += num(r.extrasRevenue);
    const k = String(r.projectId ?? "null");
    const ex = delivByProject.get(k) ?? { projectId: r.projectId ?? null, projectName: r.projectName ?? null, count: 0, totalRevenue: 0, parkingRevenue: 0, deliveryCharges: 0, extrasRevenue: 0 };
    ex.count += num(r.count); ex.totalRevenue += num(r.totalRevenue); ex.parkingRevenue += num(r.parkingRevenue); ex.deliveryCharges += num(r.deliveryCharges); ex.extrasRevenue += num(r.extrasRevenue);
    delivByProject.set(k, ex);
  }
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

  // Despesas
  const expByProjCat = new Map<string, FinanceResult["details"]["expenses"][number]>();
  let expensesWithoutProject = { count: 0, total: 0 };
  for (const r of expenseRows) {
    addTo(expensesByDay, dayOf(r.day), num(r.totalAmount));
    if (r.projectId == null) { expensesWithoutProject.count += num(r.count); expensesWithoutProject.total += num(r.totalAmount); }
    const k = `${r.projectId ?? "null"}|${r.categoryName ?? ""}`;
    const ex = expByProjCat.get(k) ?? { projectId: r.projectId ?? null, projectName: r.projectName ?? (r.projectId == null ? "Por atribuir" : null), categoryName: r.categoryName ?? null, count: 0, totalAmount: 0 };
    ex.count += num(r.count); ex.totalAmount += num(r.totalAmount);
    expByProjCat.set(k, ex);
  }
  out.quality.expensesWithoutProject = expensesWithoutProject;
  const expensesPending = pendingRows.reduce((s, r) => s + num(r.totalAmount), 0);

  // Equipa do dia
  const extrasByLevel = new Map<string, { level: string; hours: number; headcount: number; cost: number }>();
  let tlShifts = 0;
  for (const r of extrasRows) {
    if (r.isTeamLeader) { tlShifts++; continue; }  // salário mensal já paga o team leader
    const hours = R.shiftHours(r.startHour, r.endHour, r.sentHomeHour);
    const cost = hours * R.extrasDiaRate(r.level);
    addTo(extrasByDay, r.date, cost);
    const lv = String(r.level ?? "junior");
    const ex = extrasByLevel.get(lv) ?? { level: lv, hours: 0, headcount: 0, cost: 0 };
    ex.hours += hours; ex.headcount += 1; ex.cost += cost;
    extrasByLevel.set(lv, ex);
  }
  out.quality.extrasDiaTeamLeaderShifts = tlShifts;

  // Comissões de venda (campanha → parceiro)
  const salesAgg = new Map<string, FinanceResult["details"]["salesCommissions"][number]>();
  const noPartner = new Map<string, { campaign: string; revenueGross: number; bookingsCount: number }>();
  const rateMissing = new Set<string>();
  for (const r of campaignRows) {
    const key = (r.campaign ?? "").trim().toLowerCase();
    const partner = partnerIndex.byKey.get(key);
    const rev = num(r.totalRevenue);
    const { commission, status } = R.commissionFor(rev, partner);
    if (!partner) {
      const ex = noPartner.get(key) ?? { campaign: r.campaign ?? "", revenueGross: 0, bookingsCount: 0 };
      ex.revenueGross += rev; ex.bookingsCount += num(r.count);
      noPartner.set(key, ex);
      continue;
    }
    if (status === "rate_missing") rateMissing.add(partner.name);
    addTo(salesByDay, dayOf(r.day), commission);
    const k = `${partner.id}|${r.projectId ?? "null"}`;
    const ex = salesAgg.get(k) ?? { partnerId: partner.id, partnerName: partner.name, projectId: r.projectId ?? null, projectName: r.projectName ?? null, bookingsCount: 0, revenueGross: 0, commissionRate: partner.commissionRate, commission: 0, status };
    ex.bookingsCount += num(r.count); ex.revenueGross += rev; ex.commission += commission;
    salesAgg.set(k, ex);
  }
  out.quality.partnerConflicts = partnerIndex.conflicts;
  out.quality.partnersRateMissing = Array.from(rateMissing);
  out.quality.campaignsWithoutPartner = Array.from(noPartner.values()).sort((a, b) => b.revenueGross - a.revenueGross).slice(0, 50);
  const salesCommissions = Array.from(salesAgg.values()).sort((a, b) => b.commission - a.commission);

  // Parceiros operacionais (comissão sobre a receita dos centros operados)
  const operationalPartners: FinanceResult["details"]["operationalPartners"] = [];
  for (const p of partnerRows) {
    if ((p.partnerType ?? "outro") !== "operacional") continue;
    const cfg = parsePartnerConfig(p.notes ?? null);
    const roots = cfg.operatesProjects ?? [];
    if (roots.length === 0) continue;
    const leaves = new Set<number>();
    for (const root of roots) for (const pid of await resolveProjectIds(root)) if (!projectSet || projectSet.has(pid)) leaves.add(pid);
    if (leaves.size === 0) continue;
    const rate = num(p.commissionRate);
    let revenue = 0, bookingsCount = 0;
    const names = new Set<string>();
    for (const r of deliveryRows) {
      if (r.projectId != null && leaves.has(r.projectId)) {
        const rev = num(r.totalRevenue);
        revenue += rev; bookingsCount += num(r.count);
        if (r.projectName) names.add(r.projectName);
        addTo(opByDay, dayOf(r.day), rev * (rate / 100));
      }
    }
    operationalPartners.push({ partnershipId: p.id, partnerName: p.name, partnerType: p.partnerType, projectNames: Array.from(names), bookingsCount, revenueGross: revenue, commissionRate: rate, commission: revenue * (rate / 100) });
  }
  operationalPartners.sort((a, b) => b.commission - a.commission);

  // Pessoal — base + provisões por dia de calendário, histórico por mês
  const salaryByProject = new Map<number, number>();
  const salaryDetails: FinanceResult["details"]["salaryDetails"] = [];
  let salariesBase = 0, salariesProvisions = 0, employerTax = 0;
  let employeesWithoutProject = 0, inactiveWithoutContractEnd = 0;
  let salariesUnallocated = 0;
  const empShare = new Map<number, { share: number; targets: number[] }>();
  for (const e of empRows) {
    if (R.isExtraEmployee(e)) continue;
    const contractStart = e.contractStart ? dayOf(e.contractStart) : null;
    let contractEnd = e.contractEnd ? dayOf(e.contractEnd) : null;
    if (!e.isActive && !contractEnd) { inactiveWithoutContractEnd++; continue; }
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
    const base = sal.base * effShare, prov = sal.provisions * effShare;
    salariesBase += base; salariesProvisions += prov;
    const tax = R.employerTaxFor(base);
    employerTax += tax;
    for (const d of sal.perDay) {
      addTo(salariesByDay, d.day, (d.base + d.provisions) * effShare);
      addTo(employerTaxByDay, d.day, R.employerTaxFor(d.base * effShare));
    }
    if (matching.length === 0) salariesUnallocated += base + prov;
    else for (const t of matching) addTo(salaryByProject as any, t as any, (base + prov) / matching.length);
    salaryDetails.push({ employeeId: e.id, fullName: e.fullName, projectId: e.projectId ?? null, cost: base + prov, base, provisions: prov, variable: 0, days: sal.days, ratedTo: matching });
  }
  out.quality.employeesWithoutProject = employeesWithoutProject;
  out.quality.inactiveWithoutContractEnd = inactiveWithoutContractEnd;

  // Pessoal — variável do RH (horas extra / noturnas / FDS / alimentação) por mês
  // com ponto registado. Só meses já iniciados. Extras NÃO entram (a escala é a
  // fonte do custo dos extras — evita a dupla contagem escala + ponto).
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
      if (sh.targets.length) for (const t of sh.targets) addTo(salaryByProject as any, t as any, variable / sh.targets.length);
      else salariesUnallocated += variable;
    }
    if (monthVariable) {
      payrollMonths.push(`${mo.year}-${String(mo.month).padStart(2, "0")}`);
      salariesVariable += monthVariable;
      const tax = R.employerTaxFor(monthTaxable);
      employerTax += tax;
      const perDayV = monthVariable / mo.days, perDayT = tax / mo.days;
      for (let d = mo.from; d <= mo.to; d = R.addDays(d, 1)) { addTo(salariesByDay, d, perDayV); addTo(employerTaxByDay, d, perDayT); }
    }
  }
  out.quality.payrollVariableMonths = payrollMonths;

  // Previsão
  const forecastByProject = new Map<string, FinanceResult["details"]["forecast"][number]>();
  for (const r of forecastRows) {
    addTo(forecastByDay, dayOf(r.day), num(r.totalRevenue));
    const k = String(r.projectId ?? "null");
    const ex = forecastByProject.get(k) ?? { projectId: r.projectId ?? null, projectName: r.projectName ?? null, count: 0, totalRevenue: 0 };
    ex.count += num(r.count); ex.totalRevenue += num(r.totalRevenue);
    forecastByProject.set(k, ex);
  }

  // ─── Totais (somas dos mapas diários) ─────────────────────────────────────
  const sum = (m: Map<string, number>) => { let s = 0; for (const v of m.values()) s += v; return s; };
  const produced = sum(producedByDay), collected = sum(collectedByDay), expensesGross = sum(expensesByDay);
  const extrasDia = sum(extrasByDay);
  const salesCommissionsTotal = salesCommissions.reduce((s, r) => s + r.commission, 0);
  const operationalTotal = operationalPartners.reduce((s, r) => s + r.commission, 0);
  const margin = R.computeMargin({ revenueGross: produced, expensesGross, salariesBase, salariesProvisions, salariesVariable, employerTax, extrasDia, salesCommissions: salesCommissionsTotal, operationalCommissions: operationalTotal });

  out.revenue = {
    produced, producedNet: margin.revenueNet, producedCount: sum(producedCountByDay),
    collected, collectedNet: R.netOfVat(collected), collectedCount: sum(collectedCountByDay), extrasRevenue,
  };
  out.costs = {
    expenses: expensesGross, expensesNet: margin.expensesNet, expensesPending,
    salariesBase, salariesProvisions, salariesVariable, salaries: margin.salaries, employerTax,
    extrasDia, salesCommissions: salesCommissionsTotal, operationalCommissions: operationalTotal,
    totalNet: margin.totalCostsNet, totalGross: margin.totalCostsGross,
  };
  out.margin = margin;
  out.forecast = { revenue: sum(forecastByDay), count: forecastRows.reduce((s, r) => s + num(r.count), 0), from: forecastFromDate.toISOString().slice(0, 10), to: forecastToDate.toISOString().slice(0, 10), extended };

  // ─── Série temporal: TODOS os mapas diários → buckets (mesma função) ──────
  const buckets = new Map<string, FinancePoint>();
  const point = (day: string) => {
    const bk = R.bucketKey(day, gran);
    let p = buckets.get(bk);
    if (!p) { p = { bucket: bk, produced: 0, producedNet: 0, producedCount: 0, collected: 0, collectedCount: 0, expenses: 0, expensesNet: 0, salaries: 0, employerTax: 0, partners: 0, salesCommissions: 0, operationalCommissions: 0, extrasCost: 0, revenueForecast: 0, totalCost: 0, margin: 0 }; buckets.set(bk, p); }
    return p;
  };
  const fold = (m: Map<string, number>, key: keyof FinancePoint) => { for (const [day, v] of m) { if (day >= from && day <= to || key === "revenueForecast") (point(day)[key] as number) += v; } };
  fold(producedByDay, "produced"); fold(producedCountByDay, "producedCount");
  fold(collectedByDay, "collected"); fold(collectedCountByDay, "collectedCount");
  fold(expensesByDay, "expenses"); fold(salariesByDay, "salaries"); fold(employerTaxByDay, "employerTax");
  fold(salesByDay, "salesCommissions"); fold(opByDay, "operationalCommissions");
  fold(extrasByDay, "extrasCost"); fold(forecastByDay, "revenueForecast");
  for (const p of buckets.values()) {
    p.partners = p.salesCommissions + p.operationalCommissions;
    p.producedNet = R.netOfVat(p.produced);
    p.expensesNet = R.netOfVat(p.expenses);
    p.totalCost = p.expensesNet + p.salaries + p.employerTax + p.partners + p.extrasCost;
    p.margin = p.producedNet - p.totalCost;
  }
  out.timeseries = Array.from(buckets.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));

  // ─── Detalhes ─────────────────────────────────────────────────────────────
  const salariesByProjectRows = Array.from(salaryByProject.entries())
    .map(([pid, cost]) => ({ projectId: pid as unknown as number, projectName: projById.get(pid as unknown as number)?.name ?? null, cost }))
    .sort((a, b) => b.cost - a.cost);
  if (salariesUnallocated > 0) salariesByProjectRows.push({ projectId: null as any, projectName: "Por atribuir", cost: salariesUnallocated });
  out.details = {
    deliveries: Array.from(delivByProject.values()).sort((a, b) => b.totalRevenue - a.totalRevenue),
    collected: Array.from(collByProject.values()).sort((a, b) => b.totalRevenue - a.totalRevenue),
    expenses: Array.from(expByProjCat.values()).sort((a, b) => b.totalAmount - a.totalAmount),
    expensesPending: pendingRows.map((r) => ({ projectId: r.projectId ?? null, projectName: r.projectName ?? (r.projectId == null ? "Por atribuir" : null), categoryName: r.categoryName ?? null, supplier: r.supplier ?? null, count: num(r.count), totalAmount: num(r.totalAmount) })),
    extrasDia: Array.from(extrasByLevel.values()),
    salesCommissions,
    operationalPartners,
    salariesByProject: salariesByProjectRows,
    salaryDetails: filters.includePersonDetails ? salaryDetails : [],
    forecast: Array.from(forecastByProject.values()).sort((a, b) => b.totalRevenue - a.totalRevenue),
    months,
  };
  return out;
}

/** Linhas mensais (Anual) a partir do motor: um período por mês, mesma fórmula. */
export function monthlyRowsFromTimeseries(result: FinanceResult) {
  const byMonth = new Map(result.timeseries.map((p) => [p.bucket, p]));
  return result.details.months.map((mo) => {
    const key = `${mo.year}-${String(mo.month).padStart(2, "0")}`;
    const p = byMonth.get(key);
    const produced = p?.produced ?? 0, expensesGross = p?.expenses ?? 0;
    const revenueNet = R.netOfVat(produced), expensesNet = R.netOfVat(expensesGross);
    const salaries = p?.salaries ?? 0, employerTax = p?.employerTax ?? 0, partners = p?.partners ?? 0, extras = p?.extrasCost ?? 0;
    const totalCosts = expensesNet + salaries + employerTax + partners + extras;
    return {
      year: mo.year, month: mo.month,
      revenueGrossWithVat: produced, revenueWithVat: produced, revenueNoVat: revenueNet, vatRevenue: produced - revenueNet,
      commissions: partners, salesCommissions: p?.salesCommissions ?? 0, operationalCommissions: p?.operationalCommissions ?? 0,
      expensesWithVat: expensesGross, expensesNoVat: expensesNet, vatExpenses: expensesGross - expensesNet,
      vatToPay: (produced - revenueNet) - (expensesGross - expensesNet),
      extrasDiaCost: extras, salaries, employerTax, totalCosts, profit: revenueNet - totalCosts,
      producedCount: p?.producedCount ?? 0,
    };
  });
}
