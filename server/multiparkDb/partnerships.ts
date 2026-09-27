/**
 * PARCERIAS (fase 6) — parceiros (agências e agregadores) e parques lidos AO
 * VIVO da BD da Multipark (só leitura; nada se copia para a nossa BD). Segue
 * as regras de read.ts: SQL parametrizado, construtores e mapeadores PUROS,
 * LIMIT sempre, nunca lança (`{ available:false, reason }`).
 *
 * Decisões do dono (27 set 2026):
 *   - "Parceiros" = agências de viagens + agregadores ("Partner", uma linha
 *     por parque com a sua taxa: feeType / feePercentage / feeFixedValue);
 *     só contam os parceiros dos NOSSOS parques;
 *   - "Parques" = os nossos e os de terceiros em que agregamos (marketplace),
 *     classificados por shared/multiparkParks.ts (o classificador único);
 *   - as percentagens vêm da BD da Multipark; na reserva
 *     "partnerContributedAmount" = o que o parceiro recebeu do cliente e
 *     "partnerAmountDue" = o que fica para nós;
 *   - clientes Pro e avenças NÃO entram aqui (CRM Pro).
 * Mês = mês (Lisboa) da ENTRADA do carro. Os totais são somados em SQL.
 *
 * A página de CRM de cada parceiro/parque (/clientes/parceiros/:userId,
 * /clientes/parques/:parkId) tem o detalhe mensal e as últimas reservas —
 * aqui fica só a lista com os totais (estrutura; mais contas virão depois).
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, safeMultiparkRead, type MultiparkRead } from "./read";
import { buildParksSql, mapParks, type DayPark } from "./dayBookings";
import { lisbonDayOf, lisbonMidnightUtcMs } from "../../shared/lisbonDay";
import { MARKETPLACE_COMMISSION, marketplaceSplit } from "../../shared/marketplace";

type Row = Record<string, unknown>;
type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

/** Reserva que conta: nem cancelada nem pendente (compra online por acabar). */
export const LIVE = `b."status"::text NOT IN ('CANCELLED', 'PENDING')`;
/** Valor da reserva de um parceiro: o que ele recebeu; sem isso, o preço. */
export const PARTNER_VALUE = `COALESCE(b."partnerContributedAmount", b."bookingPrice")`;
/** Reservas que NÓS levámos a um parque que não é nosso (marketplace). */
export const OUR_SALE = `(b."origin"::text = 'MARKETPLACE' OR COALESCE(b."commissionAmount", 0) > 0)`;
export const PARTNER_ROWS_LIMIT = 5000;
export const PARK_ROWS_LIMIT = 1000;

// ─── Períodos (PURO) ────────────────────────────────────────────────────────

export interface LivePeriods {
  /** Mês corrente de Lisboa "AAAA-MM". */
  thisMonth: string;
  /** 1.º dos 12 meses (o corrente e os 11 anteriores) "AAAA-MM". */
  from12: string;
  /** Instantes UTC ("AAAA-MM-DD HH:MM:SS") dos limites em Lisboa. */
  since12: string;
  monthStart: string;
  until: string;
}

const utcText = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Mês corrente e últimos 12 meses (Lisboa) com os limites em UTC. PURA. */
export function livePeriods(now: Date = new Date()): LivePeriods {
  const thisMonth = lisbonDayOf(now).slice(0, 7);
  const from12 = shiftMonth(thisMonth, -11);
  return {
    thisMonth,
    from12,
    since12: utcText(lisbonMidnightUtcMs(`${from12}-01`)),
    monthStart: utcText(lisbonMidnightUtcMs(`${thisMonth}-01`)),
    until: utcText(lisbonMidnightUtcMs(`${shiftMonth(thisMonth, 1)}-01`)),
  };
}

// ─── SQL (PURO) ─────────────────────────────────────────────────────────────

/**
 * Linhas "Partner" dos parques pedidos, cada uma com os totais do mês e dos
 * últimos 12 meses (entrada em Lisboa), somados na BD.
 */
