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
 *  - extras, terminal (aeroporto, interruptor PONTO_TERMINAL): os troços de
 *    terminal pagam à taxa do nível SEGUINTE (shared/pontoTerminal.ts); o
 *    "partial" (saída fora do aeroporto) divide-se — terminal até à última
 *    recolha/entrega, o resto normal (terminalSplitOfShift, a mesma do custo
 *    dos extras); os "por confirmar" pagam como normais até o RH confirmar.
 *    Plano 56 B2 (terminal pelo perfil): sem estado antigo no troço, as horas
 *    de terminal são as das sessões (`terminal_sessions`, só extras —
 *    payUplift = 1) na interseção com o turno do ponto, até ao countedUntil,
 *    só as que contam (base ≠ pendente/desmarcado). Desligado → igual a antes;
 *  - IRS/TSU do trabalhador: ESTIMATIVA rotulada (não é apuramento fiscal).
 */
import { countableShifts, type Shift } from "./shifts";
import { normalizeExtraLevel, splitTerminalHours, terminalLevelOf } from "../../shared/pontoTerminal";
import type { TerminalPaySessionLike } from "../../shared/terminalWatch";
import { workRowOn } from "../../shared/workSchedule";

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

/**
 * Ausência APROVADA (plano 63, passo 11: o leitor já só traz as aprovadas).
 * `hours` = parte de um dia (ausência justificada): não tira o dia inteiro
 * (o modelo das 40 h, passo 6, tira essas horas às esperadas).
 */
export interface LeaveLike { leaveType: "vacation" | "sick" | "unpaid" | "other" | "unavailable"; fromDate: string; toDate: string; hours?: string | number | null }
/** Uma linha do horário (`schedules`); `id` decide os dias duplicados (plano 63, 10a). */
export interface ScheduleLike { id?: number | null; weekday: number; startTime: string; endTime: string; isWorkDay: number | boolean }

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
  /** interruptor PONTO_TERMINAL (omissão: desligado = como antes) */
  terminalEnabled?: boolean;
  /** Plano 56 B2: sessões do terminal pelo perfil da pessoa (só lidas com o interruptor ligado) */
  terminalSessions?: ReadonlyArray<TerminalPaySessionLike> | null;
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
  /** extras: horas de terminal (aeroporto) pagas ao nível seguinte — já incluídas em totalHours e extraPayment */
  terminalHours: number; terminalHourlyRate: number; terminalPayment: number;
  /** extras: horas de terminal por confirmar (pagas como normais até o RH confirmar) */
  terminalPendingHours: number;
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

/**
 * Horas esperadas do mês a partir do horário semanal (dias de calendário do vínculo).
 * Plano 63 (10a):
 *  - "apagar" um dia do horário passa a folga (isWorkDay = 0) em vez de apagar a
 *    linha — um horário só com folgas conta como SEM horário (null → as 176 h),
 *    como contava quando os dias apagados desapareciam (o "Pôr folga" em todos os
 *    dias dá o mesmo dinheiro que o caixote do lixo dava);
 *  - dias duplicados: conta a linha de trabalho de id mais baixo (`workRowOn`, a
 *    mesma da Avaliação, das faltas e da ficha). `pick: "legacy"` = a regra de antes
 *    (a última linha lida, por id) e "só folgas" = 0 h — só para o aviso da folha.
 */
