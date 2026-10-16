/**
 * Painel e resumo de Operações AO VIVO (reservas ao vivo, parte B, 29 set
 * 2026): as mesmas respostas que getMultiparkBookingStats / getOperationsSummary
 * davam sobre a cópia `multipark_bookings`, agora das contagens por dia ×
 * parque lidas da BD da Multipark (server/multiparkDb/opsCounts.ts).
 *
 * Dois universos de parques (plano 64):
 *   - liveOpsParkScope — TODOS os parques das cidades de quem pede (os nossos
 *     e todo o Marketplace, operado ou não), os mesmos das listas das
 *     Operações (B0): o Geral, o Dashboard das Operações e o Resumo de
 *     /operacoes ("aqui tem que contar tudo", Jorge). A função única destas
 *     contagens é liveOpsBookingStats (B1).
 *   - liveParkScope — só os parques NOSSOS (o MCP, o assistente, o Financeiro
 *     e os Serviços), como sempre.
 * Datas: dias de Lisboa. Lança se a BD da Multipark não responder.
 */
import { addDays, lisbonDayOf, lisbonDayRangeUtc } from "../shared/lisbonDay";
import { CITY_LABELS, type CityKey } from "../shared/city";
import { MARKETPLACE_GROUP_LABEL, OUR_PARK_BRAND_LABELS } from "../shared/multiparkParks";
import { rangeDays } from "../shared/opsLists";
import type { OpsCountRow, OpsEvent } from "./multiparkDb/opsCounts";
import type { DayPark } from "./multiparkDb/dayBookings";
import type { LiveContext } from "./finance/liveBookings";
import { createLiveCache } from "./multiparkDb/liveCache";

/** O que os resumos sabem de cada parque. */
export interface ParkMeta {
  name: string;
  /** A cidade gravada no parque (o nome do parque no Resumo usa-a). */
  city: string | null;
  /** B10: a cidade RESOLVIDA ("Prior Velho" → Lisboa, "Oporto" → Porto), para o "por cidade". */
  cityLabel?: string | null;
  /** B11: a marca classificada ("Airpark"…; os de terceiros → "Marketplace"), para o "por marca". */
  brandLabel?: string | null;
  /** Parque nosso (o resto é Marketplace). */
  ours?: boolean;
}
type ParkInfo = Map<string, ParkMeta>;

const cityLabelOf = (key: CityKey | null | undefined, recorded: string | null): string | null =>
  (key ? CITY_LABELS[key] : null) ?? (recorded?.trim() || null);

/** Parques nossos do projeto pedido (∩ cidades de quem pede) e os nomes/cidades deles. */
export async function liveParkScope(projectId?: number | null): Promise<{ parkIds: string[]; parkInfo: ParkInfo }> {
  const [{ loadLiveContext, parkIdsFor }, { scopedProjectIds }, { resolveProjectIds }] = await Promise.all([
    import("./finance/liveBookings"), import("./cityScope"), import("./db"),
  ]);
  const ctx = await loadLiveContext();
  let ids: number[] | null = projectId ? await resolveProjectIds(projectId) : null;
  const scoped = scopedProjectIds();
  if (scoped !== undefined) ids = ids ? ids.filter((i) => scoped.includes(i)) : [...scoped];
  // B10: a cidade resolvida do contexto (só leitura do liveBookings), para o "por cidade".
  const parkInfo: ParkInfo = new Map([...(ctx.parkInfo ?? new Map())].map(([id, v]) => [id, {
    ...v, cityLabel: cityLabelOf(ctx.parkCity?.get(id) as CityKey | null | undefined, v.city), ours: true,
  }]));
  return { parkIds: parkIdsFor(ctx, ids), parkInfo };
}

/**
 * B0: os parques de uma marca/parque (nó brand/project) — os nossos pelo
 * centro de custos e os do Marketplace pelo nó Marketplace (ctx.marketplaceParks).
 * PURA.
 */
export function brandParkSet(ctx: Pick<LiveContext, "ourParks" | "marketplaceParks">, projectIds: readonly number[]): Set<string> {
  const set = new Set(projectIds);
  const out = new Set<string>();
  for (const m of [ctx.ourParks, ctx.marketplaceParks ?? new Map<string, number | null>()]) {
    for (const [id, pid] of m) if (pid != null && set.has(pid)) out.add(id);
  }
  return out;
}

