/**
 * Plano 63, passo 10a — "Horários por rever" e o que tem de estar pronto antes
 * de ligar as faltas automáticas (`RH_FALTAS_HORARIO`). PURO.
 *
 *  - a lista só de leitura (RH → Horários por rever): funcionários sem
 *    horário, dias duplicados, horas que não se leem, quem não pica há 14
 *    dias (quase de certeza ainda na impressão digital) e quem tem sábado ou
 *    domingo no horário fixo (o fim de semana roda: sem a exceção "folga"
 *    por data do passo 10b — RH → Fins de semana — dá faltas falsas);
 *  - `rh.noShowSkip`: pessoas fora das faltas automáticas até uma data (com
 *    motivo). Uma por pessoa; o "até" conta (inclusive);
 *  - as horas do horário só "HH:MM" e a regra de quem conta nos dias
 *    duplicados (a linha de TRABALHO de id mais baixo — `workRowOn` em
 *    shared/workSchedule.ts, a mesma da ficha, da Avaliação, das faltas e
 *    da folha);
 *  - a dispensa com motivo das "Possíveis faltas" (Férias, Baixa e
 *    Justificada criam a ausência aprovada desse dia; nada se apaga).
 */
import { z } from "zod";
import { addDays } from "./lisbonDay";

// ─── Horas do horário ────────────────────────────────────────────────────────

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** "07:00" sim; "7:00", "07:00:00", "9h", "24:00" não. PURA. */
export const isHhmm = (s: unknown): boolean => typeof s === "string" && HHMM_RE.test(s);

/**
 * A hora gravada, como "HH:MM", se os leitores a percebem ("7:00" → "07:00",
 * "08:30:00" → "08:30"); null se não ("9h", "25:00", vazio). PURA.
 */
export function canonicalHhmm(s: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59 || (m[3] != null && Number(m[3]) > 59)) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/**
 * O que se grava num dia do horário (`rh.schedules.upsert`). Num dia de
 * trabalho: as duas horas em "HH:MM" e diferentes (uma saída antes da
 * entrada é no dia seguinte). Num dia de folga as horas não se leem: uma
 * hora que não é "HH:MM" passa a "00:00", para nunca ficar texto solto na
 * tabela. Devolve o erro (PT-PT) ou os valores a gravar. PURA.
 */
export function scheduleDayToSave(input: { startTime: string; endTime: string; isWorkDay: boolean }):
  { ok: true; startTime: string; endTime: string; isWorkDay: 0 | 1 } | { ok: false; error: string } {
  const start = String(input.startTime ?? "").trim(), end = String(input.endTime ?? "").trim();
  if (!input.isWorkDay) return { ok: true, startTime: isHhmm(start) ? start : "00:00", endTime: isHhmm(end) ? end : "00:00", isWorkDay: 0 };
  if (!isHhmm(start)) return { ok: false, error: `Hora de entrada inválida${start ? ` ("${start.slice(0, 12)}")` : ""}: escreve HH:MM (ex.: 07:00).` };
  if (!isHhmm(end)) return { ok: false, error: `Hora de saída inválida${end ? ` ("${end.slice(0, 12)}")` : ""}: escreve HH:MM (ex.: 17:00).` };
  if (start === end) return { ok: false, error: "A entrada e a saída não podem ser à mesma hora." };
  return { ok: true, startTime: start, endTime: end, isWorkDay: 1 };
}

export const WEEKDAY_LABELS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"] as const;
const WEEKDAY_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;

/** "Seg 07:00–17:00" / "Seg folga" — para o registo de atividade. PURA. */
export function scheduleDayLabel(row: { weekday: number; startTime?: string | null; endTime?: string | null; isWorkDay?: boolean | number | null } | null | undefined): string {
  if (!row) return "sem linha";
  const work = !(row.isWorkDay === false || Number(row.isWorkDay) === 0);
  return work ? `${row.startTime ?? "?"}–${row.endTime ?? "?"}` : "folga";
}
export const weekdayShort = (wd: number): string => WEEKDAY_SHORT[wd] ?? `dia ${wd}`;

// ─── rh.noShowSkip ───────────────────────────────────────────────────────────

