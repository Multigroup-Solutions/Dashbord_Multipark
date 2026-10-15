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
 */
import { addDays, lisbonWallTimeUtcMs, operationalDayOf } from "./lisbonDay";

export interface FixedScheduleRow {
  /** id da linha: nos dias duplicados (a mesma pessoa e dia da semana) conta a de id mais baixo (plano 63, 10a) */
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

const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
const within = (day: string, from?: string | null, to?: string | null) => (!from || day >= String(from).slice(0, 10)) && (!to || day <= String(to).slice(0, 10));

/**
 * A linha desse dia da semana. Nos dias duplicados (não há UNIQUE pessoa+dia
 * na tabela) fica a de id mais baixo — é o que a BD devolvia, na prática, à
 * Avaliação e às faltas; sem ids, a primeira da lista. PURA.
 */
function firstOfWeekday(list: readonly FixedScheduleRow[], wd: number): FixedScheduleRow | undefined {
  let best: FixedScheduleRow | undefined;
  for (const x of list) {
    if (Number(x.weekday) !== wd) continue;
    if (!best || (x.id != null && best.id != null && Number(x.id) < Number(best.id))) best = x;
  }
  return best;
}

/**
 * Entradas do horário fixo cujo dia OPERACIONAL cai em [startDay, endDay]
 * (olha-se um dia de calendário para cada lado: uma entrada às 01:00 é ainda
 * do dia operacional anterior). Sem férias/baixas, fora do contrato nem
 * feriados (ptHolidayOf, com a cidade da ficha). PURA.
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
      const s = firstOfWeekday(list, wd);
      if (!s) continue;
      const h = hoursOfHhmm(s.startTime);
      if (h == null) continue;
      if (!within(cal, s.contractStart, s.contractEnd)) continue;
      if (ptHolidayOf(cal, s.city)) continue;
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
