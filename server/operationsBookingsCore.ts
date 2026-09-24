/**
 * Núcleo PURO das folhas Reservas / Recolhas / Entregas / Cancelados:
 * classifica cada reserva (grupo Lisboa/Porto/Faro/Marketplace + canal),
 * aplica os filtros e calcula os agregados — no SERVIDOR, para o browser
 * receber só uma página de linhas e os totais já feitos.
 */
import { classifyBookingOrigin } from "../shared/bookingOrigin";
import { matchesOperationState, summarizeOperationBookings, type OperationAction } from "../shared/operationBookings";
import { bookingCityKey, originGroupOf, ORIGIN_GROUPS, type OriginGroup } from "../shared/originGroup";
import type { DailyBookingRow } from "../shared/operationsDaily";

export interface ScanRow {
  id: number; status: string | null; parkName: string | null; city: string | null;
  origin: string | null; originUrl: string | null; campaign: string | null;
  totalPrice: unknown; remainingToPay: unknown; totalPaid: unknown; paymentMethod: string | null;
  day: string; approxDate?: number | boolean | null;
}
export type PartnerMap = Map<string, { name: string; commissionRate: number }>;

export interface ScanFilters { action: OperationAction; group?: string; channel?: string; state?: string }

export function enrichScanRow(r: ScanRow, partners: PartnerMap) {
  const key = (r.campaign ?? "").trim().toLowerCase();
  const p = key ? partners.get(key) : undefined;
  const price = Number(r.totalPrice ?? 0) || 0;
  const salesPartnerName = p?.name ?? null;
  const salesPartnerCommission = p ? Math.round(price * (p.commissionRate / 100) * 100) / 100 : 0;
  const withPartner = { ...r, salesPartnerName, salesPartnerRate: p?.commissionRate ?? null, salesPartnerCommission };
  return {
    ...withPartner,
    group: originGroupOf(r) as OriginGroup,
    cityKey: bookingCityKey(r),
    channel: classifyBookingOrigin(withPartner).group,
    price,
  };
}
export type EnrichedRow = ReturnType<typeof enrichScanRow>;

/**
 * Filtra e agrega. O gráfico diário e a tabela de origens usam as linhas
 * depois do estado/pesquisa mas ANTES do filtro de grupo/canal (mostram
 * sempre os quatro grupos); o total, os cartões e a lista usam tudo.
 */
export function aggregateScan(rows: EnrichedRow[], f: ScanFilters) {
  const byState = rows.filter((r) => matchesOperationState(String(r.status ?? ""), f.action, f.state ?? "all"));
  const filtered = byState.filter((r) =>
    (!f.group || f.group === "all" || r.group === f.group) &&
    (!f.channel || f.channel === "all" || r.channel === f.channel));

  // Série diária (dia de Lisboa × grupo × cidade física)
  const dailyMap = new Map<string, DailyBookingRow>();
  const originsMap = new Map<OriginGroup, { group: OriginGroup; count: number; active: number; cancelled: number; revenue: number; channels: Map<string, number> }>();
  for (const g of ORIGIN_GROUPS) originsMap.set(g, { group: g, count: 0, active: 0, cancelled: 0, revenue: 0, channels: new Map() });
  for (const r of byState) {
    const cancelled = r.status === "CANCELLED";
    // Receita do gráfico: só o que não foi cancelado (exceto na folha dos cancelados)
    const rev = cancelled && f.action !== "cancelation" ? 0 : r.price;
    const k = `${r.day}|${r.group}|${r.cityKey ?? ""}`;
    const d = dailyMap.get(k) ?? { day: r.day, group: r.group, cityKey: r.cityKey, count: 0, revenue: 0 };
    d.count++; d.revenue += rev; dailyMap.set(k, d);
    const o = originsMap.get(r.group)!;
    o.count++; o.revenue += rev;
    if (cancelled) o.cancelled++; else o.active++;
    o.channels.set(r.channel, (o.channels.get(r.channel) ?? 0) + 1);
  }
  const origins = Array.from(originsMap.values())
    .filter((o) => o.count > 0 || o.group !== "sem_cidade")
    .map((o) => ({ ...o, channels: Array.from(o.channels, ([channel, count]) => ({ channel, count })).sort((a, b) => b.count - a.count) }));

  const summary = summarizeOperationBookings(filtered, f.action);
  const done = filtered.filter((r) => matchesOperationState(String(r.status ?? ""), f.action, "done")).length;
  const approxDates = f.action === "cancelation" ? filtered.filter((r) => !!r.approxDate).length : 0;
  return {
    filtered,
    total: filtered.length,
    cancelled: summary.cancelledCount,
    active: filtered.length - summary.cancelledCount,
    done, pending: filtered.length - done,
    approxDates,
    summary,
    daily: Array.from(dailyMap.values()),
    origins,
  };
}
