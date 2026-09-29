/**
 * Passagem de turno — regras PURAS partilhadas entre cliente e servidor.
 *
 * Turnos (server/extrasDia.ts SHIFT_BOUNDS): manhã 03:00→15:00, noite
 * 15:00→03:00 do dia seguinte, sempre em Europe/Lisbon. A noite pertence ao
 * dia em que COMEÇA: às 01:30 de dia 24 ainda se está a fechar a noite de 23.
 * Nada aqui usa o relógio/fuso do browser nem do servidor (Vercel = UTC).
 */
import { addDays, lisbonDayOf, lisbonMidnightUtcMs, lisbonOffsetMs } from "./lisbonDay";

export type HandoverShift = "morning" | "night";
export const HANDOVER_CITIES = ["lisbon", "porto", "faro"] as const;
export type HandoverCity = (typeof HANDOVER_CITIES)[number];
export const HANDOVER_CITY_LABELS: Record<HandoverCity, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };

/** Hora a que a manhã começa / a noite acaba (03:00 de Lisboa). */
export const OPERATIONAL_DAY_START_HOUR = 3;
/** Hora a que a noite começa (15:00 de Lisboa). */
export const NIGHT_START_HOUR = 15;

/** Hora local de Lisboa (0–23, decimal) de um instante. */
function lisbonHourOf(ms: number): number {
  const day = lisbonDayOf(ms);
  // Horas de relógio: desloca pelo offset do instante, não pelo da meia-noite
  // (nos dias de mudança de hora a diferença é de 23h/25h).
  const local = ms + lisbonOffsetMs(ms);
  const [y, m, d] = day.split("-").map(Number);
  return (local - Date.UTC(y, m - 1, d)) / 3_600_000;
}

/**
 * Turno operacional em curso num instante: `{ date, shift }` em que `date` é o
 * dia de Lisboa em que o turno COMEÇOU. 00:00–03:00 → noite do dia anterior.
 */
export function operationalShift(now: Date | number = Date.now()): { date: string; shift: HandoverShift } {
  const ms = typeof now === "number" ? now : now.getTime();
  const day = lisbonDayOf(ms);
  const h = lisbonHourOf(ms);
  if (h < OPERATIONAL_DAY_START_HOUR) return { date: addDays(day, -1), shift: "night" };
  return { date: day, shift: h < NIGHT_START_HOUR ? "morning" : "night" };
}

/** Instante UTC (ms) da hora de relógio `hour` (pode passar de 24) do dia `day` em Lisboa. */
export function lisbonLocalTimeUtcMs(day: string, hour: number): number {
  const extraDays = Math.floor(hour / 24);
  const d = addDays(day, extraDays);
  const h = hour - extraDays * 24;
  const mid = lisbonMidnightUtcMs(d);
  // Primeira aproximação com o offset da meia-noite; corrige se a hora mudou
  // entre a meia-noite e essa hora (último domingo de março/outubro, 01:00 UTC).
  let t = mid + h * 3_600_000;
  t -= lisbonOffsetMs(t) - lisbonOffsetMs(mid);
  return t;
}

const mysqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/**
 * Janela UTC [start, end) do dia OPERACIONAL `day`: das 03:00 desse dia às
 * 03:00 do dia seguinte (manhã + noite completa), em "YYYY-MM-DD HH:MM:SS".
 */
export function operationalDayWindowUtc(day: string): { start: string; end: string; startMs: number; endMs: number } {
  const startMs = lisbonLocalTimeUtcMs(day, OPERATIONAL_DAY_START_HOUR);
  const endMs = lisbonLocalTimeUtcMs(day, 24 + OPERATIONAL_DAY_START_HOUR);
  return { start: mysqlTs(startMs), end: mysqlTs(endMs), startMs, endMs };
}

/** Último dia aceite numa passagem de turno: hoje (Lisboa) + 1. */
export function maxHandoverDate(now: Date | number = Date.now()): string {
  return addDays(lisbonDayOf(typeof now === "number" ? now : now.getTime()), 1);
}

// ─── Integridade (lock otimista + bloqueio de 24h) ──────────────────────────

export const HANDOVER_CONFLICT_MESSAGE = "Outra pessoa alterou esta passagem — recarrega";
export const HANDOVER_EXISTS_MESSAGE = "Esta passagem de turno já foi criada por outra pessoa — recarrega";
export const HANDOVER_LOCKED_MESSAGE = "Passaram mais de 24h desde que esta passagem foi criada — só um supervisor a pode alterar";
export const HANDOVER_EDIT_WINDOW_MINUTES = 24 * 60;

