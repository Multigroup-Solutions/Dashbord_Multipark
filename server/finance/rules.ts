/**
 * REGRAS FINANCEIRAS — puras, sem base de dados. Uma regra, um sítio.
 *
 * A Faturação (getBillingData) e o Anual (getAnnualBreakdown) tinham cada um a
 * sua cópia de tudo isto, com diferenças silenciosas: receita por status
 * diferente, comissões ora custo ora dedução à receita, marketing somado duas
 * vezes num lado, fevereiro a 28/30 do salário no outro, extras excluídos por
 * campos diferentes… Este módulo é a única fonte das fórmulas; o motor
 * (engine.ts) só vai buscar dados e chama isto.
 */

// ─── Parâmetros (um só sítio; antes: literais 0.23/1.23/0.2375 espalhados) ───
export interface FinanceParams {
  /** IVA das reservas e das despesas (valores gravados COM IVA). */
  vatRate: number;
  /** TSU a cargo da entidade patronal. */
  tsuEmployerRate: number;
  /** €/hora da equipa do dia por nível (sincronizado com server/extrasDia.ts). */
  extrasDiaRates: Record<string, number>;
  extrasDiaDefaultRate: number;
  /** Meses de provisão (13.º Natal + 14.º férias) por ano: 2/12 do base por mês. */
  provisionMonthsPerYear: number;
}
export const FINANCE_PARAMS: Readonly<FinanceParams> = Object.freeze({
  vatRate: 0.23,
  tsuEmployerRate: 0.2375,
  extrasDiaRates: { junior: 4.5, senior: 5, terminal: 5.5, master: 6 },
  extrasDiaDefaultRate: 4,
  provisionMonthsPerYear: 2,
});

export type Granularity = "day" | "week" | "month" | "year";

// ─── Dinheiro ─────────────────────────────────────────────────────────────────
/** Arredonda a cêntimos (só para APRESENTAR; os cálculos correm em número). */
export const cents = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export function netOfVat(gross: number, vatRate = FINANCE_PARAMS.vatRate): number {
  return gross / (1 + vatRate);
}
export function vatPortion(gross: number, vatRate = FINANCE_PARAMS.vatRate): number {
  return gross - netOfVat(gross, vatRate);
}

// ─── Calendário (dias de calendário, sem fusos) ──────────────────────────────
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export function assertIsoDay(s: string, label = "data"): string {
  if (!ISO_DAY.test(s)) throw new Error(`${label} inválida: ${s}`);
  return s;
}
export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}
export function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Nº de dias inclusivos entre dois dias ("2026-02-01","2026-02-28" → 28). */
export function daysBetweenInclusive(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.floor((b - a) / 86400000) + 1;
}
export function maxDay(a: string, b: string): string { return a > b ? a : b; }
export function minDay(a: string, b: string): string { return a < b ? a : b; }