export function buildPartnerTotalsSql(parkIds: string[], p: LivePeriods): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  const ps = new ParamList();
  const since = ps.add(p.since12), until = ps.add(p.until), month = ps.add(p.monthStart);
  const parks = parkIds.map((id) => ps.add(id)).join(", ");
  const lim = ps.add(PARTNER_ROWS_LIMIT);
  const inMonth = `${LIVE} AND b."checkIn" >= ${month}::timestamp`;
  return {
    sql: [
      `SELECT pa."id" AS partner_id, pa."userId" AS user_id, pa."parkId" AS park_id, NULLIF(pa."name", '') AS name,`,
      `  pa."partnerType"::text AS partner_type, pa."isActive" AS active,`,
      `  pa."feeType"::text AS fee_type, pa."feePercentage" AS fee_pct, pa."feeFixedValue" AS fee_fixed,`,
      `  count(b."id") FILTER (WHERE ${inMonth}) AS m_bookings,`,
      `  SUM(${PARTNER_VALUE}) FILTER (WHERE ${inMonth}) AS m_value,`,
      `  SUM(b."partnerAmountDue") FILTER (WHERE ${inMonth}) AS m_ours,`,
      `  count(b."id") FILTER (WHERE ${inMonth} AND b."partnerAmountDue" IS NULL) AS m_missing,`,
      `  count(b."id") FILTER (WHERE ${LIVE}) AS y_bookings,`,
      `  SUM(${PARTNER_VALUE}) FILTER (WHERE ${LIVE}) AS y_value,`,
      `  SUM(b."partnerAmountDue") FILTER (WHERE ${LIVE}) AS y_ours,`,
      `  count(b."id") FILTER (WHERE ${LIVE} AND b."partnerAmountDue" IS NULL) AS y_missing`,
      `FROM "Partner" pa`,
      `LEFT JOIN "Booking" b ON b."partnerId" = pa."id" AND b."checkIn" >= ${since}::timestamp AND b."checkIn" < ${until}::timestamp`,
      `WHERE pa."parkId" IN (${parks})`,
      `GROUP BY pa."id", pa."userId", pa."parkId", pa."name", pa."partnerType", pa."isActive", pa."feeType", pa."feePercentage", pa."feeFixedValue"`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: ps.values,
  };
}

/**
 * Totais do mês corrente por parque: todas as reservas (para os nossos) e só
 * as que NÓS levámos (para os de terceiros), com a nossa comissão.
 */
export function buildParkTotalsSql(parkIds: string[], p: LivePeriods): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  const ps = new ParamList();
  const month = ps.add(p.monthStart), until = ps.add(p.until);
  const parks = parkIds.map((id) => ps.add(id)).join(", ");
  const lim = ps.add(PARK_ROWS_LIMIT);
  return {
    sql: [
      `SELECT b."parkId" AS park_id,`,
      `  count(*) FILTER (WHERE ${LIVE}) AS bookings,`,
      `  SUM(b."bookingPrice") FILTER (WHERE ${LIVE}) AS value,`,
      `  count(*) FILTER (WHERE ${LIVE} AND b."partnerId" IS NOT NULL) AS partner_bookings,`,
      `  count(*) FILTER (WHERE ${LIVE} AND ${OUR_SALE}) AS sale_bookings,`,
      `  SUM(b."bookingPrice") FILTER (WHERE ${LIVE} AND ${OUR_SALE}) AS sale_value,`,
      `  SUM(b."commissionAmount") FILTER (WHERE ${LIVE} AND ${OUR_SALE}) AS sale_commission`,
      `FROM "Booking" b`,
      `WHERE b."parkId" IN (${parks}) AND b."checkIn" >= ${month}::timestamp AND b."checkIn" < ${until}::timestamp`,
      `GROUP BY b."parkId"`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: ps.values,
  };
}

// ─── Mapeadores (PUROS) ─────────────────────────────────────────────────────

export type LivePartnerType = "AGGREGATOR" | "AGENCY" | "PARTNER";
const TYPE_ORDER: LivePartnerType[] = ["AGGREGATOR", "AGENCY", "PARTNER"];

/** `missing` = reservas sem "partnerAmountDue" gravado (o nosso fica incompleto). */
export interface LiveTotals { bookings: number; value: number | null; ours: number | null; missing: number }
export interface LivePartnerPark {
  partnerId: string; parkId: string; parkName: string; city: string | null; active: boolean;
  feeType: string | null; feePct: number | null; feeFixed: number | null;
}
export interface LivePartner {
  /** "Partner".userId — a empresa (é o :id da página do CRM). */
  userId: string;
  name: string;
  type: LivePartnerType;
  active: boolean;
  parks: LivePartnerPark[];
  thisMonth: LiveTotals;
  last12: LiveTotals;
}

