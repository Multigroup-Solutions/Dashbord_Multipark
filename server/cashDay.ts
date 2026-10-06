/**
 * P3 lote 29d — Financeiro → Caixa → Por dia (Jorge, 6 out 2026).
 *
 * Por cidade, só os parques que operamos (marca nossa, fora da lista dos não
 * operados e dos excluídos em Definições):
 *   - recebido no dia por método (dinheiro, multibanco/TPA, online, MB Way…);
 *   - despesas do turno (Passagem de turno) e gastos lançados na contagem;
 *   - esperado em dinheiro = recebido em dinheiro − despesas; contado (soma
 *     das contagens dos parques) e a diferença;
 *   - por condutor: saídas, valor, se entregou o dinheiro ao líder
 *     (driverValidated), se a caixa foi fechada (cashierClosed) e por quem;
 *   - a correção do dia: "dia certo / não certo" com motivo (fica registado).
 *
 * 30a: o "dia" da caixa é o dia operacional — de D 03:00 a D+1 03:00 (Lisboa),
 * porque a caixa fecha no fim do turno da noite (shared/cashDayWindow.ts).
 */
import { sql } from "drizzle-orm";
import { methodKind } from "./cashCheck/externalRules";
import { isNotOperatedByName } from "../shared/multiparkParks";
import { matchCityKey } from "../shared/city";
import type { DayCheckoutRow, DayPaymentRow } from "./multiparkDb/cashDay";
import type { HandoverCity } from "./shiftExpenses";

export const CASH_DAY_CITIES: readonly HandoverCity[] = ["lisbon", "porto", "faro"];
export const CASH_DAY_CITY_LABEL: Record<HandoverCity, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
const FROM_KEY: Record<string, HandoverCity> = { lisboa: "lisbon", porto: "porto", faro: "faro" };
export const cityOfParkName = (cityName: string | null | undefined): HandoverCity | null => FROM_KEY[matchCityKey(cityName) ?? ""] ?? null;

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Parque operado por nós: marca nossa, não está na lista dos não operados nem nos excluídos. PURA. */
export function isOperatedPark(p: { id: string; name: string; ours: boolean }, excludedIds: readonly string[] = []): boolean {
  return p.ours && !isNotOperatedByName(p.name) && !excludedIds.includes(p.id);
}

export type MethodGroup = "cash" | "card" | "online" | "mbway" | "transfer" | "other";
export const METHOD_LABEL: Record<MethodGroup, string> = { cash: "Dinheiro", card: "Multibanco / TPA", online: "Online (Stripe)", mbway: "MB Way", transfer: "Transferência", other: "Outro" };

export interface CashDayAgent {
  name: string;
  /** saídas do dia e valor pago */
  bookings: number; paid: number;
  /** das quais em dinheiro */
  cashBookings: number; cashPaid: number;
  /** dinheiro ainda não entregue ao líder (driverValidated = false) */
  notDelivered: number; notDeliveredPaid: number;
  /** caixa por fechar (cashierClosed = false) */
  notClosed: number;
  /** quem fechou a caixa destas reservas */
  closedBy: string[];
}

export interface CashDayCity {
  city: HandoverCity; label: string;
  parks: Array<{ id: string; name: string; receivedCash: number; counted: number | null; countExpenses: number }>;
  byMethod: Array<{ method: MethodGroup; label: string; amount: number; count: number }>;
  receivedCash: number;
  shiftExpenses: number; shiftExpensesCount: number;
  /** gastos escritos à mão na contagem de cada parque (antes das despesas do turno) */
  countExpenses: number;
  expectedCash: number;
  /** soma do contado (null = nenhum parque contado) */
  counted: number | null; countedParks: number;
  difference: number | null;
  agents: CashDayAgent[];
  closedBy: string[];
  notClosed: number; notDelivered: number; notDeliveredPaid: number;
  review: { status: "ok" | "not_ok"; reason: string | null; byName: string | null; at: string | null } | null;
}

