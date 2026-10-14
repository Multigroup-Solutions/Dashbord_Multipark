/**
 * Horário fixo do RH (tabela `schedules`: dia da semana, entrada, saída, dia
 * de trabalho) → a hora de entrada de cada dia. Tarefa 62 (Q8, Jorge, 14 out
 * 2026): "o atraso conta para todos os que têm horário" — quem tem horário
 * fixo "ainda tem mais de chegar a horas". PURO.
 *
 * Quem está na escala do Extras-Dia num dia usa a hora da ESCALA (mais
 * específica); o horário fixo vale nos outros dias. Sem horário nesse dia da
 * semana, dia livre (isWorkDay = 0), de férias/baixa (`employee_leaves`) ou
 * fora do contrato: não há hora de entrada (nem atraso nem falta).
 */
import { addDays, lisbonWallTimeUtcMs, operationalDayOf } from "./lisbonDay";

export interface FixedScheduleRow {
  employeeId: number;
  /** 0 = domingo … 6 = sábado (como no RH e no processamento salarial) */
  weekday: number;
  /** "HH:MM" ou "HH:MM:SS" (Lisboa) */
  startTime: string;
  endTime?: string | null;
  isWorkDay?: boolean | number | null;
  contractStart?: string | null;
  contractEnd?: string | null;
}

export interface LeaveRow { employeeId: number; fromDate: string; toDate: string }

export interface FixedStart {
  employeeId: number;
  /** dia de CALENDÁRIO (Lisboa) do horário */
  calendarDay: string;
  /** dia operacional (03h→03h) em que a entrada cai */
  day: string;
  startMs: number;
  endMs: number | null;
}

/** "08:30" → 8,5 (horas). Inválido → null. PURA. */
export function hoursOfHhmm(s: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h + min / 60;
}

const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
const within = (day: string, from?: string | null, to?: string | null) => (!from || day >= String(from).slice(0, 10)) && (!to || day <= String(to).slice(0, 10));

/**
 * Entradas do horário fixo cujo dia OPERACIONAL cai em [startDay, endDay]
 * (olha-se um dia de calendário para cada lado: uma entrada às 01:00 é ainda
 * do dia operacional anterior). Sem férias/baixas nem fora do contrato. PURA.
 */
export function fixedScheduledStarts(startDay: string, endDay: string, schedules: readonly FixedScheduleRow[], leaves: readonly LeaveRow[] = []): FixedStart[] {
  const byEmp = new Map<number, FixedScheduleRow[]>();
  for (const s of schedules) {
    if (!s.employeeId || s.isWorkDay === false || Number(s.isWorkDay) === 0) continue;
    const list = byEmp.get(s.employeeId) ?? [];
    list.push(s);
    byEmp.set(s.employeeId, list);
  }
  const leavesOf = new Map<number, LeaveRow[]>();
  for (const l of leaves) leavesOf.set(l.employeeId, [...(leavesOf.get(l.employeeId) ?? []), l]);
  const out: FixedStart[] = [];
  for (let cal = addDays(startDay, -1); cal <= addDays(endDay, 1); cal = addDays(cal, 1)) {
    const wd = weekdayOf(cal);
    for (const [emp, list] of byEmp) {
      const s = list.find((x) => Number(x.weekday) === wd);
      if (!s) continue;
      const h = hoursOfHhmm(s.startTime);
      if (h == null) continue;
      if (!within(cal, s.contractStart, s.contractEnd)) continue;
      if ((leavesOf.get(emp) ?? []).some((l) => cal >= l.fromDate && cal <= l.toDate)) continue;
      const startMs = lisbonWallTimeUtcMs(cal, h);
      const day = operationalDayOf(startMs);
      if (day < startDay || day > endDay) continue;
      const he = hoursOfHhmm(s.endTime ?? null);
      const endMs = he == null ? null : lisbonWallTimeUtcMs(he > h ? cal : addDays(cal, 1), he);
      out.push({ employeeId: emp, calendarDay: cal, day, startMs, endMs });
    }
  }
  return out;
}
