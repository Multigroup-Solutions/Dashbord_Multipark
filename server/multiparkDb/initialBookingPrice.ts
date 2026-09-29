/** Read-only export of prices evidenced by reservation history. No price backfill. */
import { addDays, lisbonMidnightUtcMs } from "../../shared/lisbonDay";
import type { MultiparkDbClient, SqlParam } from "./client";

export type Query = Pick<MultiparkDbClient, "query">;
export interface Period { from: string; to: string | null; startUtc: string; endUtc: string; asOfUtc: string }
const utcSql = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

function validateDay(day: string) {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
    throw new Error(`Data inválida: ${day}. Usa AAAA-MM-DD.`);
  }
}

export function makePeriod(from = "2026-05-01", to?: string, now = new Date()): Period {
  validateDay(from);
  if (to) validateDay(to);
  if (to && to < from) throw new Error("A data final é anterior à inicial.");
  const start = lisbonMidnightUtcMs(from);
  const end = Math.min(to ? lisbonMidnightUtcMs(addDays(to, 1)) : now.getTime(), now.getTime());
  if (start >= end) throw new Error("O intervalo não contém datas anteriores ao início da execução.");
  return { from, to: to ?? null, startUtc: utcSql(start), endUtc: utcSql(end), asOfUtc: utcSql(now.getTime()) };
}

export interface BookingRow {
  id: string; allocation: string | null; park_id: string; park_name: string | null;
  city: string | null; created_at: string; status: string; currency: string;
  current_price: number | string | null; original_price_field: number | string | null;
}
export interface HistoryRow {
  id: string; booking_id: string; change_type: string; action_time: string;
  snapshot_price: unknown; modified_fields: unknown;
}
type Sql = { sql: string; params: SqlParam[] };

export function bookingPage(period: Period, cursor: string, limit: number): Sql {
  return {
    sql: `SELECT b."id", b."allocation", b."parkId" AS park_id, p."name" AS park_name,
      p."city" AS city, to_char(b."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      b."status"::text AS status, b."currency", b."bookingPrice" AS current_price,
      b."originalBookingPrice" AS original_price_field
      FROM "Booking" b LEFT JOIN "Park" p ON p."id" = b."parkId"
      WHERE b."createdAt" >= $1::timestamp AND b."createdAt" < $2::timestamp AND b."id" > $3
      ORDER BY b."id" LIMIT $4`,
    params: [period.startUtc, period.endUtc, cursor, limit],
  };
}

export function historyPage(period: Period, cursor: string, limit: number): Sql {
  return {
    // Scan once by the History primary key, rather than a query/table scan per booking.
    // Selection is ALWAYS by Booking.createdAt, never check-in or History.actionTime.
    sql: `SELECT h."id", h."bookingId" AS booking_id, h."changeType"::text AS change_type,
      to_char(h."actionTime", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS action_time,
      h."snapshot" -> 'bookingPrice' AS snapshot_price, h."modifiedFields" AS modified_fields
      FROM "History" h JOIN "Booking" b ON b."id" = h."bookingId"
      WHERE b."createdAt" >= $1::timestamp AND b."createdAt" < $2::timestamp
        AND h."id" > $3 AND h."actionTime" < $4::timestamp
      ORDER BY h."id" LIMIT $5`,
    params: [period.startUtc, period.endUtc, cursor, period.asOfUtc, limit],
  };
}

