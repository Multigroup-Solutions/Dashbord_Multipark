/**
 * Horário fixo do RH (tabela `schedules`: dia da semana, entrada, saída, dia
 * de trabalho) → a hora de entrada de cada dia. Tarefa 62 (Q8, Jorge, 14 out
 * 2026): "o atraso conta para todos os que têm horário" — quem tem horário
 * fixo "ainda tem mais de chegar a horas". PURO.
 *
 * Quem está na escala do Extras-Dia num dia usa a hora da ESCALA (mais
 * específica); o horário fixo vale nos outros dias. Sem horário nesse dia da
 * semana, dia livre (isWorkDay = 0), de férias/baixa (`employee_leaves`), fora
 * do contrato ou num FERIADO (os nacionais e o municipal da cidade da ficha):
 * não há hora de entrada (nem atraso nem falta). O horário do RH não diz se a
 * pessoa trabalha nos feriados — na dúvida, nunca se inventa um atraso nem uma
 * falta (quem trabalhar num feriado escalado no Extras-Dia tem a escala).
 *
 * Plano 63, passo 10b: o fim de semana roda — as EXCEÇÕES POR DATA
 * (`schedule_overrides`: "trabalha das HH:MM às HH:MM" ou "folga") ganham ao
 * horário fixo nesse dia (`dayPlan`); um feriado com uma exceção "trabalha"
 * conta (feriado de serviço). Sem exceções, tudo igual.
 */
import { addDays, lisbonWallTimeUtcMs, operationalDayOf } from "./lisbonDay";

export interface FixedScheduleRow {
  /** id da linha: com dias duplicados ganha o mais baixo (plano 63, §10.3) */
  id?: number | null;
  employeeId: number;
  /** 0 = domingo … 6 = sábado (como no RH e no processamento salarial) */
  weekday: number;
  /** "HH:MM" ou "HH:MM:SS" (Lisboa) */
  startTime: string;
  endTime?: string | null;
  isWorkDay?: boolean | number | null;
  contractStart?: string | null;
  contractEnd?: string | null;
  /** cidade da ficha ("lisbon" | "porto" | "faro"), para o feriado municipal; sem ela, só os nacionais */
  city?: string | null;
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
  /** de onde veio a hora: o horário fixo ou uma exceção por data (passo 10b) */
  source?: "fixed" | "override";
}

/** "08:30" → 8,5 (horas). Inválido → null. PURA. */
export function hoursOfHhmm(s: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h + min / 60;
}

// ─── Feriados (Portugal) ─────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Domingo de Páscoa (calendário gregoriano, algoritmo de Meeus/Jones/Butcher) → "AAAA-MM-DD". PURA. */
export function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Feriados nacionais obrigatórios (Código do Trabalho, art. 234.º; o Carnaval é facultativo e não entra). */
const FIXED_NATIONAL: Record<string, string> = {
  "01-01": "Ano Novo", "04-25": "Dia da Liberdade", "05-01": "Dia do Trabalhador", "06-10": "Dia de Portugal",
  "08-15": "Assunção de Nossa Senhora", "10-05": "Implantação da República", "11-01": "Todos os Santos",
  "12-01": "Restauração da Independência", "12-08": "Imaculada Conceição", "12-25": "Natal",
};
/** Feriado municipal da cidade (as cidades da operação). */
const MUNICIPAL: Record<string, { mmdd: string; name: string }> = {
  lisbon: { mmdd: "06-13", name: "Santo António (Lisboa)" },
  porto: { mmdd: "06-24", name: "São João (Porto)" },
  faro: { mmdd: "09-07", name: "Dia da Cidade (Faro)" },
};

/**
 * Nome do feriado nesse dia de calendário (nacional, ou o municipal da
 * cidade), ou null. Móveis: Sexta-feira Santa (Páscoa − 2), Páscoa e Corpo de
 * Deus (Páscoa + 60). PURA.
 */