export function expectedHoursFromSchedule(schedules: ScheduleLike[] | undefined, from: string, to: string, opts: { pick?: "first" | "legacy" } = {}): number | null {
  if (!schedules || schedules.length === 0) return null;
  const legacy = opts.pick === "legacy";
  if (!legacy && !schedules.some((s) => s.isWorkDay)) return null;
  const hoursOf = (s: ScheduleLike) => {
    const [sh, sm] = s.startTime.split(":").map(Number), [eh, em] = s.endTime.split(":").map(Number);
    let h = (eh + em / 60) - (sh + sm / 60);
    if (h < 0) h += 24; // turno que atravessa a meia-noite
    return h;
  };
  const byWeekday = new Map<number, number>();
  if (legacy) {
    const ordered = [...schedules].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    for (const s of ordered) if (s.isWorkDay) byWeekday.set(s.weekday, hoursOf(s));
  } else {
    for (let wd = 0; wd < 7; wd++) {
      const s = workRowOn(schedules, wd);
      if (s) byWeekday.set(wd, hoursOf(s));
    }
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
    // parte de um dia e a indisponibilidade dos extras não são dias de ausência
    if ((l.hours != null && l.hours !== "") || l.leaveType === "unavailable") continue;
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
  let terminalHours = 0, terminalHourlyRate = 0, terminalPayment = 0, terminalPendingHours = 0;
  let thirteenth = 0, fourteenth = 0, mealAllowance = 0, hourlyRate = 0, expectedHours = 0;

  if (!inContract) {
    warnings.push("sem vínculo neste mês (contrato fora do período)");
  } else if (isExtra) {
    const level = e.extraLevel ?? 1;
    const rateOf = (lv: number): number | undefined => inp.extraRateByLevel.get(lv) ?? inp.extraRateByName.get(NAME_BY_LEVEL[lv] ?? "");
    const own = rateOf(level);
    if (own == null) {
      warnings.push(`nível de extra ${level} sem taxa configurada — 0 € (configurar em Taxas Extra)`);
      hourlyRate = 0;
    } else hourlyRate = own;
    // Terminal (aeroporto): troços (ou a parte "partial") pagos ao nível seguinte. Desligado → tudo normal.
    const sessions = inp.terminalSessions?.length ? inp.terminalSessions : null;
    const split = splitTerminalHours(sessions ? countable.map((c) => ({ ...c, sessions })) : countable, !!inp.terminalEnabled);
    terminalHours = split.terminalHours;
    terminalPendingHours = split.pendingHours;
    if (terminalHours > 0) {
      const tLevel = terminalLevelOf(level);
      const tRate = tLevel === normalizeExtraLevel(level) ? hourlyRate : rateOf(tLevel);
      if (tRate == null) {
        // sem taxa do nível seguinte: paga à taxa dele (nunca a mais sem taxa definida)
        warnings.push(`nível de extra ${tLevel} sem taxa configurada — ${terminalHours} h de terminal pagas à taxa do nível ${level} (configurar em Taxas Extra)`);
        terminalHourlyRate = hourlyRate;
      } else terminalHourlyRate = tRate;
      terminalPayment = r2(terminalHours * terminalHourlyRate);
    }
    if (terminalPendingHours > 0) warnings.push(`${terminalPendingHours} h de terminal por confirmar (pagas como normais até o RH confirmar)`);
    extraPayment = r2(r2(totalHours - terminalHours) * hourlyRate) + terminalPayment;
    extraPayment = r2(extraPayment);
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
    const standardHours = r2(P.standardMonthlyHours * contractShare);
    const overtimeFor = (expected: number) => {
      if (!(normalHours > expected)) return { hours: 0, payment: 0 };
      const hours = r2(normalHours - expected);
      const firstPortion = Math.min(hours, daysWorkedSet.size);
      const rest = Math.max(0, hours - firstPortion);
      return { hours, payment: r2(firstPortion * hourlyBase * P.overtimeFirstHour + rest * hourlyBase * P.overtimeSubsequent) };
    };
    const fromSchedule = expectedHoursFromSchedule(inp.schedules, cFrom, cTo);
    expectedHours = fromSchedule ?? standardHours;
    ({ hours: overtimeHours, payment: overtimePayment } = overtimeFor(expectedHours));
    // Plano 63 (10a): onde a regra nova do horário (só folgas = sem horário; dias duplicados =
    // a linha mais antiga, como a Avaliação e as faltas) dá outro valor que a de antes, a linha
    // diz os dois — nenhum ordenado muda sem quem fecha o mês ver.
    if (inp.schedules?.length) {
      // uma hora gravada que não se lê (ex.: "9h"): como antes, não há horas extra — mas diz-se
      if (Number.isNaN(expectedHours)) warnings.push("horário da ficha com horas que não se leem (ex.: \"9h\"): as horas esperadas não se calculam e as horas extra ficam a 0 — corrige em RH → ficha → Horário (HH:MM)");
      const legacyExpected = expectedHoursFromSchedule(inp.schedules, cFrom, cTo, { pick: "legacy" }) ?? standardHours;
      const legacy = overtimeFor(legacyExpected);
      const sameHours = legacyExpected === expectedHours || (Number.isNaN(legacyExpected) && Number.isNaN(expectedHours));
      if (legacy.payment !== overtimePayment || !sameHours) {
        const fmt = (v: number) => v.toFixed(2).replace(".", ",");
        const hrs = (h: number) => (Number.isNaN(h) ? "horas que não se leem" : `${h} h esperadas`);
        const why = fromSchedule == null
          ? "horário só com folgas: conta como sem horário"
          : "horário com dias duplicados e horas diferentes: conta a linha mais antiga de cada dia (a da ficha, da Avaliação e das faltas)";
        warnings.push(`${why} — ${hrs(expectedHours)}, ${fmt(overtimePayment)} € de horas extra. Pela regra antiga eram ${hrs(legacyExpected)} e ${fmt(legacy.payment)} € — confirma o horário na ficha antes de fechar o mês`);
      }
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
    baseSalary, extraPayment, overtimePayment, nightPayment, weekendPayment,
    terminalHours, terminalHourlyRate, terminalPayment, terminalPendingHours,
    thirteenthProvision: thirteenth, fourteenthProvision: fourteenth,
    mealAllowance, mealAllowancePerDay: mealPerDay, totalPayment, hourlyRate,
    tsuEmployee, irsEstimate, netEstimate, warnings,
  };
}