const emptyTotals = (): LiveTotals => ({ bookings: 0, value: 0, ours: 0, missing: 0 });
function addTotals(t: LiveTotals, bookings: unknown, value: unknown, ours: unknown, missing: unknown) {
  t.bookings += num(bookings) ?? 0;
  t.value = round((t.value ?? 0) + (num(value) ?? 0));
  t.ours = round((t.ours ?? 0) + (num(ours) ?? 0));
  t.missing += num(missing) ?? 0;
}

/**
 * Linhas "Partner" (já com totais) → uma empresa por userId, só nos parques
 * dados (os NOSSOS no âmbito de cidade). PURA.
 */
export function groupLivePartners(rows: Row[], parks: Array<Pick<DayPark, "id" | "name" | "cityName">>): LivePartner[] {
  const parkOf = new Map(parks.map((p) => [p.id, p]));
  const out = new Map<string, LivePartner & { types: Map<LivePartnerType, number> }>();
  for (const r of rows) {
    const userId = str(r.user_id), partnerId = str(r.partner_id), parkId = str(r.park_id);
    if (!userId || !partnerId || !parkId) continue;
    const park = parkOf.get(parkId);
    if (!park) continue;
    let g = out.get(userId);
    if (!g) {
      g = { userId, name: "", type: "AGENCY", active: false, parks: [], thisMonth: emptyTotals(), last12: emptyTotals(), types: new Map() };
      out.set(userId, g);
    }
    const t = (str(r.partner_type) ?? "AGENCY").toUpperCase() as LivePartnerType;
    g.types.set(t, (g.types.get(t) ?? 0) + 1);
    if (!g.name) g.name = str(r.name) ?? "";
    const active = bool(r.active);
    if (active) g.active = true;
    g.parks.push({ partnerId, parkId, parkName: park.name, city: park.cityName, active, feeType: str(r.fee_type), feePct: num(r.fee_pct), feeFixed: num(r.fee_fixed) });
    addTotals(g.thisMonth, r.m_bookings, r.m_value, r.m_ours, r.m_missing);
    addTotals(g.last12, r.y_bookings, r.y_value, r.y_ours, r.y_missing);
  }
  return [...out.values()].map(({ types, ...g }) => {
    // tipo mais frequente (empate: agregador > agência > parceiro)
    const type = [...types.entries()].sort((a, b) => b[1] - a[1] || TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))[0]?.[0] ?? "AGENCY";
    return { ...g, type, name: g.name || "Parceiro sem nome", parks: g.parks.sort((a, b) => a.parkName.localeCompare(b.parkName, "pt")) };
  }).sort((a, b) => b.last12.bookings - a.last12.bookings || a.name.localeCompare(b.name, "pt"));
}

export interface LivePark {
  id: string; name: string; city: string | null; label: string; ours: boolean; status: string | null; listingType: string | null;
  /** Mês corrente: nossos = todas as reservas; terceiros = só as que NÓS levámos. */
  bookings: number; value: number | null;
  /** Nossos: das quais vieram de parceiros. */
  partnerBookings: number;
  /**
   * Terceiros (somos o marketplace): divisão do valor pela regra única
   * (MARKETPLACE_COMMISSION — 20 % nosso, 80 % do parque).
   */
  ourShare: number | null;
  parkShare: number | null;
  /** Terceiros: a comissão gravada nas reservas da Multipark ("commissionAmount"), só para comparar. */
  commission: number | null;
}

/** Parques + totais do mês → linhas da tab "Parques". PURA. */
export function mapLiveParks(parks: DayPark[], rows: Row[], rate: number = MARKETPLACE_COMMISSION): { ours: LivePark[]; third: LivePark[] } {
  const byPark = new Map(rows.map((r) => [str(r.park_id) ?? "", r]));
  const ours: LivePark[] = [], third: LivePark[] = [];
  for (const p of parks) {
    const r = byPark.get(p.id) ?? {};
    const base = { id: p.id, name: p.name, city: p.cityName, label: p.label, ours: p.ours, status: p.status, listingType: p.listingType };
    if (p.ours) {
      ours.push({ ...base, bookings: num(r.bookings) ?? 0, value: round(num(r.value) ?? 0), partnerBookings: num(r.partner_bookings) ?? 0, ourShare: null, parkShare: null, commission: null });
    } else {
      const value = round(num(r.sale_value) ?? 0);
      const split = marketplaceSplit(value, rate);
      third.push({ ...base, bookings: num(r.sale_bookings) ?? 0, value, partnerBookings: 0, ourShare: split.ours, parkShare: split.park, commission: round(num(r.sale_commission) ?? 0) });
    }
  }
  third.sort((a, b) => b.bookings - a.bookings || a.name.localeCompare(b.name, "pt"));
  return { ours, third };
}