/** Junta tudo por cidade. PURA. */
export function buildCashDayBoard(i: {
  parks: Array<{ id: string; name: string; city: HandoverCity }>;
  payments: DayPaymentRow[];
  checkouts: DayCheckoutRow[];
  shiftExpenses: Map<HandoverCity, { total: number; count: number }>;
  counts: Array<{ parkId: string; counted: number; expenses: number }>;
  reviews: Array<{ city: string; status: string; reason: string | null; byName: string | null; at: string | null }>;
}): CashDayCity[] {
  const parkCity = new Map(i.parks.map((p) => [p.id, p.city]));
  const out: CashDayCity[] = [];
  for (const city of CASH_DAY_CITIES) {
    const parks = i.parks.filter((p) => p.city === city);
    if (!parks.length) continue;
    const ids = new Set(parks.map((p) => p.id));
    const methods = new Map<MethodGroup, { amount: number; count: number }>();
    const cashByPark = new Map<string, number>();
    for (const r of i.payments) {
      if (!ids.has(r.parkId)) continue;
      const k = methodKind(r.method) as MethodGroup;
      const m = methods.get(k) ?? { amount: 0, count: 0 };
      m.amount = r2(m.amount + r.amount); m.count += r.count;
      methods.set(k, m);
      if (k === "cash") cashByPark.set(r.parkId, r2((cashByPark.get(r.parkId) ?? 0) + r.amount));
    }
    const agents = new Map<string, CashDayAgent & { closers: Set<string> }>();
    const closedBy = new Set<string>();
    for (const r of i.checkouts) {
      if (!ids.has(r.parkId)) continue;
      const name = r.driver ?? "Sem condutor";
      const a = agents.get(name) ?? { name, bookings: 0, paid: 0, cashBookings: 0, cashPaid: 0, notDelivered: 0, notDeliveredPaid: 0, notClosed: 0, closedBy: [], closers: new Set<string>() };
      a.bookings += r.count; a.paid = r2(a.paid + r.paid);
      const cash = methodKind(r.method) === "cash";
      if (cash) { a.cashBookings += r.count; a.cashPaid = r2(a.cashPaid + r.paid); }
      if (cash && !r.driverOk) { a.notDelivered += r.count; a.notDeliveredPaid = r2(a.notDeliveredPaid + r.paid); }
      if (!r.closed) a.notClosed += r.count;
      if (r.closed && r.closedBy) { a.closers.add(r.closedBy); closedBy.add(r.closedBy); }
      agents.set(name, a);
    }
    const counts = i.counts.filter((c) => ids.has(c.parkId));
    const receivedCash = r2([...cashByPark.values()].reduce((s, v) => s + v, 0));
    const se = i.shiftExpenses.get(city) ?? { total: 0, count: 0 };
    const countExpenses = r2(counts.reduce((s, c) => s + c.expenses, 0));
    const expectedCash = r2(receivedCash - se.total - countExpenses);
    const counted = counts.length ? r2(counts.reduce((s, c) => s + c.counted, 0)) : null;
    const rv = i.reviews.find((x) => x.city === city);
    const agentList = [...agents.values()].map(({ closers, ...a }) => ({ ...a, closedBy: [...closers].sort((x, y) => x.localeCompare(y, "pt")) }))
      .sort((x, y) => y.notDelivered - x.notDelivered || y.notClosed - x.notClosed || y.bookings - x.bookings || x.name.localeCompare(y.name, "pt"));
    out.push({
      city, label: CASH_DAY_CITY_LABEL[city],
      parks: parks.map((p) => {
        const c = counts.find((x) => x.parkId === p.id);
        return { id: p.id, name: p.name, receivedCash: cashByPark.get(p.id) ?? 0, counted: c ? c.counted : null, countExpenses: c ? c.expenses : 0 };
      }),
      byMethod: [...methods.entries()].map(([method, v]) => ({ method, label: METHOD_LABEL[method], ...v })).sort((a, b) => b.amount - a.amount),
      receivedCash, shiftExpenses: se.total, shiftExpensesCount: se.count, countExpenses, expectedCash,
      counted, countedParks: counts.length, difference: counted == null ? null : r2(counted - expectedCash),
      agents: agentList, closedBy: [...closedBy].sort((x, y) => x.localeCompare(y, "pt")),
      notClosed: agentList.reduce((s, a) => s + a.notClosed, 0),
      notDelivered: agentList.reduce((s, a) => s + a.notDelivered, 0),
      notDeliveredPaid: r2(agentList.reduce((s, a) => s + a.notDeliveredPaid, 0)),
      review: rv && (rv.status === "ok" || rv.status === "not_ok") ? { status: rv.status, reason: rv.reason, byName: rv.byName, at: rv.at } : null,
    });
  }
  return out;
}

/**
 * Correção do dia: "não certo" pede sempre o motivo; "certo" com diferença
 * (≥ 1 cêntimo) também. PURA.
 */
