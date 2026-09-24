/**
 * Dias de calendário de Lisboa ↔ instantes UTC (os timestamps da BD são UTC).
 *
 * A operação vive em Europe/Lisbon, mas tudo o que gravamos (ponto,
 * check-ins de PDA, GPS e o histórico das reservas Multipark) está em UTC.
 * "O dia 23" é [23 00:00 Lisboa, 24 00:00 Lisboa) — em UTC, no verão,
 * [22 23:00, 23 23:00). Comparar com "23 00:00:00"…"23 23:59:59" UTC deixava
 * a primeira hora da noite no dia errado. PURO: sem Date local, igual no
 * cliente e no servidor (Vercel corre em UTC, o browser em Lisboa).
 */

const TZ = "Europe/Lisbon";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

let _fmt: Intl.DateTimeFormat | null = null;
function parts(ms: number): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  _fmt ??= new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const p = _fmt.formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { y: g("year"), m: g("month"), d: g("day"), h: g("hour") % 24, mi: g("minute"), s: g("second") };
}

/** Diferença (ms) entre a hora de Lisboa e UTC nesse instante (0 ou +1h). */
export function lisbonOffsetMs(ms: number): number {
  const p = parts(ms);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Instante UTC (ms) da meia-noite de Lisboa do dia `day` ("YYYY-MM-DD"). */
export function lisbonMidnightUtcMs(day: string): number {
  if (!DAY_RE.test(day)) throw new Error(`Dia inválido: ${day}`);
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d); // meia-noite UTC
  // A meia-noite de Lisboa é `guess - offset`; o offset pode mudar nessa noite
  // (mudança de hora é às 01:00 UTC), por isso confirma-se com o offset do
  // próprio instante resultante.
  let t = guess - lisbonOffsetMs(guess);
  t = guess - lisbonOffsetMs(t);
  return t;
}

/** "YYYY-MM-DD" + n dias (aritmética de calendário, sem fuso). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Todos os dias de `start` a `end` (inclusive). Máx. 400 por segurança. */
export function daysInRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

const mysql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/**
 * Intervalo UTC [start, end) de um dia (ou intervalo de dias) de Lisboa, em
 * "YYYY-MM-DD HH:MM:SS" (formato das colunas TIMESTAMP). Usar SEMPRE com
 * `>= start AND < end`.
 */
export function lisbonDayRangeUtc(startDay: string, endDay: string = startDay): { start: string; end: string; startMs: number; endMs: number } {
  const startMs = lisbonMidnightUtcMs(startDay);
  const endMs = lisbonMidnightUtcMs(addDays(endDay, 1));
  return { start: mysql(startMs), end: mysql(endMs), startMs, endMs };
}

/** Dia de Lisboa de um instante (Date, ms ou "YYYY-MM-DD HH:MM:SS" UTC). */
export function lisbonDayOf(at: Date | number | string): string {
  const ms = utcMs(at);
  const p = parts(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Horas (decimais) desde a meia-noite de Lisboa de `day` até ao instante. */
export function lisbonHoursSince(day: string, at: Date | number | string): number {
  return (utcMs(at) - lisbonMidnightUtcMs(day)) / 3_600_000;
}

/** Instante UTC em ms; strings sem fuso são UTC (como as da BD). */
export function utcMs(at: Date | number | string): number {
  if (typeof at === "number") return at;
  if (at instanceof Date) return at.getTime();
  const s = String(at);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  return new Date(s).getTime();
}
