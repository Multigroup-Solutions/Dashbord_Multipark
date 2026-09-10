/**
 * CÁLCULO MENSAL de um colaborador — puro e parametrizado. O motor de dados
 * (server/db.ts getPayrollData) só recolhe e chama isto.
 *
 * Regras (auditoria RH, set 2026):
 *  - vínculo: sem contrato no mês → 0; contrato parcial → base proporcional
 *    aos dias de calendário do mês (fev = mês completo);
 *  - ausências por TIPO: `unpaid` reduz base e provisões (dias/dias do mês);
 *    férias/baixa não reduzem base (regime simplificado, assinalado);
 *  - horas: só turnos FECHADOS e não suspeitos; suspeitos e abertos ficam à
 *    parte para revisão (não pagam, não contam dia nem alimentação);
 *  - noturnas/FDS por intervalo real (shifts.ts), não pela hora do check-out;
 *  - horas extra: horas NORMAIS acima do horário esperado do mês (horário
 *    individual quando existe; senão 176 h);
 *  - extras: taxa por nível; nível sem taxa → aviso (não cai em silêncio para
 *    a mais baixa);
 *  - IRS/TSU do trabalhador: ESTIMATIVA rotulada (não é apuramento fiscal).
 */
import { countableShifts, type Shift } from "./shifts";

export const PAYROLL_PARAMS = {
  standardMonthlyHours: 176,
  overtimeFirstHour: 1.25,
  overtimeSubsequent: 1.375,
  nightMultiplier: 1.25,
  weekendMultiplier: 1.5,
  provisionThirteenth: 1 / 12,
  provisionFourteenth: 1 / 12,
  tsuEmployee: 0.11,
  irsEstimate: 0.15,     // ESTIMATIVA simplificada
} as const;

export interface LeaveLike { leaveType: "vacation" | "sick" | "unpaid" | "other"; fromDate: string; toDate: string }
export interface ScheduleLike { weekday: number; startTime: string; endTime: string; isWorkDay: number | boolean }

export interface EmployeeMonthInput {
  employee: {
    id: number; fullName: string; position: string | null; extraLevel: number | null;
    contractStart?: string | null; contractEnd?: string | null; isActive: number | boolean;
    monthlySalary?: string | number | null; mealAllowancePerDay?: string | number | null;
  };
  year: number; month: number;
  /** salário/alimentação vigentes no mês (histórico); ausente → valores da ficha */
  snapshot?: { monthlySalary: string | number | null; mealAllowancePerDay: string | number | null } | null;
  shifts: Shift[];
  leaves: LeaveLike[];
  schedules?: ScheduleLike[];
  /** taxas dos extras: por nível numérico e por nome */
  extraRateByLevel: Map<number, number>;
  extraRateByName: Map<string, number>;
}

