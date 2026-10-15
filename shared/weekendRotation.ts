/**
 * Fins de semana (plano 63, passo 10b): cada funcionário tem o seu horário
 * fixo e o fim de semana RODA. A rotação marca-se por data, com exceções ao
 * horário fixo (`schedule_overrides`, ver shared/workSchedule.ts → dayPlan):
 *  - o quadro dos próximos fins de semana de uma cidade (quem está de serviço);
 *  - as horas por omissão (as do horário da pessoa nesse dia; sem ele 09–18);
 *  - a folga de compensação proposta no MESMO mês (o modelo das 40 h fecha mês
 *    a mês: uma folga noutro mês não desconta e o sábado paga-se como horas a
 *    mais) e o aviso quando cai noutro mês;
 *  - o aviso dos 7 dias seguidos sem folga (CT, art. 232.º: pelo menos um dia
 *    de descanso por semana) — só aviso;
 *  - "Repetir a rotação": a mesma ordem de pessoas nas semanas seguintes.
 * PURO (igual no cliente e no servidor).
 */
import { addDays } from "./lisbonDay";
import { dayPlan, hoursOfHhmm, ptHolidayOf, weekdayOf, workRowOn, type DayPlan, type FixedScheduleRow, type LeaveRow, type ScheduleOverrideRow } from "./workSchedule";

export const DEFAULT_DUTY_START = "09:00";
export const DEFAULT_DUTY_END = "18:00";
/** Quantos fins de semana se mostram / repetem de uma vez (no máximo). */
export const MAX_WEEKENDS = 26;
/** "HH:MM" (00:00–23:59). */
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "AAAA-MM-DD" e uma data que existe. PURA. */
export function isValidDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

export const isWeekendDay = (day: string): boolean => { const w = weekdayOf(day); return w === 0 || w === 6; };

/** O 1.º sábado no dia ou depois. PURA. */
export function saturdayOnOrAfter(day: string): string {
  return addDays(day, (6 - weekdayOf(day) + 7) % 7);
}