/**
 * B0/B16: marca (ou parque) escolhida no topo → os parques dela, a regra de
 * brandParkIdsFor (server/movementPeople.ts) alargada ao Marketplace. Cidade
 * ou nada → undefined (a cidade já vem pelo âmbito do pedido). Nunca alarga o
 * âmbito: os centros ficam cortados pelos de quem pede.
 */
export async function brandScopeParkIds(projectId?: number | null): Promise<Set<string> | undefined> {
  if (!projectId) return undefined;
  const { isBrandFilterNode } = await import("./movementPeople");
  if (!(await isBrandFilterNode(projectId))) return undefined;
  const [{ loadLiveContext }, { scopedProjectIds }, { resolveProjectIds }] = await Promise.all([
    import("./finance/liveBookings"), import("./cityScope"), import("./db"),
  ]);
  const scoped = scopedProjectIds();
  const ids = (await resolveProjectIds(projectId)).filter((i) => scoped === undefined || scoped.includes(i));
  return brandParkSet(await loadLiveContext(), ids);
}

/** Um parque das listas → o que os resumos sabem dele (cidade resolvida, marca classificada). PURA. */
export function opsParkMeta(p: Pick<DayPark, "name" | "cityName" | "city" | "brand" | "ours">): ParkMeta {
  return {
    name: p.name,
    city: p.cityName,
    cityLabel: cityLabelOf(p.city, p.cityName),
    brandLabel: p.ours && p.brand ? OUR_PARK_BRAND_LABELS[p.brand] : MARKETPLACE_GROUP_LABEL,
    ours: p.ours,
  };
}

/**
 * B0: TODOS os parques das cidades de quem pede (nossos + todo o Marketplace),
 * os mesmos das listas das Operações (readScopeParks), e com uma marca no
 * topo só os dela. Lança se a BD da Multipark falhar.
 */
export async function liveOpsParkScope(projectId?: number | null): Promise<{ parkIds: string[]; parkInfo: ParkInfo }> {
  const [{ readScopeParks }, { scopedCityNamesLive }] = await Promise.all([import("./multiparkDb/opsEvents"), import("./cityScope")]);
  const [parks, only] = await Promise.all([readScopeParks(scopedCityNamesLive()), brandScopeParkIds(projectId)]);
  const inScope = only ? parks.filter((p) => only.has(p.id)) : parks;
  return { parkIds: inScope.map((p) => p.id), parkInfo: new Map(inScope.map((p) => [p.id, opsParkMeta(p)])) };
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
    // B10: a cidade resolvida (o nome do parque continua com a cidade gravada)
    const city = info?.cityLabel || info?.city?.trim() || "—";
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
  /** Total de reservas destes parques (só o painel do MCP o lê; null = não lido). */
  total: number | null;
  reservasHoje: number; checkinHoje: number; checkoutHoje: number; canceladosHoje: number;
  /** B1: das reservas criadas hoje, quantas são de parques NOSSOS e quantas do Marketplace (pelo PARQUE; somam reservasHoje). */
  reservasHojeNossos: number;
  reservasHojeMarketplace: number;
  reservasMes: number; checkinMes: number; checkoutMes: number; canceladosMes: number;
  /** Entradas / saídas no período pedido (o relatório semanal, PR H). */
  checkinPeriodo: number; checkoutPeriodo: number;
  receitaHoje: number; receitaMes: number; receitaPeriodo: number;
  byCity: { name: string; bookings: number; revenue: number }[];
  byDay: { date: string; reservas: number; checkins: number; checkouts: number; cancelados: number; revenue: number }[];
  byBrand: { name: string; bookings: number; revenue: number }[];
}

/** B12: até este n.º de dias, o "por dia" leva todos os dias do período (os vazios a 0). */
const BY_DAY_FILL_MAX = 400;

/**
 * Contagens (dia × parque) → painel: hoje, este mês e o período (dias de
 * Lisboa). Receita de hoje/mês/período = valor das entradas; por cidade
 * (resolvida), marca e dia = reservas criadas no período; o "por dia" leva
 * os dias do período sem reservas a 0. PURA.
 */