export interface EmployeeMonthResult {
  employeeId: number; fullName: string; position: string | null; extraLevel: number | null; isExtra: boolean;
  /** vínculo no mês */
  contractDays: number; daysInMonth: number; inContract: boolean;
  unpaidDays: number; leaveDays: number;
  // horas aprovadas
  totalHours: number; daysWorked: number; normalHours: number; nightHours: number; weekendHours: number;
  overtimeHours: number; expectedHours: number;
  // pendentes de revisão (NÃO pagas)
  suspiciousHours: number; suspiciousShifts: number; openShifts: number;
  // componentes
  baseSalary: number; extraPayment: number; overtimePayment: number; nightPayment: number; weekendPayment: number;
  thirteenthProvision: number; fourteenthProvision: number; mealAllowance: number; mealAllowancePerDay: number;
  totalPayment: number;
  hourlyRate: number;
  // estimativa (não fiscal)
  tsuEmployee: number; irsEstimate: number; netEstimate: number;
  warnings: string[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const NAME_BY_LEVEL: Record<number, string> = { 1: "junior", 2: "senior", 3: "terminal", 4: "master" };

function daysInMonth(y: number, m: number) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function pad(n: number) { return String(n).padStart(2, "0"); }
function addDay(day: string): string { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }

/** Dias de calendário do mês em que o vínculo está ativo. */
export function contractDaysInMonth(e: EmployeeMonthInput["employee"], year: number, month: number): { days: number; from: string; to: string } {
  const dim = daysInMonth(year, month);
  const mFrom = `${year}-${pad(month)}-01`, mTo = `${year}-${pad(month)}-${pad(dim)}`;
  let from = mFrom, to = mTo;
  const cs = e.contractStart ? String(e.contractStart).slice(0, 10) : null;
  const ce = e.contractEnd ? String(e.contractEnd).slice(0, 10) : null;
  if (cs && cs > from) from = cs;
  if (ce && ce < to) to = ce;
  if (from > to) return { days: 0, from, to };
  const d = Math.floor((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86400000) + 1;
  return { days: d, from, to };
}

/** Horas esperadas do mês a partir do horário semanal (dias de calendário do vínculo). */
export function expectedHoursFromSchedule(schedules: ScheduleLike[] | undefined, from: string, to: string): number | null {
  if (!schedules || schedules.length === 0) return null;
  const byWeekday = new Map<number, number>();
  for (const s of schedules) {
    if (!s.isWorkDay) continue;
    const [sh, sm] = s.startTime.split(":").map(Number), [eh, em] = s.endTime.split(":").map(Number);
    let h = (eh + em / 60) - (sh + sm / 60);
    if (h < 0) h += 24; // turno que atravessa a meia-noite
    byWeekday.set(s.weekday, h);
  }
  let total = 0;
  for (let d = from; d <= to; d = addDay(d)) {
    const wd = new Date(d + "T00:00:00Z").getUTCDay();
    total += byWeekday.get(wd) ?? 0;
  }
  return Math.round(total * 100) / 100;
}

export function computeEmployeeMonth(inp: EmployeeMonthInput): EmployeeMonthResult {
  const P = PAYROLL_PARAMS;
  const e = inp.employee;
  const warnings: string[] = [];
  const dim = daysInMonth(inp.year, inp.month);
  const { days: contractDays, from: cFrom, to: cTo } = contractDaysInMonth(e, inp.year, inp.month);
  const inContract = contractDays > 0;
  const isExtra = e.position === "extra";

  // ausências por tipo (só dias dentro do vínculo e do mês)
  const leaveDaysSet = new Set<string>(), unpaidSet = new Set<string>();
  for (const l of inp.leaves) {
    const f = l.fromDate < cFrom ? cFrom : l.fromDate, t = l.toDate > cTo ? cTo : l.toDate;
    for (let d = f; d <= t; d = addDay(d)) { leaveDaysSet.add(d); if (l.leaveType === "unpaid") unpaidSet.add(d); }
  }

  // turnos: aprovados vs pendentes
  const countable = countableShifts(inp.shifts);
  const suspicious = inp.shifts.filter((s) => s.status === "suspicious");
  const open = inp.shifts.filter((s) => s.status === "open");
  const totalHours = r2(countable.reduce((s, x) => s + x.hours, 0));
  const normalHours = r2(countable.reduce((s, x) => s + x.split.normal, 0));
  const nightHours = r2(countable.reduce((s, x) => s + x.split.night, 0));
  const weekendHours = r2(countable.reduce((s, x) => s + x.split.weekend, 0));
  const daysWorkedSet = new Set(countable.map((s) => s.day));
  const suspiciousHours = r2(suspicious.reduce((s, x) => s + x.hours, 0));
  if (suspicious.length) warnings.push(`${suspicious.length} turno(s) suspeito(s) por rever (${suspiciousHours} h não pagas)`);
  if (open.length) warnings.push(`${open.length} entrada(s) sem saída (não contam)`);

  const monthlySalary = num(inp.snapshot?.monthlySalary ?? e.monthlySalary);
  const mealPerDay = num(inp.snapshot?.mealAllowancePerDay ?? e.mealAllowancePerDay);

  let baseSalary = 0, extraPayment = 0, overtimeHours = 0, overtimePayment = 0, nightPayment = 0, weekendPayment = 0;
  let thirteenth = 0, fourteenth = 0, mealAllowance = 0, hourlyRate = 0, expectedHours = 0;

  if (!inContract) {
    warnings.push("sem vínculo neste mês (contrato fora do período)");
  } else if (isExtra) {
    const level = e.extraLevel ?? 1;
    const byLevel = inp.extraRateByLevel.get(level);
    const byName = inp.extraRateByName.get(NAME_BY_LEVEL[level] ?? "");
    if (byLevel == null && byName == null) {
      warnings.push(`nível de extra ${level} sem taxa configurada — 0 € (configurar em Taxas Extra)`);
      hourlyRate = 0;
    } else hourlyRate = byLevel ?? byName ?? 0;
    extraPayment = r2(totalHours * hourlyRate);
  } else {
    const contractShare = contractDays / dim;
    const unpaidShare = unpaidSet.size / dim;
    const paidShare = Math.max(0, contractShare - unpaidShare);
    baseSalary = r2(monthlySalary * paidShare);
    if (contractDays < dim) warnings.push(`vínculo parcial: ${contractDays}/${dim} dias`);
    if (unpaidSet.size) warnings.push(`${unpaidSet.size} dia(s) de ausência não remunerada descontado(s)`);
    hourlyRate = monthlySalary > 0 ? r2(monthlySalary / P.standardMonthlyHours) : 0;
    const hourlyBase = monthlySalary > 0 ? monthlySalary / P.standardMonthlyHours : 0;
    nightPayment = r2(nightHours * hourlyBase * (P.nightMultiplier - 1));
    weekendPayment = r2(weekendHours * hourlyBase * (P.weekendMultiplier - 1));
    const fromSchedule = expectedHoursFromSchedule(inp.schedules, cFrom, cTo);
    expectedHours = fromSchedule ?? r2(P.standardMonthlyHours * contractShare);
    if (normalHours > expectedHours) {
      overtimeHours = r2(normalHours - expectedHours);
      const firstPortion = Math.min(overtimeHours, daysWorkedSet.size);
      const rest = Math.max(0, overtimeHours - firstPortion);
      overtimePayment = r2(firstPortion * hourlyBase * P.overtimeFirstHour + rest * hourlyBase * P.overtimeSubsequent);
    }
    thirteenth = r2(monthlySalary * P.provisionThirteenth * paidShare);
    fourteenth = r2(monthlySalary * P.provisionFourteenth * paidShare);
    let mealDays = 0;
    for (const d of daysWorkedSet) if (!leaveDaysSet.has(d)) mealDays++;
    mealAllowance = r2(mealPerDay * mealDays);
  }

  const totalPayment = r2(isExtra ? extraPayment : baseSalary + overtimePayment + nightPayment + weekendPayment + thirteenth + fourteenth + mealAllowance);
  const taxableBase = isExtra ? extraPayment : baseSalary + overtimePayment + nightPayment + weekendPayment;
  const tsuEmployee = r2(taxableBase * P.tsuEmployee);
  const irsEstimate = r2(taxableBase * P.irsEstimate);
  const netEstimate = r2(totalPayment - tsuEmployee - irsEstimate);

  return {
    employeeId: e.id, fullName: e.fullName, position: e.position, extraLevel: e.extraLevel, isExtra,
    contractDays, daysInMonth: dim, inContract, unpaidDays: unpaidSet.size, leaveDays: leaveDaysSet.size,
    totalHours, daysWorked: daysWorkedSet.size, normalHours, nightHours, weekendHours, overtimeHours, expectedHours,
    suspiciousHours, suspiciousShifts: suspicious.length, openShifts: open.length,
    baseSalary, extraPayment, overtimePayment, nightPayment, weekendPayment, thirteenthProvision: thirteenth, fourteenthProvision: fourteenth,
    mealAllowance, mealAllowancePerDay: mealPerDay, totalPayment, hourlyRate,
    tsuEmployee, irsEstimate, netEstimate, warnings,
  };
}