export function ptHolidayOf(day: string, city?: string | null): string | null {
  const mmdd = day.slice(5, 10);
  if (FIXED_NATIONAL[mmdd]) return FIXED_NATIONAL[mmdd];
  const easter = easterSunday(Number(day.slice(0, 4)));
  if (day === addDays(easter, -2)) return "Sexta-feira Santa";
  if (day === easter) return "Páscoa";
  if (day === addDays(easter, 60)) return "Corpo de Deus";
  const m = city ? MUNICIPAL[city] : undefined;
  return m && m.mmdd === mmdd ? m.name : null;
}

export const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
const within = (day: string, from?: string | null, to?: string | null) => (!from || day >= String(from).slice(0, 10)) && (!to || day <= String(to).slice(0, 10));

// ─── Exceções por data ao horário fixo (plano 63, passo 10b) ─────────────────

/** "trabalha das HH:MM às HH:MM" ou "folga" nesse dia. */
export const OVERRIDE_KINDS = ["work", "off"] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];
/** Porquê: fim de semana de serviço (ou não é a vez), feriado de serviço, folga de compensação, troca, outro. */
export const OVERRIDE_REASONS = ["weekend", "holiday", "compensation", "swap", "other"] as const;
export type OverrideReason = (typeof OVERRIDE_REASONS)[number];
export const OVERRIDE_REASON_LABELS: Record<OverrideReason, string> = {
  weekend: "Fim de semana",
  holiday: "Feriado de serviço",
  compensation: "Folga de compensação",
  swap: "Troca",
  other: "Outro",
};

/** Uma exceção (tabela `schedule_overrides`). Uma ativa por pessoa e dia; cancelar não apaga. */
export interface ScheduleOverrideRow {
  id?: number | null;
  employeeId: number;
  /** dia de CALENDÁRIO (Lisboa) da entrada, "AAAA-MM-DD" (a mesma chave que FixedStart.calendarDay) */
  day: string;
  kind: OverrideKind | string;
  /** "HH:MM" (Lisboa), só no "work"; uma saída ≤ entrada é no dia seguinte */
  startTime?: string | null;
  endTime?: string | null;
  reason?: string | null;
  cancelledAt?: string | null;
  /** contrato da ficha (para quem não tem horário fixo: o "fora do contrato" vale na mesma) */
  contractStart?: string | null;
  contractEnd?: string | null;
}

/** O horário de um dia de calendário de uma pessoa (dayPlan). */
export type DayPlan =
  | { kind: "escala" }
  | { kind: "work"; source: "override" | "fixed"; startHour: number; endHour: number | null; startTime: string; endTime: string | null; overrideId: number | null }
  | { kind: "none"; reason: "mode" | "out_of_contract" | "leave" | "override_off" | "holiday" | "no_schedule" | "day_off" | "invalid_time"; overrideId?: number | null; holiday?: string };

export interface DayPlanInput {
  /** dia de CALENDÁRIO (Lisboa) */
  calendarDay: string;
  /** linhas do horário fixo DESTA pessoa; com dias duplicados ganha a de trabalho de id mais baixo (fixedRowOn) */
  schedules: readonly FixedScheduleRow[];
  /** exceções DESTA pessoa (ativas; com duas no mesmo dia ganha a mais recente) */
  overrides?: readonly ScheduleOverrideRow[];
  leaves?: readonly LeaveRow[];
  contractStart?: string | null;
  contractEnd?: string | null;
  /** cidade da ficha, para o feriado municipal */
  city?: string | null;
  /**
   * A pessoa tem linha no Extras-Dia nesse dia. O Extras-Dia ganha, mas cada
   * leitor continua a aplicar o SEU filtro (o atraso conta as propostas; as
   * faltas do horário saltam qualquer linha) — por isso os leitores do
   * horário fixo não passam isto e filtram a escala pelo dia operacional.
   */
  inEscala?: boolean;
  /** Modo do ponto nesse dia (plano 63, passo 1): na isenção e no "sempre em serviço" não há horário. */
  pontoMode?: string | null;
}