/** Os sábados de `weeks` fins de semana a partir de `day` (o 1.º sábado ≥ day). PURA. */
export function saturdaysFrom(day: string, weeks: number): string[] {
  const first = saturdayOnOrAfter(day);
  const n = Math.max(1, Math.min(MAX_WEEKENDS, Math.floor(weeks)));
  return Array.from({ length: n }, (_, i) => addDays(first, 7 * i));
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
/** "2026-10-24" → "sáb 24 out". PURA. */
export function dayLabelPt(day: string): string {
  return `${WEEKDAYS[weekdayOf(day)]} ${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ""}`;
}

/** O que se sabe do horário de uma pessoa (o horário fixo, as exceções ativas, as férias/baixas e o contrato). */
export interface PersonSchedule {
  employeeId: number;
  name: string;
  schedules: readonly FixedScheduleRow[];
  overrides: readonly ScheduleOverrideRow[];
  leaves: readonly LeaveRow[];
  contractStart?: string | null;
  contractEnd?: string | null;
  city?: string | null;
}

/** dayPlan de uma pessoa num dia de calendário (sem o Extras-Dia). PURA. */
export function planOf(p: PersonSchedule, day: string, opts: { withoutOverrides?: boolean } = {}): DayPlan {
  return dayPlan({
    calendarDay: day, schedules: p.schedules, overrides: opts.withoutOverrides ? [] : p.overrides, leaves: p.leaves,
    contractStart: p.contractStart ?? null, contractEnd: p.contractEnd ?? null, city: p.city ?? null,
  });
}

/** Horas por omissão de um dia de serviço: as do horário fixo nesse dia da semana (se for de trabalho); sem ele, 09:00–18:00. PURA. */
export function defaultDutyHours(schedules: readonly FixedScheduleRow[], day: string): { startTime: string; endTime: string } {
  // a mesma linha que o dayPlan, a Avaliação, as faltas e a folha (workRowOn: a de TRABALHO de id mais baixo)
  const s = workRowOn(schedules, weekdayOf(day));
  const ok = s && hoursOfHhmm(s.startTime) != null && hoursOfHhmm(s.endTime ?? null) != null;
  return ok ? { startTime: String(s!.startTime).slice(0, 5), endTime: String(s!.endTime).slice(0, 5) } : { startTime: DEFAULT_DUTY_START, endTime: DEFAULT_DUTY_END };
}

// ─── Folga de compensação ────────────────────────────────────────────────────

/** Um dia de serviço que o horário fixo não tinha (precisa de folga de compensação)? PURA. */
export function needsCompensation(p: PersonSchedule, day: string): boolean {
  const now = planOf(p, day);
  if (now.kind !== "work" || now.source !== "override") return false;
  return planOf(p, day, { withoutOverrides: true }).kind !== "work";
}

/**
 * Proposta de folga de compensação para um dia de serviço: o dia útil mais
 * perto (primeiro o seguinte, depois o anterior, até 7 dias) em que a pessoa
 * trabalha pelo horário fixo, sem exceção nem feriado, fora de `taken` — de
 * preferência no MESMO mês; se não houver, o mais perto noutro mês (com
 * `sameMonth: false`, para o ecrã avisar). PURA.
 */
export function proposeCompensationDay(p: PersonSchedule, workedDay: string, taken: ReadonlySet<string> = new Set()): { day: string; sameMonth: boolean } | null {
  const candidates: string[] = [];
  for (let d = 1; d <= 7; d++) candidates.push(addDays(workedDay, d), addDays(workedDay, -d));
  const ok = candidates.filter((c) => {
    if (isWeekendDay(c) || taken.has(c)) return false;
    const plan = planOf(p, c);
    return plan.kind === "work" && plan.source === "fixed";
  });
  const same = ok.find((c) => c.slice(0, 7) === workedDay.slice(0, 7));
  if (same) return { day: same, sameMonth: true };
  return ok[0] ? { day: ok[0], sameMonth: false } : null;
}

/**
 * Cada dia de serviço (exceção "trabalha" num dia que o horário fixo não
 * tinha) com a sua folga de compensação (exceção "folga" com o motivo
 * "compensação", até 7 dias antes ou depois) ou null. Cada folga só serve um
 * dia, e os pares mais perto juntam-se primeiro (um serviço sem folga duas
 * semanas antes nunca "rouba" a folga do sábado ao lado); empate: a folga
 * depois do serviço, depois o serviço mais antigo. PURA.
 */
export function compensationMatches(p: PersonSchedule, workedDays: readonly string[]): Map<string, string | null> {
  const comps = Array.from(new Set(p.overrides
    .filter((o) => o.kind === "off" && o.reason === "compensation" && !(o.cancelledAt != null && String(o.cancelledAt) !== ""))
    .map((o) => o.day))).sort();
  const worked = Array.from(new Set(workedDays)).sort();
  const dist = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  const pairs: Array<{ w: string; c: string; d: number }> = [];
  for (const w of worked) for (const c of comps) { const d = dist(w, c); if (d <= 7) pairs.push({ w, c, d }); }
  pairs.sort((a, b) => a.d - b.d || (a.c > a.w ? 0 : 1) - (b.c > b.w ? 0 : 1) || a.w.localeCompare(b.w) || a.c.localeCompare(b.c));
  const out = new Map<string, string | null>(worked.map((w) => [w, null]));
  const usedC = new Set<string>();
  for (const { w, c } of pairs) {
    if (out.get(w) || usedC.has(c)) continue;
    out.set(w, c);
    usedC.add(c);
  }
  return out;
}

/**
 * Os dias de serviço (que precisam de folga) entre `from` e `to`, cada um com a
 * folga de compensação que o serve (ou null) — a mesma conta no quadro, ao
 * marcar e ao cancelar, para uma folga nunca servir dois dias. PURA.
 */
export function compensationMap(p: PersonSchedule, from: string, to: string): Map<string, string | null> {
  const worked: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (needsCompensation(p, d)) worked.push(d);
  return compensationMatches(p, worked);
}

/** A folga de compensação que serve este dia de serviço (ou null). PURA. */
export function compensationServing(p: PersonSchedule, day: string): string | null {
  if (!needsCompensation(p, day)) return null;
  return compensationMap(p, addDays(day, -14), addDays(day, 14)).get(day) ?? null;
}

/**
 * As folgas de compensação a marcar para estes dias de serviço (PURA): só os
 * dias que precisam (o horário fixo não os tinha) e que ainda não têm uma
 * folga a servi-los; o dia útil mais perto em que a pessoa trabalha pelo
 * horário fixo, de preferência no MESMO mês; nunca num dia passado nem num dia
 * que já tem exceção; cada folga serve um só dia. `without`: os dias sem
 * nenhum dia útil livre à volta.
 */
export function planCompensations(p: PersonSchedule, workedDays: readonly string[], today: string): { compensations: Array<{ forDay: string; day: string; sameMonth: boolean }>; without: string[] } {
  const need = Array.from(new Set(workedDays)).sort().filter((d) => needsCompensation(p, d));
  if (!need.length) return { compensations: [], without: [] };
  const served = compensationMap(p, addDays(need[0], -14), addDays(need[need.length - 1], 14));
  const taken = new Set(p.overrides.filter((o) => !(o.cancelledAt != null && String(o.cancelledAt) !== "")).map((o) => o.day));
  for (const d of need) for (let k = -7; k <= 7; k++) { const c = addDays(d, k); if (c < today) taken.add(c); }
  const compensations: Array<{ forDay: string; day: string; sameMonth: boolean }> = [];
  const without: string[] = [];
  for (const d of need) {
    if (served.get(d)) continue;
    const prop = proposeCompensationDay(p, d, taken);
    if (!prop) { without.push(d); continue; }
    taken.add(prop.day);
    compensations.push({ forDay: d, day: prop.day, sameMonth: prop.sameMonth });
  }
  return { compensations, without };
}

// ─── Quadro e avisos ─────────────────────────────────────────────────────────

export interface BoardDuty {
  employeeId: number;
  name: string;
  startTime: string;
  endTime: string | null;
  /** "override" = marcado por data; "fixed" = o horário fixo dele já tem esse dia */
  source: "override" | "fixed";
  overrideId: number | null;
  /** precisa de folga de compensação (o horário fixo não tinha este dia) */
  needsCompensation: boolean;
  /** a folga de compensação marcada para este dia (ou null) */
  compensationDay: string | null;
}
export interface BoardOff { employeeId: number; name: string; overrideId: number | null; reason: string | null }
export interface BoardDay { day: string; holiday: string | null; onDuty: BoardDuty[]; off: BoardOff[] }
export interface BoardWeek { saturday: string; sunday: string; days: [BoardDay, BoardDay] }

/** Quem está de serviço (e quem tem folga marcada) em cada sábado e domingo. PURA. */
export function weekendBoard(people: readonly PersonSchedule[], saturdays: readonly string[], city?: string | null): BoardWeek[] {
  // a mesma conta de marcar e de cancelar: todos os dias de serviço à volta (também um feriado a meio da semana)
  const comp = new Map<number, Map<string, string | null>>();
  if (saturdays.length) {
    const from = addDays(saturdays[0], -7), to = addDays(saturdays[saturdays.length - 1], 8);
    for (const p of people) comp.set(p.employeeId, compensationMap(p, from, to));
  }
  const dayOf = (day: string): BoardDay => {
    const onDuty: BoardDuty[] = [], off: BoardOff[] = [];
    for (const p of people) {
      const plan = planOf(p, day);
      if (plan.kind === "work") {
        const nc = needsCompensation(p, day);
        onDuty.push({ employeeId: p.employeeId, name: p.name, startTime: plan.startTime, endTime: plan.endTime, source: plan.source, overrideId: plan.overrideId, needsCompensation: nc, compensationDay: nc ? comp.get(p.employeeId)?.get(day) ?? null : null });
      } else if (plan.kind === "none" && plan.reason === "override_off") {
        const o = p.overrides.find((x) => x.id === plan.overrideId) ?? null;
        off.push({ employeeId: p.employeeId, name: p.name, overrideId: plan.overrideId ?? null, reason: o?.reason ?? null });
      }
    }
    const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, "pt");
    return { day, holiday: ptHolidayOf(day, city ?? null), onDuty: onDuty.sort(byName), off: off.sort(byName) };
  };
  return saturdays.map((s) => ({ saturday: s, sunday: addDays(s, 1), days: [dayOf(s), dayOf(addDays(s, 1))] }));
}