export const NO_SHOW_SKIP_SETTING_KEY = "rh.noShowSkip" as const;
export const NO_SHOW_SKIP_MAX = 300;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDay = (s: unknown): s is string => typeof s === "string" && DAY_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export const noShowSkipEntrySchema = z.object({
  employeeId: z.number({ error: "Escolhe a pessoa." }).int().positive(),
  until: z.string({ error: "Indica até quando (AAAA-MM-DD)." }).refine(isIsoDay, "Data inválida (AAAA-MM-DD)."),
  reason: z.string({ error: "Indica o motivo." }).trim().min(1, "Indica o motivo.").max(120, "Motivo com 120 caracteres no máximo."),
  /** quem pôs e quando (só para o ecrã) */
  byUserId: z.number().int().positive().nullish(),
  at: z.string().max(19).nullish(),
});
export type NoShowSkipEntry = z.infer<typeof noShowSkipEntrySchema>;

/** Lista da definição: no máximo uma linha por pessoa (fica a última). */
export const noShowSkipSchema = z.array(noShowSkipEntrySchema).max(NO_SHOW_SKIP_MAX, `No máximo ${NO_SHOW_SKIP_MAX} pessoas.`)
  .transform((list) => {
    const byEmp = new Map<number, NoShowSkipEntry>();
    for (const e of list) byEmp.set(e.employeeId, e);
    return Array.from(byEmp.values());
  });

/** A linha que tira a pessoa das faltas automáticas nesse dia (o "até" conta), ou null. PURA. */
export function noShowSkipFor(list: readonly NoShowSkipEntry[] | null | undefined, employeeId: number, day: string): NoShowSkipEntry | null {
  for (const e of list ?? []) if (e.employeeId === employeeId && day <= e.until) return e;
  return null;
}

/**
 * Pôr (ou mudar) a pessoa na lista: substitui a linha dela e deixa cair as
 * que já acabaram antes de hoje (o histórico fica nas Definições). PURA.
 */
export function withNoShowSkip(list: readonly NoShowSkipEntry[] | null | undefined, entry: NoShowSkipEntry, today: string): NoShowSkipEntry[] {
  return [...(list ?? []).filter((e) => e.employeeId !== entry.employeeId && e.until >= today), entry];
}
/** Tirar a pessoa da lista (volta às faltas automáticas). PURA. */
export function withoutNoShowSkip(list: readonly NoShowSkipEntry[] | null | undefined, employeeId: number): NoShowSkipEntry[] {
  return (list ?? []).filter((e) => e.employeeId !== employeeId);
}

// ─── Horários por rever ──────────────────────────────────────────────────────

/** Sem entrada no ponto há este número de dias → "ainda pica noutro sistema?". */
export const NO_CLOCK_IN_DAYS = 14;
/** Até onde se procura a última entrada no ponto (null = nenhuma neste período). */
export const NO_CLOCK_IN_LOOKBACK_DAYS = 366;

export interface ReviewEmployee {
  id: number;
  fullName: string;
  projectId?: number | null;
  /** dia (Lisboa, AAAA-MM-DD) da última entrada no ponto; null = nenhuma */
  lastCheckInDay?: string | null;
}
export interface ReviewScheduleRow {
  id: number;
  employeeId: number;
  weekday: number;
  startTime: string | null;
  endTime: string | null;
  isWorkDay: boolean | number | null;
}
export interface ReviewPerson { employeeId: number; fullName: string; projectId: number | null }
export interface ScheduleReview {
  /** `onlyDaysOff`: tem linhas, mas todas são folga (a folha conta-o como sem horário, 176 h — antes contava 0 h) */
  noSchedule: Array<ReviewPerson & { onlyDaysOff: boolean }>;
  duplicates: Array<ReviewPerson & { weekday: number; rows: Array<{ id: number; label: string }>; differ: boolean; usedRowId: number | null }>;
  invalidTimes: Array<ReviewPerson & { weekday: number; rowId: number; startTime: string; endTime: string; problem: "invalid" | "same" }>;
  noClockIn: Array<ReviewPerson & { lastCheckInDay: string | null; daysSince: number | null; skipUntil: string | null; skipReason: string | null }>;
  weekendFixed: Array<ReviewPerson & { weekdays: number[]; skipUntil: string | null }>;
}