const isCancelled = (o: ScheduleOverrideRow) => o.cancelledAt != null && String(o.cancelledAt) !== "";

/** A exceção que vale nesse dia (a mais recente, se houver duas — dados antigos). PURA. */
export function activeOverrideOn(overrides: readonly ScheduleOverrideRow[], day: string): ScheduleOverrideRow | null {
  let best: ScheduleOverrideRow | null = null;
  for (const o of overrides) {
    if (o.day !== day || isCancelled(o)) continue;
    if (!best || (o.id ?? 0) >= (best.id ?? 0)) best = o;
  }
  return best;
}

const isWork = (s: FixedScheduleRow) => !(s.isWorkDay === false || Number(s.isWorkDay) === 0);

/**
 * A linha do horário fixo desse dia da semana. Com dias duplicados (não há
 * UNIQUE pessoa+dia) ganha a de TRABALHO de id mais baixo (sem id, a 1.ª da
 * lista); só quando nenhuma é de trabalho fica a folga. É o que a Avaliação e
 * as faltas sempre leram (a consulta delas só traz `isWorkDay = 1`; o 10a
 * escolhe a de id mais baixo entre essas) e o que a folha conta como dia de
 * trabalho (qualquer linha de trabalho) — assim o ecrã, o Perfil e os
 * leitores dizem o mesmo. PURA.
 */
export function fixedRowOn(schedules: readonly FixedScheduleRow[], weekday: number): FixedScheduleRow | null {
  let best: FixedScheduleRow | null = null;
  for (const s of schedules) {
    if (Number(s.weekday) !== weekday) continue;
    if (!best) { best = s; continue; }
    const sw = isWork(s), bw = isWork(best);
    if (sw !== bw) { if (sw) best = s; continue; }
    if (s.id != null && best.id != null && Number(s.id) < Number(best.id)) best = s;
  }
  return best;
}

/**
 * O horário de uma pessoa num dia de CALENDÁRIO, por esta ordem (plano 63, §10.3):
 *   1. o Extras-Dia (se `inEscala`);
 *   2. a exceção da data (`schedule_overrides`): trabalha ou folga;
 *   3. o horário fixo (`schedules`, pelo dia da semana e `isWorkDay`);
 *   4. nada.
 * Não há horário (fixo nem por exceção) nas férias/baixas, fora do contrato,
 * nos modos 2 e 3, nem num feriado — exceto com uma exceção "trabalha" nessa
 * data (o feriado de serviço marca-se). Sem exceções dá o mesmo que antes. PURA.
 */
export function dayPlan(i: DayPlanInput): DayPlan {
  if (i.inEscala) return { kind: "escala" };
  const mode = String(i.pontoMode ?? "");
  if (mode === "exempt" || mode === "always_on") return { kind: "none", reason: "mode" };
  const cal = i.calendarDay;
  if (!within(cal, i.contractStart, i.contractEnd)) return { kind: "none", reason: "out_of_contract" };
  if ((i.leaves ?? []).some((l) => cal >= l.fromDate && cal <= l.toDate)) return { kind: "none", reason: "leave" };
  const o = activeOverrideOn(i.overrides ?? [], cal);
  if (o) {
    const overrideId = o.id ?? null;
    if (o.kind !== "work") return { kind: "none", reason: "override_off", overrideId };
    const h = hoursOfHhmm(o.startTime ?? null);
    if (h == null) return { kind: "none", reason: "invalid_time", overrideId };
    const he = hoursOfHhmm(o.endTime ?? null);
    return { kind: "work", source: "override", startHour: h, endHour: he, startTime: String(o.startTime).slice(0, 5), endTime: he == null ? null : String(o.endTime).slice(0, 5), overrideId };
  }
  const holiday = ptHolidayOf(cal, i.city);
  if (holiday) return { kind: "none", reason: "holiday", holiday };
  const s = fixedRowOn(i.schedules, weekdayOf(cal));
  if (!s) return { kind: "none", reason: "no_schedule" };
  if (!isWork(s)) return { kind: "none", reason: "day_off" };
  const h = hoursOfHhmm(s.startTime);
  if (h == null) return { kind: "none", reason: "invalid_time" };
  const he = hoursOfHhmm(s.endTime ?? null);
  return { kind: "work", source: "fixed", startHour: h, endHour: he, startTime: String(s.startTime).slice(0, 5), endTime: he == null ? null : String(s.endTime).slice(0, 5), overrideId: null };
}