export type WeekendWarning =
  | { kind: "no_one"; day: string }
  | { kind: "seven_days"; employeeId: number; name: string; from: string; to: string }
  | { kind: "comp_other_month"; employeeId: number; name: string; day: string; compensationDay: string };

/** Corridas de N ou mais dias seguidos com horário (dayPlan "work") em [from, to]. PURA. */
export function workRuns(p: PersonSchedule, from: string, to: string, minDays = 7): Array<{ from: string; to: string; days: number }> {
  const runs: Array<{ from: string; to: string; days: number }> = [];
  let start: string | null = null, n = 0, last = from;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (planOf(p, d).kind === "work") { if (start == null) start = d; n++; last = d; }
    else { if (start != null && n >= minDays) runs.push({ from: start, to: last, days: n }); start = null; n = 0; }
  }
  if (start != null && n >= minDays) runs.push({ from: start, to: last, days: n });
  return runs;
}

/**
 * Avisos do quadro: fim de semana (sábado ou domingo) sem ninguém; alguém
 * com 7 dias seguidos sem folga (olha-se uma semana para cada lado); folga de
 * compensação noutro mês. Só avisos: nada é bloqueado. PURA.
 */
export function boardWarnings(people: readonly PersonSchedule[], saturdays: readonly string[], city?: string | null): WeekendWarning[] {
  if (!saturdays.length) return [];
  const out: WeekendWarning[] = [];
  const board = weekendBoard(people, saturdays, city);
  for (const w of board) for (const d of w.days) if (!d.onDuty.length) out.push({ kind: "no_one", day: d.day });
  const first = saturdays[0], lastSun = addDays(saturdays[saturdays.length - 1], 1);
  for (const p of people) {
    for (const r of workRuns(p, addDays(first, -6), addDays(lastSun, 6))) {
      if (r.to < first || r.from > lastSun) continue;
      out.push({ kind: "seven_days", employeeId: p.employeeId, name: p.name, from: r.from, to: r.to });
    }
  }
  for (const w of board) for (const d of w.days) for (const x of d.onDuty) {
    if (x.compensationDay && x.compensationDay.slice(0, 7) !== d.day.slice(0, 7)) {
      out.push({ kind: "comp_other_month", employeeId: x.employeeId, name: x.name, day: d.day, compensationDay: x.compensationDay });
    }
  }
  return out;
}