export function dayReviewProblem(o: { status: "ok" | "not_ok"; reason?: string | null; difference: number | null }): string | null {
  const reason = (o.reason ?? "").trim();
  if (o.status === "not_ok" && reason.length < 5) return "Diz o motivo (pelo menos 5 carateres).";
  if (o.status === "ok" && o.difference != null && Math.abs(o.difference) >= 0.01 && reason.length < 5) return "Há diferença na caixa: para dar o dia como certo, diz o motivo.";
  return null;
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const DT = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/** Caixa por dia (todas as cidades no âmbito). Nunca lança por falta da Multipark: devolve { available:false }. */
export async function loadCashDay(day: string, cities: string[] | undefined) {
  const [{ readCashDay }, { buildParksSql, mapParks }, { multiparkDbQuery }, { safeMultiparkRead }, { cashDayRangeUtc, isCashDayClosed, cashDayWindowLabel, cashDayClosesAtLabel }, { getSetting }, { shiftExpensesByCity }, { getDb }] = await Promise.all([
    import("./multiparkDb/cashDay"), import("./multiparkDb/dayBookings"), import("./multiparkDb/client"), import("./multiparkDb/read"),
    import("../shared/cashDayWindow"), import("./appSettings"), import("./shiftExpenses"), import("./db"),
  ]);
  const excluded: string[] = ((await getSetting("operations.excludedParks")) as string[] | null) ?? [];
  const r = await safeMultiparkRead("caixa do dia", async () => {
    const all = mapParks(await multiparkDbQuery(buildParksSql().sql), cities);
    const parks = all.filter((p) => isOperatedPark(p, excluded)).map((p) => ({ id: p.id, name: p.label || p.name, city: cityOfParkName(p.cityName) }))
      .filter((p): p is { id: string; name: string; city: HandoverCity } => !!p.city);
    const range = cashDayRangeUtc(day); // 30a: day 03:00 → day+1 03:00 (fecho da caixa no fim do turno da noite)
    const live = await readCashDay({ parkIds: parks.map((p) => p.id), start: range.start, end: range.end });
    return { parks, ...live };
  });
  if (!r.available) return { available: false as const, reason: r.reason };
  const db = await getDb();
  const parkIds = r.data.parks.map((p) => p.id);
  const counts = db && parkIds.length ? rowsOf(await db.execute(sql`SELECT parkId, countedAmount, expensesCash FROM cash_counts WHERE day = ${day} AND shift = 'dia' AND parkId IN (${sql.join(parkIds.map((id) => sql`${id}`), sql`, `)})`)) : [];
  const reviews = db ? rowsOf(await db.execute(sql`SELECT r.city, r.status, r.reason, ${DT("r.reviewedAt")} AS at, u.name AS byName FROM cash_day_reviews r LEFT JOIN users u ON u.id = r.reviewedBy WHERE r.day = ${day}`)) : [];
  const shift = await shiftExpensesByCity(day);
  const board = buildCashDayBoard({
    parks: r.data.parks, payments: r.data.payments, checkouts: r.data.checkouts, shiftExpenses: shift,
    counts: counts.map((c) => ({ parkId: String(c.parkId), counted: Number(c.countedAmount ?? 0), expenses: Number(c.expensesCash ?? 0) })),
    reviews: reviews.map((x) => ({ city: String(x.city), status: String(x.status), reason: x.reason ?? null, byName: x.byName ?? null, at: x.at ?? null })),
  });
  return { available: true as const, day, window: cashDayWindowLabel(day), closed: isCashDayClosed(day), closesAt: cashDayClosesAtLabel(day), cities: board };
}

/** Grava a correção do dia de uma cidade (o estado atual + uma linha no registo, nunca se apaga). */
export async function saveCashDayReview(o: { day: string; city: HandoverCity; status: "ok" | "not_ok"; reason?: string | null; expected: number | null; counted: number | null; userId: number }) {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const now = utcNow();
  const reason = (o.reason ?? "").trim() || null;
  await db.execute(sql`INSERT INTO cash_day_reviews (day, city, status, reason, expectedCash, countedCash, reviewedBy, reviewedAt)
    VALUES (${o.day}, ${o.city}, ${o.status}, ${reason}, ${o.expected}, ${o.counted}, ${o.userId}, ${now})
    ON DUPLICATE KEY UPDATE status = VALUES(status), reason = VALUES(reason), expectedCash = VALUES(expectedCash), countedCash = VALUES(countedCash), reviewedBy = VALUES(reviewedBy), reviewedAt = VALUES(reviewedAt)`);
  await db.execute(sql`INSERT INTO cash_day_review_log (day, city, status, reason, expectedCash, countedCash, userId, at)
    VALUES (${o.day}, ${o.city}, ${o.status}, ${reason}, ${o.expected}, ${o.counted}, ${o.userId}, ${now})`);
}

/** Histórico da correção de um dia/cidade (mais recente primeiro). */
export async function cashDayReviewLog(day: string, city: HandoverCity) {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return [];
  const rows = rowsOf(await db.execute(sql`SELECT l.status, l.reason, l.expectedCash, l.countedCash, ${DT("l.at")} AS at, u.name AS byName FROM cash_day_review_log l LEFT JOIN users u ON u.id = l.userId
    WHERE l.day = ${day} AND l.city = ${city} ORDER BY l.at DESC, l.id DESC LIMIT 20`));
  return rows.map((x) => ({ status: String(x.status), reason: x.reason ?? null, expected: x.expectedCash == null ? null : Number(x.expectedCash), counted: x.countedCash == null ? null : Number(x.countedCash), at: x.at ?? null, byName: x.byName ?? null }));
}