/** Instantes UTC da entrada e da saída de um dia com horário (a saída ≤ entrada é no dia seguinte). PURA. */
export function planInstants(calendarDay: string, startHour: number, endHour: number | null): { startMs: number; endMs: number | null } {
  const startMs = lisbonWallTimeUtcMs(calendarDay, startHour);
  const endMs = endHour == null ? null : lisbonWallTimeUtcMs(endHour > startHour ? calendarDay : addDays(calendarDay, 1), endHour);
  return { startMs, endMs };
}

/**
 * Entradas do horário fixo (e das exceções por data) cujo dia OPERACIONAL cai
 * em [startDay, endDay] (olha-se um dia de calendário para cada lado: uma
 * entrada às 01:00 é ainda do dia operacional anterior). Cada dia sai do
 * `dayPlan`: sem férias/baixas, fora do contrato nem feriados (ptHolidayOf,
 * com a cidade da ficha), exceto uma exceção "trabalha". Sem exceções dá o
 * mesmo que antes do passo 10b. PURA.
 */
export function fixedScheduledStarts(startDay: string, endDay: string, schedules: readonly FixedScheduleRow[], leaves: readonly LeaveRow[] = [], overrides: readonly ScheduleOverrideRow[] = []): FixedStart[] {
  // primeiro as linhas de trabalho (a mesma ordem de pessoas de antes do 10b), depois as folgas
  const byEmp = new Map<number, FixedScheduleRow[]>();
  for (const work of [true, false]) {
    for (const s of schedules) {
      if (!s.employeeId || isWork(s) !== work) continue;
      const list = byEmp.get(s.employeeId) ?? [];
      list.push(s);
      byEmp.set(s.employeeId, list);
    }
  }
  const overridesOf = new Map<number, ScheduleOverrideRow[]>();
  for (const o of overrides) {
    if (!o.employeeId) continue;
    overridesOf.set(o.employeeId, [...(overridesOf.get(o.employeeId) ?? []), o]);
    if (!byEmp.has(o.employeeId)) byEmp.set(o.employeeId, []);
  }
  const leavesOf = new Map<number, LeaveRow[]>();
  for (const l of leaves) leavesOf.set(l.employeeId, [...(leavesOf.get(l.employeeId) ?? []), l]);
  const out: FixedStart[] = [];
  for (let cal = addDays(startDay, -1); cal <= addDays(endDay, 1); cal = addDays(cal, 1)) {
    for (const [emp, list] of byEmp) {
      const ov = overridesOf.get(emp) ?? [];
      const ref = list[0] ?? ov[0];
      const plan = dayPlan({
        calendarDay: cal, schedules: list, overrides: ov, leaves: leavesOf.get(emp) ?? [],
        contractStart: ref?.contractStart ?? null, contractEnd: ref?.contractEnd ?? null, city: list[0]?.city ?? null,
      });
      if (plan.kind !== "work") continue;
      const { startMs, endMs } = planInstants(cal, plan.startHour, plan.endHour);
      const day = operationalDayOf(startMs);
      if (day < startDay || day > endDay) continue;
      out.push({ employeeId: emp, calendarDay: cal, day, startMs, endMs, source: plan.source });
    }
  }
  return out;
}
