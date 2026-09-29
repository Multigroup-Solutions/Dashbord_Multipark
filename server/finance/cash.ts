/**
 * CAIXA — o dinheiro, não a faturação (Faturação → separador "Caixa").
 *
 * Lê AO VIVO a BD da Multipark (./liveBookings.ts → multiparkDb/financeAgg.ts),
 * só os nossos parques — já não a cópia `multipark_bookings` (28 set 2026).
 *   - RECEBIDO = soma do pago das linhas ("BookingPricing".amountPaid) das
 *     reservas ENTREGUES (CHECKED_OUT) pelo dia de Lisboa da SAÍDA. A saída é
 *     a data usada (é aí que se cobra o que faltava; um pré-pagamento online
 *     fica datado da entrega). Por método de pagamento (texto da Multipark).
 *   - POR COBRAR = total − pago > 0 das reservas já entregues no período.
 *   - NO-SHOWS PRÉ-PAGOS = reservas BOOKED cujo check-in (dia de Lisboa) já
 *     passou e nunca entraram, com pago > 0. Não há estado NO_SHOW na
 *     Multipark; "BOOKED com check-in no passado" é a aproximação.
 *   - TAXAS DE CANCELAMENTO: não há taxa nem reembolso na BD. Só se mostra,
 *     como informação, o pago de reservas canceladas no período (data do
 *     cancelamento) — NÃO conta como receita.
 * Mesmos dias de Lisboa e o mesmo filtro de centro do motor financeiro.
 */
import { resolveProjectIds } from "../db";
import { lisbonDayOf, lisbonDayRangeUtc } from "../../shared/lisbonDay";
import { groupAgg, loadLiveBookingAgg, sumOf } from "./liveBookings";

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
  const { from, to } = filters;
  const today = filters.today ?? lisbonDayOf(Date.now());
  const projectIds = filters.projectId ? await resolveProjectIds(filters.projectId) : undefined;
  const utc = lisbonDayRangeUtc(from, to);
  // No-shows: check-in no período E antes de hoje (Lisboa), nunca entraram, com pagamento
  const todayStart = lisbonDayRangeUtc(today).start;
  const noShowEnd = todayStart < utc.end ? todayStart : utc.end;
  const [delivered, noShows, cancelled] = await Promise.all([
    loadLiveBookingAgg("delivered", utc, projectIds),
    noShowEnd > utc.start ? loadLiveBookingAgg("noshow", { start: utc.start, end: noShowEnd }, projectIds) : Promise.resolve([]),
    loadLiveBookingAgg("cancelled", utc, projectIds),
  ]);

  out.received.byDay = Array.from(groupAgg(delivered, (r) => r.day).entries())
    .map(([day, g]) => ({ day, total: sumOf(g, (r) => r.paid) })).sort((a, b) => a.day.localeCompare(b.day));
  out.received.total = sumOf(delivered, (r) => r.paid);
  out.received.count = sumOf(delivered, (r) => r.count);
  out.received.byMethod = Array.from(groupAgg(delivered, (r) => (r.paymentMethod ?? "").trim() || "Sem método").entries())
    .map(([method, g]) => ({ method, total: sumOf(g, (r) => r.paid), count: sumOf(g, (r) => r.count) }))
    .sort((a, b) => b.total - a.total);
  out.toCollect = { total: sumOf(delivered, (r) => r.remaining), count: sumOf(delivered, (r) => r.owingCount) };
  out.prepaidNoShows = { total: sumOf(noShows, (r) => r.paid), count: sumOf(noShows, (r) => r.count) };
  out.cancelledPaid = { total: sumOf(cancelled, (r) => r.paid), count: sumOf(cancelled, (r) => r.count) };
  return out;
}