// ─── Ligação aos registos das Parcerias (nossa BD) — PURO ───────────────────

export interface PartnershipRecordLite { id: number; name: string; partnerType: string | null; partnerStatus: string | null; multiparkPartnerId: string | null }

/**
 * Registo nas Parcerias de cada parceiro, SÓ pelo id da Multipark gravado em
 * partnerships.multiparkPartnerId (o userId da empresa ou o id de uma das
 * linhas "Partner"). Sem aliases nem nomes. PURA.
 */
export function linkRecords<T extends Pick<LivePartner, "userId" | "parks">>(partners: T[], records: PartnershipRecordLite[]): Array<T & { record: Omit<PartnershipRecordLite, "multiparkPartnerId"> | null }> {
  const byMpId = new Map<string, PartnershipRecordLite>();
  for (const r of records) {
    const k = (r.multiparkPartnerId ?? "").trim().toLowerCase();
    if (k && !byMpId.has(k)) byMpId.set(k, r);
  }
  return partners.map((p) => {
    const hit = [p.userId, ...p.parks.map((x) => x.partnerId)].map((id) => byMpId.get(id.trim().toLowerCase())).find(Boolean) ?? null;
    return { ...p, record: hit ? { id: hit.id, name: hit.name, partnerType: hit.partnerType, partnerStatus: hit.partnerStatus } : null };
  });
}

/** Sem totais financeiros: sem euros nem taxas (são condições comerciais). PURA. */
export function hideLiveMoney<D extends { partners: LivePartner[]; parks: { ours: LivePark[]; third: LivePark[] } }>(d: D, canSeeTotals: boolean): D {
  if (canSeeTotals) return d;
  const t = (x: LiveTotals): LiveTotals => ({ ...x, value: null, ours: null });
  const pk = (x: LivePark): LivePark => ({ ...x, value: null, ourShare: null, parkShare: null, commission: null });
  return {
    ...d,
    partners: d.partners.map((p) => ({ ...p, thisMonth: t(p.thisMonth), last12: t(p.last12), parks: p.parks.map((x) => ({ ...x, feeType: null, feePct: null, feeFixed: null })) })),
    parks: { ours: d.parks.ours.map(pk), third: d.parks.third.map(pk) },
  };
}

// ─── Leitura (nunca lança) ──────────────────────────────────────────────────

export interface PartnershipsLive {
  periods: Pick<LivePeriods, "thisMonth" | "from12">;
  /** Nossa parte nos parques de terceiros (0–1). */
  marketplaceRate: number;
  partners: LivePartner[];
  parks: { ours: LivePark[]; third: LivePark[] };
}

/** Parceiros e parques no âmbito de cidade (Park.city). `cities` undefined = todas. */
export async function readPartnershipsLive(cities: string[] | undefined, query: Query = multiparkDbQuery, now: Date = new Date()): Promise<MultiparkRead<PartnershipsLive>> {
  return safeMultiparkRead("parcerias", async () => {
    const periods = livePeriods(now);
    const parks = mapParks(await query(buildParksSql().sql), cities);
    const ours = parks.filter((p) => p.ours);
    let partners: LivePartner[] = [];
    if (ours.length) {
      const q = buildPartnerTotalsSql(ours.map((p) => p.id), periods);
      partners = groupLivePartners(await query(q.sql, q.params), ours);
    }
    let parkRows: Row[] = [];
    if (parks.length) {
      const q = buildParkTotalsSql(parks.map((p) => p.id), periods);
      parkRows = await query(q.sql, q.params);
    }
    return { periods: { thisMonth: periods.thisMonth, from12: periods.from12 }, marketplaceRate: MARKETPLACE_COMMISSION, partners, parks: mapLiveParks(parks, parkRows) };
  });
}

// ─── Ajudantes ──────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "t" || v === "true";
}
const round = (n: number) => Math.round(n * 100) / 100;