/** O texto de um aviso (PT-PT). PURA. */
export function warningText(w: WeekendWarning): string {
  if (w.kind === "no_one") return `${dayLabelPt(w.day)}: ninguém de serviço.`;
  if (w.kind === "seven_days") return `${w.name}: ${Math.round((Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86_400_000) + 1} dias seguidos sem folga (${dayLabelPt(w.from)} a ${dayLabelPt(w.to)}). A lei pede pelo menos um dia de descanso por semana.`;
  return `${w.name}: a folga de compensação de ${dayLabelPt(w.day)} é a ${dayLabelPt(w.compensationDay)}, noutro mês — o dia de serviço paga-se como horas a mais e a folga não desconta. Se puderes, marca-a no mesmo mês.`;
}

// ─── Repetir a rotação ──────────────────────────────────────────────────────

/** Uma marcação de fim de semana (motivo "fim de semana"): 0 = sábado, 1 = domingo. */
export interface RotationEntry { employeeId: number; offset: 0 | 1; kind: "work" | "off"; startTime: string | null; endTime: string | null }

/**
 * O modelo da rotação: em cada fim de semana de [patternFrom, patternTo]
 * (sábados), as exceções com o motivo "fim de semana" de cada pessoa
 * (de serviço ou folga por não ser a vez). PURA.
 */
export function rotationPattern(people: readonly PersonSchedule[], patternSaturdays: readonly string[]): RotationEntry[][] {
  return patternSaturdays.map((sat) => {
    const entries: RotationEntry[] = [];
    for (const p of people) {
      for (const offset of [0, 1] as const) {
        const day = addDays(sat, offset);
        const o = p.overrides.find((x) => x.day === day && x.reason === "weekend" && !(x.cancelledAt != null && String(x.cancelledAt) !== ""));
        if (!o) continue;
        entries.push({ employeeId: p.employeeId, offset, kind: o.kind === "work" ? "work" : "off", startTime: o.kind === "work" ? String(o.startTime ?? "").slice(0, 5) || null : null, endTime: o.kind === "work" ? String(o.endTime ?? "").slice(0, 5) || null : null });
      }
    }
    return entries;
  });
}

/**
 * "Repetir a rotação": a mesma ordem nas `weeks` semanas a seguir ao último
 * fim de semana do modelo — o 1.º fim de semana novo copia o 1.º do modelo, o
 * 2.º o 2.º, e assim por diante (com 3 fins de semana no modelo: A, B, C → A,
 * B, C, A, B, C…). PURA.
 */
export function rotationTargets(pattern: readonly RotationEntry[][], lastPatternSaturday: string, weeks: number): Array<{ saturday: string; entries: Array<RotationEntry & { day: string }> }> {
  if (!pattern.length) return [];
  const n = Math.max(1, Math.min(MAX_WEEKENDS, Math.floor(weeks)));
  return Array.from({ length: n }, (_, k) => {
    const saturday = addDays(lastPatternSaturday, 7 * (k + 1));
    return { saturday, entries: pattern[k % pattern.length].map((e) => ({ ...e, day: addDays(saturday, e.offset) })) };
  });
}
