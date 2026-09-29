/**
 * Painel e resumo de Operações AO VIVO (reservas ao vivo, parte B, 29 set
 * 2026): as mesmas respostas que getMultiparkBookingStats / getOperationsSummary
 * davam sobre a cópia `multipark_bookings`, agora das contagens por dia ×
 * parque lidas da BD da Multipark (server/multiparkDb/opsCounts.ts).
 *
 * Parques: os nossos, do projeto pedido e das cidades de quem pede. Datas:
 * dias de Lisboa. Lança se a BD da Multipark não responder.
 */
import { lisbonDayRangeUtc } from "../shared/lisbonDay";
import type { OpsCountRow, OpsEvent } from "./multiparkDb/opsCounts";

type ParkInfo = Map<string, { name: string; city: string | null }>;

/** Parques nossos do projeto pedido (∩ cidades de quem pede) e os nomes/cidades deles. */
export async function liveParkScope(projectId?: number | null): Promise<{ parkIds: string[]; parkInfo: ParkInfo }> {
  const [{ loadLiveContext, parkIdsFor }, { scopedProjectIds }, { resolveProjectIds }] = await Promise.all([
    import("./finance/liveBookings"), import("./cityScope"), import("./db"),
  ]);
  const ctx = await loadLiveContext();
  let ids: number[] | null = projectId ? await resolveProjectIds(projectId) : null;
  const scoped = scopedProjectIds();
  if (scoped !== undefined) ids = ids ? ids.filter((i) => scoped.includes(i)) : [...scoped];
  return { parkIds: parkIdsFor(ctx, ids), parkInfo: ctx.parkInfo ?? new Map() };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export interface OpsAction { count: number; revenue: number; byCity: Array<{ name: string; count: number; revenue: number }>; byPark: Array<{ name: string; count: number; revenue: number }> }

/** Contagens → resumo por acontecimento (total, por cidade, por parque). PURA. */
export function summarizeOpsActions(rows: readonly OpsCountRow[], parkInfo: ParkInfo): Record<string, OpsAction> {
  const NAMES: Record<OpsEvent, string> = { created: "creation", createdAll: "createdAll", checkin: "checkin", checkout: "checkout", cancelled: "cancelation" };
  const out: Record<string, OpsAction> = {};
  const acc = new Map<string, { count: number; revenue: number; city: Map<string, { count: number; revenue: number }>; park: Map<string, { count: number; revenue: number }> }>();
  for (const e of Object.values(NAMES)) acc.set(e, { count: 0, revenue: 0, city: new Map(), park: new Map() });
  for (const r of rows) {
    const a = acc.get(NAMES[r.event]);
    if (!a) continue;
    const info = parkInfo.get(r.parkId);
    const city = info?.city?.trim() || "—";
    const name = info?.name?.trim() || "—";
    const parkKey = info?.city && !name.includes(info.city) ? `${name} ${info.city}` : name;
    a.count += r.count; a.revenue += r.revenue;
    for (const [m, k] of [[a.city, city], [a.park, parkKey]] as const) {
      const v = m.get(k) ?? { count: 0, revenue: 0 };
      v.count += r.count; v.revenue += r.revenue; m.set(k, v);
    }
  }
  const list = (m: Map<string, { count: number; revenue: number }>) =>
    [...m].map(([name, v]) => ({ name, count: v.count, revenue: r2(v.revenue) })).sort((x, y) => y.count - x.count);
  for (const [k, a] of acc) out[k] = { count: a.count, revenue: r2(a.revenue), byCity: list(a.city), byPark: list(a.park) };
  return out;
}

export interface BookingStats {
  total: number; reservasHoje: number; checkinHoje: number; checkoutHoje: number; canceladosHoje: number;
  reservasMes: number; checkinMes: number; checkoutMes: number; canceladosMes: number;
  receitaHoje: number; receitaMes: number; receitaPeriodo: number;
  byCity: { name: string; bookings: number; revenue: number }[];
  byDay: { date: string; reservas: number; checkins: number; checkouts: number; cancelados: number; revenue: number }[];
  byBrand: { name: string; bookings: number; revenue: number }[];
}

/**
 * Contagens (dia × parque) → painel: hoje, este mês e o período (dias de
 * Lisboa). Receita de hoje/mês/período = valor das entradas; por cidade,
 * marca e dia = reservas criadas no período. PURA.
 */
export function summarizeBookingStats(rows: readonly OpsCountRow[], o: { total: number; today: string; monthStart: string; periodFrom: string; periodTo: string; parkInfo: ParkInfo }): BookingStats {
  const inDay = (d: string, from: string, to: string) => d >= from && d <= to;
  const sum = (e: OpsEvent, from: string, to: string) => {
    let count = 0, revenue = 0;
    for (const r of rows) if (r.event === e && inDay(r.day, from, to)) { count += r.count; revenue += r.revenue; }
    return { count, revenue: r2(revenue) };
  };
  const byCity = new Map<string, { bookings: number; revenue: number }>();
  const byBrand = new Map<string, { bookings: number; revenue: number }>();
  const days = new Map<string, { reservas: number; checkins: number; checkouts: number; cancelados: number; revenue: number }>();
  const day = (d: string) => { let v = days.get(d); if (!v) { v = { reservas: 0, checkins: 0, checkouts: 0, cancelados: 0, revenue: 0 }; days.set(d, v); } return v; };
  for (const r of rows) {
    if (!inDay(r.day, o.periodFrom, o.periodTo)) continue;
    if (r.event === "created") {
      const info = o.parkInfo.get(r.parkId);
      for (const [m, k] of [[byCity, info?.city?.trim() || "Desconhecido"], [byBrand, info?.name?.trim() || "Desconhecido"]] as const) {
        const v = m.get(k) ?? { bookings: 0, revenue: 0 };
        v.bookings += r.count; v.revenue += r.revenue; m.set(k, v);
      }
      const d = day(r.day); d.reservas += r.count; d.revenue += r.revenue;
    } else if (r.event === "checkin") day(r.day).checkins += r.count;
    else if (r.event === "checkout") day(r.day).checkouts += r.count;
    else if (r.event === "cancelled") day(r.day).cancelados += r.count;
  }
  const t = o.today, m = o.monthStart;
  const ciHoje = sum("checkin", t, t), ciMes = sum("checkin", m, t);
  return {
    total: o.total,
    reservasHoje: sum("created", t, t).count, checkinHoje: ciHoje.count, checkoutHoje: sum("checkout", t, t).count, canceladosHoje: sum("cancelled", t, t).count,
    reservasMes: sum("created", m, t).count, checkinMes: ciMes.count, checkoutMes: sum("checkout", m, t).count, canceladosMes: sum("cancelled", m, t).count,
    receitaHoje: ciHoje.revenue, receitaMes: ciMes.revenue, receitaPeriodo: sum("checkin", o.periodFrom, o.periodTo).revenue,
    byCity: [...byCity].map(([name, v]) => ({ name, bookings: v.bookings, revenue: r2(v.revenue) })),
    byDay: [...days].filter(([, v]) => v.reservas > 0).sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v, revenue: r2(v.revenue) })),
    byBrand: [...byBrand].map(([name, v]) => ({ name, bookings: v.bookings, revenue: r2(v.revenue) })),
  };
}