/** Strict numeric interpretation: zero is a price; null, booleans and blanks are not. */
export function price(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const firstKey = (v: Record<string, unknown>, keys: string[]) => {
  const key = keys.find(k => Object.prototype.hasOwnProperty.call(v, k));
  return key ? v[key] : undefined;
};
const beforeKeys = ["from", "old", "before", "previous", "oldValue", "prev"];
const afterKeys = ["to", "new", "after", "current", "newValue", "next", "value"];
interface Change { from: number | null; to: number | null }

/** Formats also supported by the reservation-file UI; no display/currency formatting. */
export function priceChanges(raw: unknown): Change[] {
  let value = raw;
  if (typeof value === "string") {
    const text = value;
    if (!text.trim()) return [];
    try { value = JSON.parse(text); } catch {
      return text.split(/[\n;]+/).flatMap(part => {
        const m = /^\s*bookingPrice\s*[:=]\s*(.*?)\s*(?:->|→|=>)\s*(.*?)\s*$/.exec(part);
        return m ? [{ from: price(m[1]), to: price(m[2]) }] : [];
      });
    }
  }
  const pair = (v: unknown): Change => Array.isArray(v) && v.length === 2
    ? { from: price(v[0]), to: price(v[1]) }
    : object(v) ? { from: price(firstKey(v, beforeKeys)), to: price(firstKey(v, afterKeys)) }
      : { from: null, to: price(v) };
  if (Array.isArray(value)) return value.filter(v => object(v) && firstKey(v, ["field", "name", "key", "path"]) === "bookingPrice").map(pair);
  if (object(value) && Object.prototype.hasOwnProperty.call(value, "bookingPrice")) return [pair(value.bookingPrice)];
  return [];
}

interface Evidence { id: string; at: string; value: number | null; source: string; conflict: boolean }
export interface PriceState { historyCount: number; createdCount: number; created: Evidence | null; earliest: Evidence | null }
export const emptyPriceState = (): PriceState => ({ historyCount: 0, createdCount: 0, created: null, earliest: null });

function evidence(row: HistoryRow, items: Array<{ value: number | null; source: string }>): Evidence {
  const values = items.filter((i): i is { value: number; source: string } => i.value !== null);
  const distinct = new Set(values.map(i => i.value));
  return { id: row.id, at: row.action_time, value: distinct.size === 1 ? values[0].value : null,
    source: values.map(i => i.source).join("+"), conflict: distinct.size > 1 };
}

function earliest(current: Evidence | null, next: Evidence): Evidence {
  if (!current || next.at < current.at) return next;
  if (next.at > current.at) return current;
  const chosen = next.id < current.id ? next : current;
  const conflict = current.conflict || next.conflict || (current.value !== null && next.value !== null && current.value !== next.value);
  if (conflict) return { ...chosen, value: null, conflict: true };
  // Same-time evidence with a missing value does not hide a valid record.
  return chosen.value !== null ? chosen : current.value !== null ? current : next.value !== null ? next : chosen;
}

export function addHistory(state: PriceState, row: HistoryRow): void {
  state.historyCount++;
  const snapshot = { value: price(row.snapshot_price), source: "snapshot.bookingPrice" };
  const changes = priceChanges(row.modified_fields);
  const after = changes.map(c => ({ value: c.to, source: "modifiedFields.bookingPrice.to" }));
  if (row.change_type === "CREATED") {
    state.createdCount++;
    const e = evidence(row, [snapshot, ...after]);
    state.created = earliest(state.created, e);
    if (e.value !== null || e.conflict) state.earliest = earliest(state.earliest, e);
  } else {
    // A previous value precedes the after-snapshot, but remains only a candidate
    // for the creation price when the actual CREATED record is missing.
    const before = changes.map(c => ({ value: c.from, source: "modifiedFields.bookingPrice.from" }));
    const e = evidence(row, before.some(c => c.value !== null) ? before : [snapshot, ...after]);
    if (e.value !== null || e.conflict) state.earliest = earliest(state.earliest, e);
  }
}

export function resultRow(booking: BookingRow, state: PriceState) {
  const created = state.created;
  const status = !state.historyCount ? "SEM_HISTORICO" : !created ? "SEM_REGISTO_CREATED"
    : created.conflict ? "CONFLITO_NO_CREATED" : created.value === null ? "CREATED_SEM_PRECO" : "CONFIRMADO_NO_CREATED";
  return {
    reserva_id: booking.id, referencia: booking.allocation, parque_id: booking.park_id,
    parque: booking.park_name, cidade: booking.city, criada_em_utc: booking.created_at,
    estado_reserva: booking.status, moeda_atual: booking.currency,
    booking_price_inicial: created?.value ?? null, verificacao: status,
    historico_criacao_id: created?.id ?? null, historico_criacao_em_utc: created?.at ?? null,
    fonte_preco_inicial: created?.source ?? null,
    primeiro_preco_observado: state.earliest?.value ?? null,
    primeiro_preco_historico_id: state.earliest?.id ?? null,
    primeiro_preco_em_utc: state.earliest?.at ?? null, fonte_primeiro_preco: state.earliest?.source ?? null,
    conflito_primeiro_preco: state.earliest?.conflict ? "sim" : "nao",
    booking_price_atual: price(booking.current_price), original_booking_price_campo: price(booking.original_price_field),
    registos_historico: state.historyCount, registos_created: state.createdCount,
  };
}

export async function collectPrices(db: Query, period: Period, pageSize = 2000,
  progress: (stage: string, count: number) => void = () => {}) {
  return collectPricesFromPages({
    bookings: (cursor, limit) => { const q = bookingPage(period, cursor, limit); return db.query<BookingRow>(q.sql, q.params); },
    history: (cursor, limit) => { const q = historyPage(period, cursor, limit); return db.query<HistoryRow>(q.sql, q.params); },
  }, pageSize, progress);
}

export interface PricePageReader {
  bookings(cursor: string, limit: number): Promise<BookingRow[]>;
  history(cursor: string, limit: number): Promise<HistoryRow[]>;
}

export async function collectPricesFromPages(reader: PricePageReader, pageSize = 2000,
  progress: (stage: string, count: number) => void = () => {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10000) throw new Error("page-size deve estar entre 1 e 10000.");
  const bookings = new Map<string, { booking: BookingRow; state: PriceState }>();
  let cursor = "";
  while (true) {
    const page = await reader.bookings(cursor, pageSize);
    if (!page.length) break;
    for (const booking of page) bookings.set(booking.id, { booking, state: emptyPriceState() });
    const next = page.at(-1)!.id;
    if (next === cursor) throw new Error("O cursor das reservas não avançou.");
    cursor = next;
    progress("reservas", bookings.size);
    if (page.length < pageSize) break;
  }
  cursor = "";
  let histories = 0;
  let unmatchedHistories = 0;
  while (bookings.size) {
    const page = await reader.history(cursor, pageSize);
    if (!page.length) break;
    for (const h of page) {
      const entry = bookings.get(h.booking_id);
      if (entry) addHistory(entry.state, h);
      else unmatchedHistories++;
    }
    const next = page.at(-1)!.id;
    if (next === cursor) throw new Error("O cursor do histórico não avançou.");
    cursor = next;
    histories += page.length;
    progress("historico", histories);
    if (page.length < pageSize) break;
  }
  return { rows: [...bookings.values()].map(e => resultRow(e.booking, e.state)), histories, unmatchedHistories };
}

// Text cells are protected against spreadsheet formulas; numeric values stay numeric.
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (typeof value === "string" && /^[\s]*[=+@-]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const CSV_COLUMNS = Object.keys(resultRow({} as BookingRow, emptyPriceState()));
export function renderCsv(rows: ReturnType<typeof resultRow>[]): string {
  return "\uFEFF" + [CSV_COLUMNS.map(csvCell).join(";"), ...rows.map(row => Object.values(row).map(csvCell).join(";"))].join("\r\n") + "\r\n";
}