export function summarizeBookingStats(rows: readonly OpsCountRow[], o: { total: number | null; today: string; monthStart: string; periodFrom: string; periodTo: string; parkInfo: ParkInfo }): BookingStats {
  const inDay = (d: string, from: string, to: string) => d >= from && d <= to;
  const sum = (e: OpsEvent, from: string, to: string, only?: (r: OpsCountRow) => boolean) => {
    let count = 0, revenue = 0;
    for (const r of rows) if (r.event === e && inDay(r.day, from, to) && (!only || only(r))) { count += r.count; revenue += r.revenue; }
    return { count, revenue: r2(revenue) };
  };
  const byCity = new Map<string, { bookings: number; revenue: number }>();
  const byBrand = new Map<string, { bookings: number; revenue: number }>();
  const days = new Map<string, { reservas: number; checkins: number; checkouts: number; cancelados: number; revenue: number }>();
  const day = (d: string) => { let v = days.get(d); if (!v) { v = { reservas: 0, checkins: 0, checkouts: 0, cancelados: 0, revenue: 0 }; days.set(d, v); } return v; };
  // B12: os dias do período sem nada também aparecem (a 0) — o gráfico não liga pontos por cima deles.
  if (rangeDays(o.periodFrom, o.periodTo) <= BY_DAY_FILL_MAX) for (let d = o.periodFrom; d <= o.periodTo; d = addDays(d, 1)) day(d);
  for (const r of rows) {
    if (!inDay(r.day, o.periodFrom, o.periodTo)) continue;
    if (r.event === "created") {
      const info = o.parkInfo.get(r.parkId);
      const city = info?.cityLabel || info?.city?.trim() || "Desconhecido";
      const brand = info?.brandLabel || info?.name?.trim() || "Desconhecido";
      for (const [m, k] of [[byCity, city], [byBrand, brand]] as const) {
        const v = m.get(k) ?? { bookings: 0, revenue: 0 };
        v.bookings += r.count; v.revenue += r.revenue; m.set(k, v);
      }
      const d = day(r.day); d.reservas += r.count; d.revenue += r.revenue;
    } else if (r.event === "checkin") day(r.day).checkins += r.count;
    else if (r.event === "checkout") day(r.day).checkouts += r.count;
    else if (r.event === "cancelled") day(r.day).cancelados += r.count;
  }
  const t = o.today, m = o.monthStart;
  const ciHoje = sum("checkin", t, t), ciMes = sum("checkin", m, t), ciPeriodo = sum("checkin", o.periodFrom, o.periodTo);
  return {
    total: o.total,
    reservasHoje: sum("created", t, t).count, checkinHoje: ciHoje.count, checkoutHoje: sum("checkout", t, t).count, canceladosHoje: sum("cancelled", t, t).count,
    reservasHojeNossos: sum("created", t, t, (r) => !!o.parkInfo.get(r.parkId)?.ours).count,
    reservasHojeMarketplace: sum("created", t, t, (r) => !o.parkInfo.get(r.parkId)?.ours).count,
    reservasMes: sum("created", m, t).count, checkinMes: ciMes.count, checkoutMes: sum("checkout", m, t).count, canceladosMes: sum("cancelled", m, t).count,
    checkinPeriodo: ciPeriodo.count, checkoutPeriodo: sum("checkout", o.periodFrom, o.periodTo).count,
    receitaHoje: ciHoje.revenue, receitaMes: ciMes.revenue, receitaPeriodo: ciPeriodo.revenue,
    byCity: [...byCity].map(([name, v]) => ({ name, bookings: v.bookings, revenue: r2(v.revenue) })),
    byDay: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v, revenue: r2(v.revenue) })),
    byBrand: [...byBrand].map(([name, v]) => ({ name, bookings: v.bookings, revenue: r2(v.revenue) })),
  };
}

const EMPTY_STATS: BookingStats = {
  total: 0, reservasHoje: 0, checkinHoje: 0, checkoutHoje: 0, canceladosHoje: 0, reservasHojeNossos: 0, reservasHojeMarketplace: 0, reservasMes: 0, checkinMes: 0, checkoutMes: 0, canceladosMes: 0,
  checkinPeriodo: 0, checkoutPeriodo: 0, receitaHoje: 0, receitaMes: 0, receitaPeriodo: 0, byCity: [], byDay: [], byBrand: [],
};