const EMPTY_STATS: BookingStats = {
  total: 0, reservasHoje: 0, checkinHoje: 0, checkoutHoje: 0, canceladosHoje: 0, reservasMes: 0, checkinMes: 0, checkoutMes: 0, canceladosMes: 0,
  receitaHoje: 0, receitaMes: 0, receitaPeriodo: 0, byCity: [], byDay: [], byBrand: [],
};

/** Painel (Dashboard, Financeiro, Operações, MCP). */
export async function liveBookingStats(filters?: { from?: string; to?: string; projectId?: number }, nowMs = Date.now()): Promise<BookingStats> {
  const { lisbonDayOf } = await import("../shared/lisbonDay");
  const today = lisbonDayOf(nowMs);
  const monthStart = `${today.slice(0, 7)}-01`;
  const periodFrom = filters?.from || monthStart;
  const periodTo = filters?.to || today;
  const { parkIds, parkInfo } = await liveParkScope(filters?.projectId);
  if (!parkIds.length) return EMPTY_STATS;
  const from = [periodFrom, monthStart].sort()[0];
  const to = [periodTo, today].sort()[1];
  const range = lisbonDayRangeUtc(from, to);
  const { readOpsCounts, readBookingTotal } = await import("./multiparkDb/opsCounts");
  const [rows, total] = await Promise.all([
    readOpsCounts({ events: ["created", "checkin", "checkout", "cancelled"], start: range.start, end: range.end, parkIds }),
    readBookingTotal(parkIds),
  ]);
  return summarizeBookingStats(rows, { total, today, monthStart, periodFrom, periodTo, parkInfo });
}

/** Resumo de Operações por acontecimento. */
export async function liveOperationsSummary(filters: { startDate: string; endDate: string; projectId?: number }): Promise<{ actions: Record<string, OpsAction> }> {
  const { parkIds, parkInfo } = await liveParkScope(filters.projectId);
  if (!parkIds.length) return { actions: summarizeOpsActions([], parkInfo) };
  const range = lisbonDayRangeUtc(filters.startDate, filters.endDate);
  const { readOpsCounts, OPS_EVENTS } = await import("./multiparkDb/opsCounts");
  const rows = await readOpsCounts({ events: OPS_EVENTS, start: range.start, end: range.end, parkIds });
  return { actions: summarizeOpsActions(rows, parkInfo) };
}
