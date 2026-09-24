/**
 * Folhas das Reservas & Operações (Reservas / Recolhas / Entregas /
 * Cancelados) e as séries de custo por dia × cidade (publicidade, extras).
 *
 * Datas: SEMPRE dias de Lisboa convertidos para intervalos UTC [início, fim)
 * (`shared/lisbonDay.ts`) — as colunas da BD estão em UTC.
 */
import { and, desc, inArray, sql } from "drizzle-orm";
import { multiparkBookings } from "../drizzle/schema";
import { buildPartnerByCampaignMap, getDb, getProjects, resolveProjectIds } from "./db";
import { projectScope, scopedProjectIds } from "./cityScope";
import { lisbonDayOf, lisbonDayRangeUtc, lisbonDaySql } from "../shared/lisbonDay";
import { CITY_KEYS, matchCityKey, type CityKey } from "../shared/city";
import type { OperationAction } from "../shared/operationBookings";
import { aggregateScan, enrichScanRow, type ScanRow } from "./operationsBookingsCore";

/** Máximo de reservas lidas para os agregados (colunas leves). */
export const SCAN_LIMIT = 50_000;

/** Coluna de data de cada folha (SQL confiável, escrito aqui). */
export const ACTION_DATE_COL: Record<OperationAction, string> = {
  creation: "multipark_bookings.bookingCreatedAt",
  checkin: "multipark_bookings.checkIn",
  checkout: "multipark_bookings.checkOut",
  // Cancelados: pela data do cancelamento; sem ela (o sync nem sempre a traz)
  // pela última alteração (updatedAt) — marcado como aproximado na UI.
  cancelation: "COALESCE(multipark_bookings.cancelledAt, multipark_bookings.updatedAt)",
};

export interface OperationsBookingsFilters {
  startDate: string; endDate: string; actionType: OperationAction;
  projectId?: number; group?: string; channel?: string; state?: string; search?: string;
  limit?: number; offset?: number;
}

async function baseConditions(f: { startDate: string; endDate: string; actionType: OperationAction; projectId?: number; search?: string }) {
  const range = lisbonDayRangeUtc(f.startDate, f.endDate);
  const col = ACTION_DATE_COL[f.actionType];
  const conds: any[] = [sql.raw(`${col} >= '${range.start}' AND ${col} < '${range.end}'`)];
  if (f.actionType === "checkin" || f.actionType === "checkout") conds.push(sql`${multiparkBookings.status} != 'CANCELLED'`);
  if (f.actionType === "cancelation") conds.push(sql`${multiparkBookings.status} = 'CANCELLED'`);
  if (f.projectId) {
    const ids = await resolveProjectIds(f.projectId);
    conds.push(ids.length ? inArray(multiparkBookings.projectId, ids) : sql`1 = 0`);
  }
  conds.push(projectScope(multiparkBookings.projectId));
  const s = f.search?.trim();
  if (s) {
    const like = `%${s}%`;
    conds.push(sql`(${multiparkBookings.clientFirstName} LIKE ${like} OR ${multiparkBookings.clientLastName} LIKE ${like}
      OR ${multiparkBookings.licensePlate} LIKE ${like} OR ${multiparkBookings.bookingNumber} LIKE ${like}
      OR ${multiparkBookings.clientEmail} LIKE ${like})`);
  }
  return conds;
}