/** Hoje, o dia 1 do mês e o período pedido (dias de Lisboa) e o intervalo a ler. PURA. */
function statsWindow(filters: { from?: string; to?: string } | undefined, nowMs: number) {
  const today = lisbonDayOf(nowMs);
  const monthStart = `${today.slice(0, 7)}-01`;
  const periodFrom = filters?.from || monthStart;
  const periodTo = filters?.to || today;
  const from = [periodFrom, monthStart].sort()[0];
  const to = [periodTo, today].sort()[1];
  return { today, monthStart, periodFrom, periodTo, range: lisbonDayRangeUtc(from, to) };
}

/**
 * Painel dos parques NOSSOS (Financeiro, MCP, assistente). `includePending`:
 * só para as contas operacionais — no dinheiro as compras por pagar nunca entram.
 */
export async function liveBookingStats(filters?: { from?: string; to?: string; projectId?: number }, nowMs = Date.now(), o: { includePending?: boolean } = {}): Promise<BookingStats> {
  const { today, monthStart, periodFrom, periodTo, range } = statsWindow(filters, nowMs);
  const { parkIds, parkInfo } = await liveParkScope(filters?.projectId);
  if (!parkIds.length) return EMPTY_STATS;
  const { readOpsCounts, readBookingTotal } = await import("./multiparkDb/opsCounts");
  const [rows, total] = await Promise.all([
    readOpsCounts({ events: ["created", "checkin", "checkout", "cancelled"], start: range.start, end: range.end, parkIds, includePending: o.includePending }),
    readBookingTotal(parkIds),
  ]);
  return summarizeBookingStats(rows, { total, today, monthStart, periodFrom, periodTo, parkInfo });
}

// ─── Contagens de TODOS os parques (Geral, Operações, Resumo) ───────────────

/**
 * As contagens lidas com a promessa partilhada, 60 s (plano 64, §7): o Geral
 * é a página de entrada e o pool da Multipark tem 2 ligações. A chave leva os
 * acontecimentos, o intervalo e os PARQUES (o âmbito de quem pede).
 */
const countsCache = createLiveCache(60_000);
export function resetOpsCountsCache(): void { countsCache.clear(); }

async function readAllParksCounts(o: { events: readonly OpsEvent[]; start: string; end: string; parkIds: readonly string[] }): Promise<OpsCountRow[]> {
  const { readOpsCounts, OPS_COUNTS_LIMIT } = await import("./multiparkDb/opsCounts");
  const key = JSON.stringify(["opsCounts", [...o.events], o.start, o.end, [...o.parkIds].sort()]);
  const rows = await countsCache.get(key, () => readOpsCounts({ ...o, includePending: true }));
  // Teto: chegar ao limite = contagens cortadas → erro (o cartão mostra "—"), nunca um número a menos.
  if (rows.length >= OPS_COUNTS_LIMIT) {
    throw new Error(`Leitura incompleta: mais de ${OPS_COUNTS_LIMIT.toLocaleString("pt-PT")} linhas de contagens. Escolhe um período mais curto ou uma cidade.`);
  }
  return rows;
}

/**
 * B1 — a função ÚNICA das contagens de reservas (Geral, Dashboard das
 * Operações e, com o valor, os donuts do Financeiro): TODOS os parques das
 * cidades de quem pede (nossos + todo o Marketplace), como as listas das
 * Operações, COM as compras por pagar (D6). Sem o total de sempre (o ecrã não
 * o usa e era a leitura mais pesada). Lança se a BD da Multipark falhar.
 */
export async function liveOpsBookingStats(filters?: { from?: string; to?: string; projectId?: number }, nowMs = Date.now()): Promise<BookingStats> {
  const { today, monthStart, periodFrom, periodTo, range } = statsWindow(filters, nowMs);
  const { parkIds, parkInfo } = await liveOpsParkScope(filters?.projectId);
  if (!parkIds.length) return { ...EMPTY_STATS, total: null };
  const rows = await readAllParksCounts({ events: ["created", "checkin", "checkout", "cancelled"], start: range.start, end: range.end, parkIds });
  return summarizeBookingStats(rows, { total: null, today, monthStart, periodFrom, periodTo, parkInfo });
}