/** Meses (YYYY-MM) que intersetam o intervalo, com o sub-intervalo em cada um. */
export function monthsOverlapping(from: string, to: string): Array<{ year: number; month: number; from: string; to: string; days: number; daysInMonth: number }> {
  const out: Array<{ year: number; month: number; from: string; to: string; days: number; daysInMonth: number }> = [];
  let y = +from.slice(0, 4), m = +from.slice(5, 7);
  const endY = +to.slice(0, 4), endM = +to.slice(5, 7);
  while (y < endY || (y === endY && m <= endM)) {
    const dim = daysInMonth(y, m);
    const mFrom = `${y}-${String(m).padStart(2, "0")}-01`;
    const mTo = `${y}-${String(m).padStart(2, "0")}-${String(dim).padStart(2, "0")}`;
    const f = maxDay(mFrom, from), t = minDay(mTo, to);
    if (f <= t) out.push({ year: y, month: m, from: f, to: t, days: daysBetweenInclusive(f, t), daysInMonth: dim });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** ISO week "YYYY-Www" (igual ao DATE_FORMAT('%x-W%v') do MySQL). */
export function isoWeekKey(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Chave do bucket do gráfico para um dia. TODAS as séries usam esta função. */
export function bucketKey(day: string, gran: Granularity): string {
  switch (gran) {
    case "day": return day;
    case "week": return isoWeekKey(day);
    case "month": return day.slice(0, 7);
    case "year": return day.slice(0, 4);
  }
}

// ─── Pessoal ──────────────────────────────────────────────────────────────────
export interface SalaryPeriodInput {
  monthlySalary: number;
  from: string;             // início do intervalo pedido
  to: string;               // fim do intervalo pedido
  contractStart?: string | null;
  contractEnd?: string | null;
  /** salário vigente por mês ("YYYY-MM" → valor); sem entrada usa monthlySalary */
  salaryByMonth?: Record<string, number>;
}
export interface SalaryPeriodResult {
  base: number;             // salário base proporcional aos dias efetivos
  provisions: number;       // 13.º + 14.º (2/12 do base) proporcionais
  days: number;             // dias efetivos contados
  /** custo por dia de calendário (para o gráfico) */
  perDay: Array<{ day: string; base: number; provisions: number }>;
}

/**
 * Salário de um intervalo: MÊS COMPLETO = salário mensal (fevereiro já não é
 * 28/30); parcial = salário × dias efetivos / dias do mês. Respeita início e
 * fim de contrato (quem saiu a meio do mês conta até ao dia em que saiu; quem
 * está inativo mas tinha vínculo no período conta).
 */
export function salaryForPeriod(inp: SalaryPeriodInput): SalaryPeriodResult {
  const out: SalaryPeriodResult = { base: 0, provisions: 0, days: 0, perDay: [] };
  let from = inp.from, to = inp.to;
  if (inp.contractStart) from = maxDay(from, inp.contractStart.slice(0, 10));
  if (inp.contractEnd) to = minDay(to, inp.contractEnd.slice(0, 10));
  if (from > to) return out;
  const provRate = FINANCE_PARAMS.provisionMonthsPerYear / 12;
  for (const mo of monthsOverlapping(from, to)) {
    const key = `${mo.year}-${String(mo.month).padStart(2, "0")}`;
    const monthly = inp.salaryByMonth?.[key] ?? inp.monthlySalary;
    if (!(monthly > 0)) continue;
    const perDayBase = monthly / mo.daysInMonth;
    const perDayProv = perDayBase * provRate;
    for (let d = mo.from; d <= mo.to; d = addDays(d, 1)) {
      out.perDay.push({ day: d, base: perDayBase, provisions: perDayProv });
    }
    out.base += perDayBase * mo.days;
    out.provisions += perDayProv * mo.days;
    out.days += mo.days;
  }
  return out;
}

/** Regra ÚNICA para "é extra" (Faturação usava contractType, Anual usava position). */
export function isExtraEmployee(e: { contractType?: string | null; position?: string | null }): boolean {
  return e.contractType === "extra" || e.position === "extra";
}

/** Distribuição equitativa pelas folhas da árvore (quem está num nível superior). */
export function shareTargets(targets: number[], filter?: Set<number>): { matching: number[]; share: number } {
  if (targets.length === 0) return { matching: [], share: 0 };
  const matching = filter ? targets.filter((t) => filter.has(t)) : targets;
  return { matching, share: matching.length / targets.length };
}

// ─── Equipa do dia ────────────────────────────────────────────────────────────
/** Horas de um turno: saída antecipada (sentHomeHour) prevalece sobre endHour. */
export function shiftHours(startHour: number, endHour: number, sentHomeHour?: number | null): number {
  const end = sentHomeHour != null ? sentHomeHour : endHour;
  return Math.max(end - startHour, 0);
}
export function extrasDiaRate(level: string | null | undefined): number {
  return FINANCE_PARAMS.extrasDiaRates[String(level ?? "junior")] ?? FINANCE_PARAMS.extrasDiaDefaultRate;
}

/** Cidade das escalas (lisbon|porto|faro) a partir da chave partilhada (lisboa|porto|faro). */
export function extrasCityFromKey(key: string | null): string | null {
  if (!key) return null;
  return key === "lisboa" ? "lisbon" : key;
}

// ─── Parceiros / comissões ───────────────────────────────────────────────────
export interface PartnerLite { id: number; name: string; commissionRate: number | null; updatedAt: string }
export interface PartnerIndex {
  byKey: Map<string, PartnerLite>;
  /** chaves com mais do que um parceiro (o mais recente ganha, mas fica ASSINALADO) */
  conflicts: Array<{ key: string; partnerIds: number[] }>;
}
/** Índice campanha/alias → parceiro. Conflitos deixam de ser silenciosos. */
export function buildPartnerIndex(
  partners: PartnerLite[],
  aliases: Array<{ partnershipId: number; aliasValue: string }>,
): PartnerIndex {
  const byId = new Map(partners.map((p) => [p.id, p]));
  const candidates = new Map<string, Set<number>>();
  const register = (raw: string | null | undefined, id: number) => {
    const key = (raw ?? "").trim().toLowerCase();
    if (!key || !byId.has(id)) return;
    if (!candidates.has(key)) candidates.set(key, new Set());
    candidates.get(key)!.add(id);
  };
  for (const p of partners) { register(p.name, p.id); }
  for (const p of partners) { register((p as any).campaignKey, p.id); }
  for (const a of aliases) register(a.aliasValue, a.partnershipId);
  const byKey = new Map<string, PartnerLite>();
  const conflicts: PartnerIndex["conflicts"] = [];
  for (const [key, ids] of candidates) {
    const list = Array.from(ids).map((id) => byId.get(id)!);
    list.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
    byKey.set(key, list[0]);
    if (list.length > 1) conflicts.push({ key, partnerIds: list.map((p) => p.id) });
  }
  return { byKey, conflicts };
}

export type CommissionStatus = "ok" | "rate_missing" | "rate_zero" | "no_partner";
/** Comissão de uma reserva/grupo: distingue 0% confirmado de taxa em falta. */
export function commissionFor(revenueGross: number, partner: PartnerLite | undefined): { commission: number; status: CommissionStatus } {
  if (!partner) return { commission: 0, status: "no_partner" };
  if (partner.commissionRate == null) return { commission: 0, status: "rate_missing" };
  if (partner.commissionRate === 0) return { commission: 0, status: "rate_zero" };
  return { commission: revenueGross * (partner.commissionRate / 100), status: "ok" };
}

// ─── Margem — A fórmula ───────────────────────────────────────────────────────
export interface MarginInput {
  revenueGross: number;        // entregues, COM IVA
  expensesGross: number;       // despesas não canceladas, COM IVA
  salariesBase: number;
  salariesProvisions: number;
  salariesVariable: number;    // horas extra / noturnas / FDS / alimentação (RH)
  employerTax: number;         // TSU patronal (já calculada sobre a base tributável)
  extrasDia: number;
  salesCommissions: number;
  operationalCommissions: number;
  vatRate?: number;
}
export interface MarginResult {
  revenueNet: number;
  vatOnRevenue: number;
  expensesNet: number;
  vatOnExpenses: number;
  vatToPay: number;
  salaries: number;            // base + provisões + variável
  personnel: number;           // salaries + TSU
  commissions: number;
  totalCostsNet: number;       // tudo, despesas SEM IVA
  totalCostsGross: number;     // tudo, despesas COM IVA (informativo)
  margin: number;              // revenueNet − totalCostsNet
  marginPct: number | null;
}
/**
 * receita s/IVA − despesas s/IVA − pessoal (base+provisões+variável) − TSU −
 * equipa do dia − comissões (venda + operacional). Comissões são CUSTO (nunca
 * deduzidas à receita); marketing NÃO entra (já está nas despesas).
 */
export function computeMargin(i: MarginInput): MarginResult {
  const vat = i.vatRate ?? FINANCE_PARAMS.vatRate;
  const revenueNet = netOfVat(i.revenueGross, vat);
  const expensesNet = netOfVat(i.expensesGross, vat);
  const salaries = i.salariesBase + i.salariesProvisions + i.salariesVariable;
  const personnel = salaries + i.employerTax;
  const commissions = i.salesCommissions + i.operationalCommissions;
  const totalCostsNet = expensesNet + personnel + i.extrasDia + commissions;
  const totalCostsGross = i.expensesGross + personnel + i.extrasDia + commissions;
  const margin = revenueNet - totalCostsNet;
  return {
    revenueNet, vatOnRevenue: i.revenueGross - revenueNet,
    expensesNet, vatOnExpenses: i.expensesGross - expensesNet,
    vatToPay: (i.revenueGross - revenueNet) - (i.expensesGross - expensesNet),
    salaries, personnel, commissions, totalCostsNet, totalCostsGross, margin,
    marginPct: revenueNet > 0 ? (margin / revenueNet) * 100 : null,
  };
}

/** TSU patronal sobre a base tributável (base + variável tributável; NÃO sobre provisões/alimentação). */
export function employerTaxFor(taxableBase: number, rate = FINANCE_PARAMS.tsuEmployerRate): number {
  return taxableBase * rate;
}