export async function getOperationsBookings(f: OperationsBookingsFilters) {
  const db = await getDb();
  const limit = Math.min(Math.max(f.limit ?? 500, 1), 20_000);
  const offset = Math.max(f.offset ?? 0, 0);
  const empty = { total: 0, scanTruncated: false, cancelled: 0, active: 0, done: 0, pending: 0, approxDates: 0, summary: null as any, daily: [] as any[], origins: [] as any[], bookings: [] as any[], hasMore: false, offset, limit };
  if (!db) return empty;
  const conds = await baseConditions(f);
  const dayExpr = lisbonDaySql(ACTION_DATE_COL[f.actionType], f.startDate, f.endDate);

  // 1) Varredura LEVE (só o necessário para classificar, filtrar e somar)
  const scan = await db.select({
    id: multiparkBookings.id, status: multiparkBookings.status,
    parkName: multiparkBookings.parkName, city: multiparkBookings.city,
    origin: multiparkBookings.origin, originUrl: sql<string | null>`LEFT(${multiparkBookings.originUrl}, 255)`,
    campaign: multiparkBookings.campaign, totalPrice: multiparkBookings.totalPrice,
    remainingToPay: multiparkBookings.remainingToPay, totalPaid: multiparkBookings.totalPaid,
    paymentMethod: multiparkBookings.paymentMethod,
    day: sql<string>`${sql.raw(dayExpr)}`,
    approxDate: sql<number>`(${multiparkBookings.cancelledAt} IS NULL)`,
  }).from(multiparkBookings)
    .where(and(...conds))
    .orderBy(desc(multiparkBookings.bookingCreatedAt), desc(multiparkBookings.id))
    .limit(SCAN_LIMIT + 1);
  const scanTruncated = scan.length > SCAN_LIMIT;
  const partners = await buildPartnerByCampaignMap();
  const rows = scan.slice(0, SCAN_LIMIT).map((r: any) => enrichScanRow({ ...r, day: String(r.day ?? "").slice(0, 10) } as ScanRow, partners));
  const agg = aggregateScan(rows, { action: f.actionType, group: f.group, channel: f.channel, state: f.state });

  // 2) Página de linhas completas para a tabela/CSV (só as colunas usadas)
  const pageRows = agg.filtered.slice(offset, offset + limit);
  const byId = new Map(pageRows.map((r) => [r.id, r]));
  const full = pageRows.length ? await db.select({
    id: multiparkBookings.id, externalId: multiparkBookings.externalId, bookingNumber: multiparkBookings.bookingNumber,
    clientFirstName: multiparkBookings.clientFirstName, clientLastName: multiparkBookings.clientLastName,
    clientEmail: multiparkBookings.clientEmail, licensePlate: multiparkBookings.licensePlate,
    parkName: multiparkBookings.parkName, city: multiparkBookings.city,
    checkIn: multiparkBookings.checkIn, checkOut: multiparkBookings.checkOut, deliveryType: multiparkBookings.deliveryType,
    status: multiparkBookings.status, parkingType: multiparkBookings.parkingType,
    totalPrice: multiparkBookings.totalPrice, deliveryCharges: multiparkBookings.deliveryCharges,
    extrasTotal: multiparkBookings.extrasTotal, discount: multiparkBookings.discount,
    remainingToPay: multiparkBookings.remainingToPay, campaign: multiparkBookings.campaign,
    origin: multiparkBookings.origin, originUrl: multiparkBookings.originUrl,
    bookingCreatedAt: multiparkBookings.bookingCreatedAt, cancelledAt: multiparkBookings.cancelledAt, updatedAt: multiparkBookings.updatedAt,
  }).from(multiparkBookings).where(inArray(multiparkBookings.id, pageRows.map((r) => r.id))) : [];
  const fullById = new Map(full.map((b: any) => [b.id, b]));
  const bookings = pageRows.map((r) => {
    const b: any = fullById.get(r.id) ?? {};
    const e = byId.get(r.id)!;
    return { ...b, salesPartnerName: e.salesPartnerName, salesPartnerRate: e.salesPartnerRate, salesPartnerCommission: e.salesPartnerCommission, group: e.group, channel: e.channel, day: e.day, approxDate: f.actionType === "cancelation" && !!e.approxDate };
  });

  const { filtered: _omit, ...rest } = agg;
  return { ...rest, scanTruncated, bookings, hasMore: offset + limit < agg.filtered.length, offset, limit };
}

// ─── Cidades (nós "city" da árvore de projetos) ──────────────────────────────

/** Cidades pedidas (projectId) ∩ cidades do âmbito do utilizador → nós de projeto. */
export async function scopedCityNodes(projectId?: number): Promise<Array<{ key: CityKey; id: number; projectIds: number[] }>> {
  const nodes = await getProjects();
  const scope = scopedProjectIds();
  const requested = projectId ? new Set(await resolveProjectIds(projectId)) : null;
  const out: Array<{ key: CityKey; id: number; projectIds: number[] }> = [];
  for (const n of nodes as any[]) {
    if (n.level !== "city") continue;
    const key = matchCityKey(n.name);
    if (!key || out.some((o) => o.key === key)) continue;
    let ids = await resolveProjectIds(n.id);
    if (scope) ids = ids.filter((id) => scope.includes(id));
    if (requested) ids = ids.filter((id) => requested.has(id));
    if (!ids.length) continue;
    // Se o pedido é uma marca/projeto dentro da cidade, só esses projetos contam.
    out.push({ key, id: n.id, projectIds: ids });
  }
  return out;
}