const isWork = (r: { isWorkDay: boolean | number | null }) => !(r.isWorkDay === false || Number(r.isWorkDay) === 0);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * As listas de "Horários por rever" (funcionários ATIVOS, não extras — quem
 * chama filtra). Nada se apaga nem se corrige daqui: cada linha diz o que
 * está mal e onde se corrige (ficha → Horário, ou a lista "Fora das faltas
 * automáticas"). PURA.
 */
export function scheduleReview(input: {
  employees: readonly ReviewEmployee[];
  schedules: readonly ReviewScheduleRow[];
  today: string;
  skips?: readonly NoShowSkipEntry[];
  noClockInDays?: number;
}): ScheduleReview {
  const out: ScheduleReview = { noSchedule: [], duplicates: [], invalidTimes: [], noClockIn: [], weekendFixed: [] };
  const rowsOf = new Map<number, ReviewScheduleRow[]>();
  for (const r of input.schedules) rowsOf.set(r.employeeId, [...(rowsOf.get(r.employeeId) ?? []), r]);
  const limitDays = input.noClockInDays ?? NO_CLOCK_IN_DAYS;
  const people = [...input.employees].sort((a, b) => a.fullName.localeCompare(b.fullName, "pt"));
  for (const e of people) {
    const who: ReviewPerson = { employeeId: e.id, fullName: e.fullName, projectId: e.projectId ?? null };
    const rows = [...(rowsOf.get(e.id) ?? [])].sort((a, b) => a.id - b.id);
    const work = rows.filter(isWork);
    if (!work.length) { out.noSchedule.push({ ...who, onlyDaysOff: rows.length > 0 }); continue; }
    // dias duplicados (a mesma pessoa e o mesmo dia da semana em mais de uma linha)
    const byWd = new Map<number, ReviewScheduleRow[]>();
    for (const r of rows) byWd.set(r.weekday, [...(byWd.get(r.weekday) ?? []), r]);
    for (const [weekday, list] of Array.from(byWd.entries()).sort((a, b) => a[0] - b[0])) {
      if (list.length < 2) continue;
      const labels = list.map((r) => ({ id: r.id, label: scheduleDayLabel(r) }));
      // a ficha, a Avaliação, as faltas e a folha ficam com a de id mais baixo entre as de trabalho (workRowOn)
      const used = list.find(isWork) ?? null;
      out.duplicates.push({ ...who, weekday, rows: labels, differ: new Set(labels.map((l) => l.label)).size > 1, usedRowId: used?.id ?? null });
    }
    // horas que os leitores não percebem, ou entrada = saída (só nos dias de trabalho)
    for (const r of work) {
      const s = canonicalHhmm(r.startTime), en = canonicalHhmm(r.endTime);
      if (s == null || en == null) out.invalidTimes.push({ ...who, weekday: r.weekday, rowId: r.id, startTime: String(r.startTime ?? ""), endTime: String(r.endTime ?? ""), problem: "invalid" });
      else if (s === en) out.invalidTimes.push({ ...who, weekday: r.weekday, rowId: r.id, startTime: String(r.startTime ?? ""), endTime: String(r.endTime ?? ""), problem: "same" });
    }
    const skip = noShowSkipFor(input.skips, e.id, input.today);
    // com horário e sem entrada no ponto há N dias (ou nunca): ainda na impressão digital?
    const last = e.lastCheckInDay ?? null;
    if (last == null || last < addDays(input.today, -limitDays)) {
      out.noClockIn.push({ ...who, lastCheckInDay: last, daysSince: last ? daysBetween(last, input.today) : null, skipUntil: skip?.until ?? null, skipReason: skip?.reason ?? null });
    }
    // sábado ou domingo no horário fixo (o fim de semana roda; sem a exceção "folga" do passo 10b dá faltas falsas)
    const weekend = Array.from(new Set(work.map((r) => r.weekday).filter((wd) => wd === 0 || wd === 6))).sort((a, b) => b - a);
    if (weekend.length) out.weekendFixed.push({ ...who, weekdays: weekend, skipUntil: skip?.until ?? null });
  }
  return out;
}

// ─── Dispensa com motivo (Possíveis faltas por validar) ──────────────────────

export const FIXED_NO_SHOW_DISMISS_REASONS = ["lost_punch", "vacation", "sick", "justified", "none"] as const;
export type FixedNoShowDismissReason = (typeof FIXED_NO_SHOW_DISMISS_REASONS)[number];

export const FIXED_NO_SHOW_DISMISS_LABELS: Record<FixedNoShowDismissReason, string> = {
  lost_punch: "Não foi falta: picou noutro sistema / picagem perdida",
  vacation: "Férias",
  sick: "Baixa",
  justified: "Falta justificada",
  none: "Libertar sem motivo",
};
/** A ausência aprovada que cada motivo cria nesse dia (null = nenhuma). */
export const FIXED_NO_SHOW_DISMISS_LEAVE: Record<FixedNoShowDismissReason, "vacation" | "sick" | "other" | null> = {
  lost_punch: null, vacation: "vacation", sick: "sick", justified: "other", none: null,
};
/** Marca nas notas das dispensadas como picagem perdida: é por ela que a verificação do ponto (passo 0) as encontra. */
export const LOST_PUNCH_TAG = "[PICAGEM PERDIDA]";

/**
 * O dia da possível falta do horário fixo: o dia de calendário da entrada
 * (está nas notas, "Possível falta em AAAA-MM-DD"); sem ele, o do relatedId
 * (AAAAMMDD, o dia operacional). PURA.
 */
export function fixedNoShowDay(p: { notes?: string | null; relatedId?: number | null }): string | null {
  const m = /Possível falta em (\d{4}-\d{2}-\d{2})/.exec(String(p.notes ?? ""));
  if (m && isIsoDay(m[1])) return m[1];
  const r = String(p.relatedId ?? "");
  if (/^\d{8}$/.test(r)) {
    const d = `${r.slice(0, 4)}-${r.slice(4, 6)}-${r.slice(6, 8)}`;
    if (isIsoDay(d)) return d;
  }
  return null;
}

/**
 * O que a dispensa faz: a nota da revisão e, para Férias/Baixa/Justificada,
 * a ausência aprovada desse dia (se ainda não houver uma que o cubra). Só
 * para possíveis faltas do horário fixo ainda por validar. PURA.
 */
export function fixedNoShowDismissPlan(
  p: { id: number; employeeId: number; reason: string; status: string; notes?: string | null; relatedId?: number | null },
  reason: FixedNoShowDismissReason,
  opts: { notePrefix: string; existingLeaves?: ReadonlyArray<{ fromDate: string; toDate: string }>; extraNote?: string | null },
): { ok: false; error: string } | { ok: true; day: string | null; reviewNote: string; leave: { leaveType: "vacation" | "sick" | "other"; fromDate: string; toDate: string; notes: string } | null; leaveAlready: boolean } {
  if (p.reason !== "other" || !String(p.notes ?? "").startsWith(opts.notePrefix)) return { ok: false, error: "Só as possíveis faltas do horário fixo se dispensam com motivo." };
  if (p.status !== "pending") return { ok: false, error: "Esta possível falta já foi revista." };
  const label = FIXED_NO_SHOW_DISMISS_LABELS[reason];
  const extra = opts.extraNote?.trim() ? ` — ${opts.extraNote.trim().slice(0, 120)}` : "";
  const leaveType = FIXED_NO_SHOW_DISMISS_LEAVE[reason];
  const day = fixedNoShowDay(p);
  if (leaveType && !day) return { ok: false, error: "Não deu para saber o dia desta possível falta." };
  const tag = reason === "lost_punch" ? `${LOST_PUNCH_TAG} ` : "";
  const reviewNote = `${tag}Dispensada: ${label}${extra}`;
  if (!leaveType || !day) return { ok: true, day, reviewNote, leave: null, leaveAlready: false };
  const covered = (opts.existingLeaves ?? []).some((l) => String(l.fromDate).slice(0, 10) <= day && String(l.toDate).slice(0, 10) >= day);
  return {
    ok: true, day, reviewNote, leaveAlready: covered,
    leave: covered ? null : { leaveType, fromDate: day, toDate: day, notes: `Dispensa da possível falta #${p.id} (${label})${extra}`.slice(0, 255) },
  };
}
