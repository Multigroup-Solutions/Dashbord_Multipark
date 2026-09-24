/**
 * CAIXA — o dinheiro, não a faturação (Faturação → separador "Caixa").
 *
 * O que as colunas de `multipark_bookings` permitem (e o que falta):
 *   - RECEBIDO = SUM(totalPaid) das reservas ENTREGUES (CHECKED_OUT) pelo dia
 *     de Lisboa da SAÍDA. Não há data de pagamento na BD (nem por pagamento
 *     parcial); a saída é a melhor data disponível: é aí que se cobra o que
 *     faltava, e um pré-pagamento online fica datado da entrega (não da
 *     compra). Por método de pagamento (`paymentMethod`, texto livre da
 *     Multipark).
 *   - POR COBRAR = SUM(remainingToPay) > 0 das reservas já entregues no
 *     período (carro saiu e ficou valor em dívida).
 *   - NO-SHOWS PRÉ-PAGOS = reservas BOOKED cujo check-in (dia de Lisboa) já
 *     passou e nunca entraram, com totalPaid > 0. Não há estado NO_SHOW na
 *     Multipark; "BOOKED com check-in no passado" é a aproximação.
 *   - TAXAS DE CANCELAMENTO: NÃO existem na BD (nem taxa nem reembolso). Só se
 *     mostra, como informação, o valor pago de reservas canceladas no período
 *     (pode ter sido reembolsado) — NÃO conta como receita.
 * Mesmos dias de Lisboa e o mesmo filtro de centro do motor financeiro.
 */
import { and, eq, gt, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { multiparkBookings } from "../../drizzle/schema";
import { getDb, resolveProjectIds } from "../db";
import { lisbonDayOf, lisbonDayRangeUtc } from "../../shared/lisbonDay";
import { bookingLisbonDay, deliveredConditions } from "./engine";

export interface CashResult {
  range: { from: string; to: string };
  dateBasis: string;
  received: { total: number; count: number; byMethod: Array<{ method: string; total: number; count: number }>; byDay: Array<{ day: string; total: number }> };
  toCollect: { total: number; count: number };
  prepaidNoShows: { total: number; count: number };
  cancelledPaid: { total: number; count: number };
  /** null = a BD não tem o dado (taxa/reembolso de cancelamento) */
  cancellationFees: null;
  missing: string[];
}

const num = (v: unknown) => Number(v ?? 0) || 0;

export const CASH_MISSING_DATA = [
  "Data de pagamento (só há o total pago; usa-se a data de saída)",
  "Pagamentos parciais / reembolsos por data",
  "Taxa de cancelamento e reembolso das canceladas",
  "Estado NO_SHOW (aproxima-se por BOOKED com check-in passado)",
];

export async function computeCash(filters: { from: string; to: string; projectId?: number; today?: string }): Promise<CashResult> {
  const out: CashResult = {
    range: { from: filters.from, to: filters.to },
    dateBasis: "Dia de Lisboa da saída (checkOut) — não há data de pagamento",
    received: { total: 0, count: 0, byMethod: [], byDay: [] },
    toCollect: { total: 0, count: 0 },
    prepaidNoShows: { total: 0, count: 0 },
    cancelledPaid: { total: 0, count: 0 },
    cancellationFees: null,
    missing: CASH_MISSING_DATA,
  };
  const db = await getDb();
  if (!db) return out;
  const { from, to } = filters;
  const today = filters.today ?? lisbonDayOf(Date.now());
  const projectIds = filters.projectId ? await resolveProjectIds(filters.projectId) : undefined;
  const scope: SQL[] = projectIds ? [inArray(multiparkBookings.projectId, projectIds)] : [];
  const utc = lisbonDayRangeUtc(from, to);
  const delivered = deliveredConditions(from, to, projectIds);
  const dayExpr = bookingLisbonDay("checkOut", from, to);

  const byDay = await db.select({ day: dayExpr, count: sql<number>`COUNT(*)`, total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPaid}), 0)` })
    .from(multiparkBookings).where(and(...delivered)).groupBy(dayExpr);
  // agrupa pela coluna (ONLY_FULL_GROUP_BY); vazios juntam-se em JS
  const byMethod = await db.select({ method: multiparkBookings.paymentMethod, count: sql<number>`COUNT(*)`, total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPaid}), 0)` })
    .from(multiparkBookings).where(and(...delivered)).groupBy(multiparkBookings.paymentMethod);
  const [toCollect] = await db.select({ count: sql<number>`COUNT(*)`, total: sql<number>`COALESCE(SUM(${multiparkBookings.remainingToPay}), 0)` })
    .from(multiparkBookings).where(and(...delivered, gt(multiparkBookings.remainingToPay, "0")));
  // No-shows: check-in no período E antes de hoje (Lisboa), nunca entraram, com pagamento
  const noShowEnd = lisbonDayRangeUtc(today).start < utc.end ? lisbonDayRangeUtc(today).start : utc.end;
  const [noShows] = await db.select({ count: sql<number>`COUNT(*)`, total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPaid}), 0)` })
    .from(multiparkBookings).where(and(eq(multiparkBookings.status, "BOOKED"), gte(multiparkBookings.checkIn, utc.start), lt(multiparkBookings.checkIn, noShowEnd), gt(multiparkBookings.totalPaid, "0"), ...scope));
  const [cancelled] = await db.select({ count: sql<number>`COUNT(*)`, total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPaid}), 0)` })
    .from(multiparkBookings).where(and(eq(multiparkBookings.status, "CANCELLED"), gte(multiparkBookings.cancelledAt, utc.start), lt(multiparkBookings.cancelledAt, utc.end), gt(multiparkBookings.totalPaid, "0"), ...scope));

  out.received.byDay = byDay.map((r) => ({ day: String(r.day ?? "").slice(0, 10), total: num(r.total) })).sort((a, b) => a.day.localeCompare(b.day));
  out.received.total = byDay.reduce((s, r) => s + num(r.total), 0);
  out.received.count = byDay.reduce((s, r) => s + num(r.count), 0);
  const methods = new Map<string, { method: string; total: number; count: number }>();
  for (const r of byMethod) {
    const method = String(r.method ?? "").trim() || "Sem método";
    const ex = methods.get(method) ?? { method, total: 0, count: 0 };
    ex.total += num(r.total); ex.count += num(r.count);
    methods.set(method, ex);
  }
  out.received.byMethod = Array.from(methods.values()).sort((a, b) => b.total - a.total);
  out.toCollect = { total: num(toCollect?.total), count: num(toCollect?.count) };
  out.prepaidNoShows = { total: num(noShows?.total), count: num(noShows?.count) };
  out.cancelledPaid = { total: num(cancelled?.total), count: num(cancelled?.count) };
  return out;
}