/** Só contagens (sem receita) — o painel de Operações não precisa dos totais financeiros (22a, D5). */
export interface OpsBookingCounts {
  total: number | null; reservasHoje: number; checkinHoje: number; checkoutHoje: number; canceladosHoje: number;
  reservasHojeNossos: number; reservasHojeMarketplace: number;
  reservasMes: number; checkinMes: number; checkoutMes: number; canceladosMes: number;
  checkinPeriodo: number; checkoutPeriodo: number;
  byCity: { name: string; bookings: number }[];
  byBrand: { name: string; bookings: number }[];
  byDay: { date: string; reservas: number; checkins: number; checkouts: number; cancelados: number }[];
}

/** Painel → só contagens (tira a receita). PURA. */
export function countsOnly(s: BookingStats): OpsBookingCounts {
  return {
    total: s.total, reservasHoje: s.reservasHoje, checkinHoje: s.checkinHoje, checkoutHoje: s.checkoutHoje, canceladosHoje: s.canceladosHoje,
    reservasHojeNossos: s.reservasHojeNossos, reservasHojeMarketplace: s.reservasHojeMarketplace,
    reservasMes: s.reservasMes, checkinMes: s.checkinMes, checkoutMes: s.checkoutMes, canceladosMes: s.canceladosMes,
    checkinPeriodo: s.checkinPeriodo, checkoutPeriodo: s.checkoutPeriodo,
    byCity: s.byCity.map(({ name, bookings }) => ({ name, bookings })),
    byBrand: s.byBrand.map(({ name, bookings }) => ({ name, bookings })),
    byDay: s.byDay.map(({ date, reservas, checkins, checkouts, cancelados }) => ({ date, reservas, checkins, checkouts, cancelados })),
  };
}

/**
 * Geral e Dashboard das Operações: só contagens de liveOpsBookingStats —
 * basta a permissão Dashboards (22a, D5). Com as compras por pagar (D6).
 */
export async function liveOpsBookingCounts(filters?: { from?: string; to?: string; projectId?: number }, nowMs = Date.now()): Promise<OpsBookingCounts> {
  return countsOnly(await liveOpsBookingStats(filters, nowMs));
}

/** B10/B11: o valor (c/ IVA) das reservas criadas no período por cidade e por marca — só com os totais financeiros. */
export interface OpsBookingValues {
  byCity: { name: string; bookings: number; revenue: number }[];
  byBrand: { name: string; bookings: number; revenue: number }[];
}

/** A MESMA função das contagens, com o valor (procedimento com a permissão dos totais). */
export async function liveOpsBookingValues(filters?: { from?: string; to?: string; projectId?: number }, nowMs = Date.now()): Promise<OpsBookingValues> {
  const s = await liveOpsBookingStats(filters, nowMs);
  return { byCity: s.byCity, byBrand: s.byBrand };
}

/**
 * Resumo de Operações por acontecimento. `parks: "all"` (o Resumo de
 * /operacoes, B14): todos os parques, os mesmos das listas da mesma página;
 * sem a opção, só os nossos (o MCP /dashboard/summary, como sempre).
 */
export async function liveOperationsSummary(filters: { startDate: string; endDate: string; projectId?: number }, o: { includePending?: boolean; parks?: "ours" | "all" } = {}): Promise<{ actions: Record<string, OpsAction> }> {
  const all = o.parks === "all";
  const { parkIds, parkInfo } = all ? await liveOpsParkScope(filters.projectId) : await liveParkScope(filters.projectId);
  if (!parkIds.length) return { actions: summarizeOpsActions([], parkInfo) };
  const range = lisbonDayRangeUtc(filters.startDate, filters.endDate);
  const { readOpsCounts, OPS_EVENTS } = await import("./multiparkDb/opsCounts");
  const rows = all && o.includePending
    ? await readAllParksCounts({ events: OPS_EVENTS, start: range.start, end: range.end, parkIds })
    : await readOpsCounts({ events: OPS_EVENTS, start: range.start, end: range.end, parkIds, includePending: o.includePending });
  return { actions: summarizeOpsActions(rows, parkInfo) };
}