export type HandoverWriteDecision =
  | { ok: true; mode: "insert" | "update" }
  | { ok: false; code: "CONFLICT" | "FORBIDDEN"; message: string };

/**
 * Decide se a gravação pode avançar.
 *  - `existing`: registo atual (versão + idade em minutos) ou null.
 *  - `expectedVersion`: versão que o formulário carregou (null = registo novo).
 */
export function decideHandoverWrite(
  existing: { version: number; ageMinutes: number } | null,
  expectedVersion: number | null | undefined,
  canEditOld: boolean,
): HandoverWriteDecision {
  if (!existing) {
    // O formulário tinha um registo que entretanto desapareceu → recarregar.
    if (expectedVersion != null) return { ok: false, code: "CONFLICT", message: HANDOVER_CONFLICT_MESSAGE };
    return { ok: true, mode: "insert" };
  }
  if (expectedVersion == null) return { ok: false, code: "CONFLICT", message: HANDOVER_EXISTS_MESSAGE };
  if (Number(existing.version) !== Number(expectedVersion)) return { ok: false, code: "CONFLICT", message: HANDOVER_CONFLICT_MESSAGE };
  if (!canEditOld && existing.ageMinutes > HANDOVER_EDIT_WINDOW_MINUTES) return { ok: false, code: "FORBIDDEN", message: HANDOVER_LOCKED_MESSAGE };
  return { ok: true, mode: "update" };
}

/** Campos que mudaram entre o registo anterior e o novo (para o log de atividade). */
export function diffHandoverFields(before: Record<string, unknown> | null, after: Record<string, unknown>): string[] {
  const norm = (v: unknown): string => {
    if (v == null || v === "") return "";
    if (typeof v === "boolean") return v ? "1" : "0";
    if (typeof v === "number") return String(v);
    if (typeof v === "object") return JSON.stringify(v);
    const s = String(v);
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) ? String(n) : s;
  };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if (norm(before?.[k]) !== norm(v)) changed.push(k);
  }
  return changed;
}

// ─── Cidade por omissão ─────────────────────────────────────────────────────

/** Chave de cidade da passagem a partir do nome do centro de custos. */
export function handoverCityKey(name: string | null | undefined): HandoverCity | null {
  const n = String(name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  if (/^lisb/.test(n)) return "lisbon";
  if (n === "porto" || n === "oporto") return "porto";
  if (n === "faro") return "faro";
  return null;
}

/** Cidades que o utilizador pode escolher (todas quando tem acesso global). */
export function allowedHandoverCities(access: { all: boolean; cityNames?: string[]; cityName?: string } | null | undefined): HandoverCity[] {
  if (!access) return [];
  if (access.all) return [...HANDOVER_CITIES];
  const names = access.cityNames ?? (access.cityName ? [access.cityName] : []);
  const keys = names.map(handoverCityKey).filter((k): k is HandoverCity => k != null);
  return HANDOVER_CITIES.filter((c) => keys.includes(c));
}

/** Uma cidade → essa; várias → a última usada se ainda for permitida, senão a primeira. */
export function defaultHandoverCity(allowed: HandoverCity[], lastUsed: string | null | undefined): HandoverCity | null {
  if (allowed.length === 0) return null;
  if (allowed.length === 1) return allowed[0];
  return allowed.includes(lastUsed as HandoverCity) ? (lastUsed as HandoverCity) : allowed[0];
}

// ─── Turno de cada pessoa no resumo do dia ──────────────────────────────────

export interface ShiftAssignmentLike { employeeId: number | null; personName: string | null; city: string | null; shift: string }

/**
 * Turno de uma pessoa: pelo id do funcionário quando há; só quando a pessoa não
 * tem id (ou a escala não o tem) se cai no nome — e aí também pela cidade.
 */
export function findPersonShift(
  assignments: ShiftAssignmentLike[],
  person: { employeeId: number | null | undefined; name: string },
  city?: string | null,
): ShiftAssignmentLike | undefined {
  if (person.employeeId != null) {
    const byId = assignments.find((a) => a.employeeId === person.employeeId);
    if (byId) return byId;
  }
  const name = person.name.trim().toLowerCase();
  if (!name) return undefined;
  return assignments.find((a) =>
    (person.employeeId == null || a.employeeId == null) &&
    (a.personName ?? "").trim().toLowerCase() === name &&
    (!city || a.city === city));
}
