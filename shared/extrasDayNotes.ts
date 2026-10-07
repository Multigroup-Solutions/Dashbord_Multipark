/**
 * Notas internas do dia de trabalho (Extras-dia → Pressão; pedido 4, Jorge,
 * 7 out 2026: "ao selecionar o dia, aparece a info e deve dar para guardar
 * várias notas para esse dia"). Regras PURAS, partilhadas pelo servidor
 * (server/extrasDayNotes.ts) e pelo ecrã (PressureTab / DayNotesCard).
 *
 *  - uma nota é de uma CIDADE e de um DIA DE TRABALHO (o dia de calendário em
 *    que o dia operacional começa — 03h desse dia → 03h do seguinte), com hora
 *    opcional em horas operacionais 3–26 (24–26 = 00h–02h da madrugada
 *    seguinte, como no resto do Extras-dia);
 *  - ler: quem vê o Extras-dia (no âmbito da cidade); escrever: quem o edita;
 *    arquivar: o autor ou admin+ ("apagar" = arquivar, nunca se perde);
 *  - no mapa da Pressão (dia da semana × hora de RELÓGIO), a célula mostra as
 *    notas das últimas datas com esse dia da semana (e essa hora, se a nota
 *    tiver hora); as horas 00h–02h de uma célula são da noite do dia anterior.
 */
import { roleRank } from "./access";

export const DAY_NOTE_MAX_CHARS = 2000;
export const DAY_NOTE_MIN_HOUR = 3;
export const DAY_NOTE_MAX_HOUR = 26;
/** Quantas datas anteriores (mesmo dia da semana) o detalhe de uma célula mostra. */
export const CELL_NOTE_DATES = 4;
/** Semanas de notas que o separador Pressão carrega para o detalhe das células. */
export const CELL_NOTE_WEEKS = 8;

export interface DayNoteLike {
  id: number;
  workDate: string;
  hour: number | null;
  createdAt: string;
}

/** Corpo da nota limpo, ou o erro em PT-PT. PURA. */
export function normalizeDayNoteBody(body: string): { ok: true; body: string } | { ok: false; error: string } {
  const text = String(body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, error: "Escreve a nota." };
  if (text.length > DAY_NOTE_MAX_CHARS) return { ok: false, error: `A nota tem mais de ${DAY_NOTE_MAX_CHARS} caracteres.` };
  return { ok: true, body: text };
}

/** Hora operacional válida (3–26) ou null. PURA. */
export function isDayNoteHour(h: unknown): h is number {
  return typeof h === "number" && Number.isInteger(h) && h >= DAY_NOTE_MIN_HOUR && h <= DAY_NOTE_MAX_HOUR;
}

/** As horas que o seletor oferece (03h … 02h+1). */
export const DAY_NOTE_HOURS: readonly number[] = Array.from({ length: DAY_NOTE_MAX_HOUR - DAY_NOTE_MIN_HOUR + 1 }, (_, i) => i + DAY_NOTE_MIN_HOUR);

/** "02h (madrugada)" para 26, "18h" para 18. PURA. */
export function dayNoteHourLabel(hour: number): string {
  const label = `${String(hour % 24).padStart(2, "0")}h`;
  return hour >= 24 ? `${label} (madrugada)` : label;
}

/** Quem pode arquivar uma nota: o autor ou admin+. PURA. */
export function canArchiveDayNote(viewer: { id: number; role: string }, note: { authorId: number }): boolean {
  return viewer.id === note.authorId || roleRank(viewer.role) >= roleRank("admin");
}

/** Dia da semana ISO (1 = segunda … 7 = domingo) de "AAAA-MM-DD". PURA. */
export function isoWeekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
}

/**
 * Célula do mapa da Pressão (dia da semana e hora de RELÓGIO) → dia da semana
 * do dia operacional e hora operacional: 00h–02h de quinta são a noite de
 * quarta (horas 24–26). PURA.
 */
export function cellToOperational(weekday: number, hour: number): { weekday: number; hour: number } {
  if (hour < DAY_NOTE_MIN_HOUR) return { weekday: weekday === 1 ? 7 : weekday - 1, hour: hour + 24 };
  return { weekday, hour };
}

/**
 * Notas a mostrar no detalhe de uma célula: do mesmo dia da semana
 * operacional, sem hora (do dia todo) ou com essa hora; só das últimas
 * `maxDates` datas com notas (mais recentes primeiro). PURA.
 */
export function notesForCell<T extends DayNoteLike>(notes: readonly T[], weekday: number, hour: number, maxDates = CELL_NOTE_DATES): T[] {
  const op = cellToOperational(weekday, hour);
  const hits = notes.filter((n) => isoWeekdayOf(n.workDate) === op.weekday && (n.hour == null || n.hour === op.hour));
  const dates = Array.from(new Set(hits.map((n) => n.workDate))).sort().reverse().slice(0, maxDates);
  const keep = new Set(dates);
  return hits
    .filter((n) => keep.has(n.workDate))
    .sort((a, b) => b.workDate.localeCompare(a.workDate) || (a.hour ?? -1) - (b.hour ?? -1) || a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
}

/** Notas de um dia, por hora (as do dia todo primeiro) e depois pela ordem em que foram escritas. PURA. */
export function sortDayNotes<T extends DayNoteLike>(notes: readonly T[]): T[] {
  return notes.slice().sort((a, b) => (a.hour ?? -1) - (b.hour ?? -1) || a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
}