/** Cidade (lisboa/porto/faro) de um projeto, subindo na árvore. */
export async function cityKeyResolver(): Promise<(pid: number | null) => CityKey | null> {
  const nodes = await getProjects();
  const byId = new Map(nodes.map((p: any) => [p.id, p]));
  return (pid) => {
    let cur: any = pid == null ? undefined : byId.get(pid); let guard = 0;
    while (cur && guard++ < 20) { if (cur.level === "city") return matchCityKey(cur.name); cur = cur.parentId != null ? byId.get(cur.parentId) : undefined; }
    return null;
  };
}

function lisbonToday(): string { return lisbonDayOf(Date.now()); }

/** Gasto em publicidade (Google Ads API + legado, nacional repartido) por dia × cidade. */
export async function getAdSpendDaily(f: { startDate: string; endDate: string; projectId?: number }) {
  const { getAdMetrics } = await import("./integrations/googleAds/adMetrics");
  const cities = await scopedCityNodes(f.projectId);
  const rows: Array<{ day: string; city: CityKey; cost: number }> = [];
  for (const c of cities) {
    const m = await getAdMetrics({ from: f.startDate, to: f.endDate, projectIds: c.projectIds });
    for (const d of m.byDay) if (d.cost) rows.push({ day: d.date, city: c.key, cost: Math.round(d.cost * 100) / 100 });
  }
  return { cities: cities.map((c) => c.key), rows };
}

/** Custo dos extras por dia (de Lisboa) × cidade: real (ponto), previsto (escala) e o que conta. */
export async function getExtrasCostDaily(f: { startDate: string; endDate: string; projectId?: number; today?: string }) {
  const db = await getDb();
  const today = f.today ?? lisbonToday();
  if (!db) return { today, rows: [] as Array<{ day: string; city: CityKey; real: number; planned: number; cost: number }> };
  const { loadExtrasCostRows, aggregateExtrasCost, countedExtrasCost } = await import("./finance/extrasCost");
  const { loadExtraRates } = await import("./extraRates");
  const cities = await scopedCityNodes(f.projectId);
  const scoped = scopedProjectIds() !== undefined || !!f.projectId;
  const projectIds = scoped ? cities.flatMap((c) => c.projectIds) : undefined;
  const cityNames = scoped ? cities.map((c) => (c.key === "lisboa" ? "lisbon" : c.key)) : null;
  const range = lisbonDayRangeUtc(f.startDate, f.endDate);
  const raw = await loadExtrasCostRows(db, { from: f.startDate, to: f.endDate, projectIds, cities: cityNames, pontoRange: { start: range.start, endExclusive: range.end } });
  const cityOf = await cityKeyResolver();
  const agg = aggregateExtrasCost(raw, await loadExtraRates(), { dayOfRecord: (v) => (v ? lisbonDayOf(v) : ""), cityOfProject: cityOf });
  const allowed = new Set(cities.map((c) => c.key));
  const rows = Array.from(agg.byDayCity.values())
    .filter((r): r is typeof r & { city: CityKey } => r.city != null && allowed.has(r.city) && r.day >= f.startDate && r.day <= f.endDate)
    .map((r) => ({ day: r.day, city: r.city, real: Math.round(r.real * 100) / 100, planned: Math.round(r.planned * 100) / 100, cost: Math.round(countedExtrasCost(r.day, today, r.real, r.planned) * 100) / 100 }))
    .sort((a, b) => a.day.localeCompare(b.day) || CITY_KEYS.indexOf(a.city) - CITY_KEYS.indexOf(b.city));
  return { today, rows };
}

export const MAX_RANGE_DAYS = 366;
export function rangeTooLong(startDate: string, endDate: string): boolean {
  const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return (ms(endDate) - ms(startDate)) / 86_400_000 + 1 > MAX_RANGE_DAYS;
}
