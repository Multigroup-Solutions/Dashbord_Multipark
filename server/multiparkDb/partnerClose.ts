/**
 * FECHO DO MÊS DE PARCEIROS — lado da Multipark (só leitura; regras de read.ts).
 * Reserva a reserva, as de parceiro dos NOSSOS parques CONCLUÍDAS com saída no
 * mês (hora de Lisboa): valor (o que o parceiro recebeu, senão o preço), o
 * NOSSO (partnerAmountDue; sem ele, pela taxa gravada) e as faturas emitidas
 * dessa reserva ("Billing" emitido, sem notas de crédito).
 * Também a tabela "Partner" (id por parque → empresa userId + nome), para
 * traduzir o partnerId que a nossa memória do webhook guarda.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, safeMultiparkRead, type MultiparkRead } from "./read";
import { buildParksSql, mapParks } from "./dayBookings";

type Row = Record<string, unknown>;
type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const CLOSE_ROWS_LIMIT = 20_000;
const VALUE = `COALESCE(b."partnerContributedAmount", b."bookingPrice")`;
const OURS = `COALESCE(b."partnerAmountDue", CASE
    WHEN b."partnerFeeType"::text = 'PERCENTAGE' AND b."partnerFeeValue" IS NOT NULL THEN ${VALUE} * (1 - b."partnerFeeValue" / 100.0)
    WHEN b."partnerFeeType"::text = 'FIXED' AND b."partnerFeeValue" IS NOT NULL THEN ${VALUE} - b."partnerFeeValue"
  END)`;

/** Reservas de parceiro concluídas com saída em [start, end). PURA. */
export function buildPartnerCloseSql(o: { parkIds: readonly string[]; start: string; end: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const start = p.add(o.start), end = p.add(o.end);
  const parks = o.parkIds.map((id) => p.add(id)).join(", ");
  return {
    sql: [
      `SELECT b."id" AS id, b."allocation" AS code, b."parkId" AS park_id, b."partnerId" AS partner_id, pa."userId" AS partner_user_id,`,
      `  NULLIF(pa."name", '') AS partner_name, ${VALUE} AS value, ${OURS} AS ours, (b."partnerAmountDue" IS NULL) AS due_missing,`,
      `  to_char(b."checkOut", 'YYYY-MM-DD HH24:MI:SS') AS check_out,`,
      `  (SELECT count(*) FROM "Billing" y WHERE y."bookingId" = b."id" AND y."emited" = true`,
      `     AND upper(COALESCE(y."invoiceExpressType", '')) NOT LIKE '%CREDIT%') AS invoices`,
      `FROM "Booking" b JOIN "Partner" pa ON pa."id" = b."partnerId"`,
      `WHERE b."parkId" IN (${parks}) AND b."status"::text = 'CHECKED_OUT'`,
      `  AND b."checkOut" >= ${start}::timestamp AND b."checkOut" < ${end}::timestamp`,
      `LIMIT ${p.add(CLOSE_ROWS_LIMIT)}`,
    ].join("\n"),
    params: p.values,
  };
}

/** Estado atual de reservas pedidas por id (as que a nossa cópia dá como do mês). PURA. */
export function buildBookingsStateSql(ids: readonly string[]): { sql: string; params: SqlParam[] } {
  if (!ids.length) throw new Error("Sem reservas.");
  const p = new ParamList();
  const list = ids.map((id) => p.add(id)).join(", ");
  return {
    sql: `SELECT b."id" AS id, b."status"::text AS status, to_char(b."checkOut", 'YYYY-MM-DD HH24:MI:SS') AS check_out, b."partnerId" AS partner_id FROM "Booking" b WHERE b."id" IN (${list}) LIMIT ${p.add(ids.length)}`,
    params: p.values,
  };
}

export interface MpCloseBooking {
  id: string; code: string | null; parkId: string | null;
  partnerId: string; partnerKey: string; partnerName: string | null;
  value: number; ours: number | null; dueMissing: boolean; checkOut: string | null; invoices: number;
}
export interface MpPartnerRow { id: string; userId: string; name: string | null }
export interface MpBookingState { id: string; status: string | null; checkOut: string | null; partnerId: string | null }

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string | null => (v == null || String(v).trim() === "" ? null : String(v));
const bool = (v: unknown) => v === true || v === "t" || v === 1 || v === "true";

export function mapCloseBooking(r: Row): MpCloseBooking | null {
  const id = str(r.id), partnerId = str(r.partner_id);
  if (!id || !partnerId) return null;
  return {
    id, code: str(r.code), parkId: str(r.park_id), partnerId, partnerKey: str(r.partner_user_id) ?? partnerId, partnerName: str(r.partner_name),
    value: Math.round(num(r.value) * 100) / 100, ours: r.ours == null ? null : Math.round(num(r.ours) * 100) / 100,
    dueMissing: bool(r.due_missing), checkOut: str(r.check_out), invoices: Math.round(num(r.invoices)),
  };
}

export interface PartnerCloseLive { parkIds: string[]; bookings: MpCloseBooking[]; partners: MpPartnerRow[]; truncated: boolean }

/** Lado da Multipark do mês (todas as cidades ou as do âmbito). Nunca lança. */
export async function readPartnerCloseLive(o: { start: string; end: string; cities?: string[] }, query: Query = multiparkDbQuery): Promise<MultiparkRead<PartnerCloseLive>> {
  return safeMultiparkRead("fecho de parceiros", async () => {
    const parks = mapParks(await query(buildParksSql().sql), o.cities).filter((x) => x.ours);
    const parkIds = parks.map((x) => x.id);
    const partners = (await query(`SELECT pa."id" AS id, pa."userId" AS user_id, NULLIF(pa."name", '') AS name FROM "Partner" pa LIMIT 5000`))
      .map((r) => ({ id: String(r.id ?? ""), userId: String(r.user_id ?? r.id ?? ""), name: str(r.name) }))
      .filter((x) => x.id);
    if (!parkIds.length) return { parkIds, bookings: [], partners, truncated: false };
    const { sql, params } = buildPartnerCloseSql({ parkIds, start: o.start, end: o.end });
    const rows = await query(sql, params);
    return { parkIds, bookings: rows.map(mapCloseBooking).filter((x): x is MpCloseBooking => !!x), partners, truncated: rows.length >= CLOSE_ROWS_LIMIT };
  });
}

/** Estado atual na Multipark de reservas pedidas (lotes de 1000). Nunca lança. */
export async function readBookingsState(ids: readonly string[], query: Query = multiparkDbQuery): Promise<MultiparkRead<Map<string, MpBookingState>>> {
  return safeMultiparkRead("estado das reservas", async () => {
    const out = new Map<string, MpBookingState>();
    const uniq = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < uniq.length; i += 1000) {
      const { sql, params } = buildBookingsStateSql(uniq.slice(i, i + 1000));
      for (const r of await query(sql, params)) {
        const id = str(r.id);
        if (id) out.set(id, { id, status: str(r.status), checkOut: str(r.check_out), partnerId: str(r.partner_id) });
      }
    }
    return out;
  });
}
