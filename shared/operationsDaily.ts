/**
 * Série diária das Reservas & Operações: contagens por grupo (Lisboa / Porto /
 * Faro / Marketplace) juntas, por DIA DE LISBOA, com o gasto em publicidade e
 * o custo dos extras por cidade. PURO (cliente e testes).
 *
 * Duas chaves de cidade diferentes, de propósito:
 *   - `group` (grupo de origem) — só as marcas próprias ficam na cidade; é com
 *     ele que se calcula o custo de publicidade por reserva e o ROAS (os
 *     anúncios são das marcas próprias; o marketplace não tem anúncios nossos);
 *   - `cityKey` (cidade física, todas as marcas) — é com ela que se divide o
 *     custo dos extras (a equipa da cidade recolhe/entrega TODAS as marcas).
 */
import { CITY_KEYS, type CityKey } from "./city";
import { ORIGIN_GROUPS, type OriginGroup } from "./originGroup";
import { daysInRange } from "./lisbonDay";

export interface DailyBookingRow { day: string; group: OriginGroup; cityKey: CityKey | null; count: number; revenue: number }
export interface DailyCityCost { day: string; city: CityKey; cost: number }

export interface OpsDay {
  day: string;
  total: number;
  byGroup: Record<OriginGroup, number>;
  byCity: Record<CityKey, number>;               // cidade física (todas as marcas)
  revenueByGroup: Record<OriginGroup, number>;   // c/ IVA
  ads: number | null;
  adsByCity: Record<CityKey, number>;
  extras: number | null;
  extrasByCity: Record<CityKey, number>;
}

const zeroCities = (): Record<CityKey, number> => ({ lisboa: 0, porto: 0, faro: 0 });
const zeroGroups = (): Record<OriginGroup, number> => ({ lisboa: 0, porto: 0, faro: 0, marketplace: 0, sem_cidade: 0 });

export function joinOpsDaily(input: {
  startDate: string; endDate: string;
  bookings: DailyBookingRow[];
  ads?: DailyCityCost[] | null;      // null/undefined = sem permissão/sem dados → linha escondida
  extras?: DailyCityCost[] | null;
}): OpsDay[] {
  const map = new Map<string, OpsDay>();
  for (const day of daysInRange(input.startDate, input.endDate)) {
    map.set(day, {
      day, total: 0, byGroup: zeroGroups(), byCity: zeroCities(), revenueByGroup: zeroGroups(),
      ads: input.ads ? 0 : null, adsByCity: zeroCities(),
      extras: input.extras ? 0 : null, extrasByCity: zeroCities(),
    });
  }
  for (const r of input.bookings) {
    const d = map.get(r.day);
    if (!d) continue;
    d.total += r.count;
    d.byGroup[r.group] += r.count;
    d.revenueByGroup[r.group] += r.revenue;
    if (r.cityKey) d.byCity[r.cityKey] += r.count;
  }
  for (const a of input.ads ?? []) {
    const d = map.get(a.day);
    if (!d || !CITY_KEYS.includes(a.city)) continue;
    d.adsByCity[a.city] += a.cost;
    d.ads = (d.ads ?? 0) + a.cost;
  }
  for (const e of input.extras ?? []) {
    const d = map.get(e.day);
    if (!d || !CITY_KEYS.includes(e.city)) continue;
    d.extrasByCity[e.city] += e.cost;
    d.extras = (d.extras ?? 0) + e.cost;
  }
  return Array.from(map.values());
}

/** a ÷ b, ou null quando não há denominador (nunca Infinity/NaN). */
export function ratio(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || !b) return null;
  return a / b;
}

/** Totais do período por cidade: reservas (grupo), operações (cidade física), gasto, extras, receita. */
export function periodByCity(days: OpsDay[]) {
  const out = CITY_KEYS.map((city) => {
    let own = 0, ops = 0, ads = 0, extras = 0, revenue = 0;
    for (const d of days) {
      own += d.byGroup[city]; ops += d.byCity[city];
      ads += d.adsByCity[city]; extras += d.extrasByCity[city]; revenue += d.revenueByGroup[city];
    }
    return {
      city, own, ops, ads, extras, revenue,
      costPerBooking: ratio(ads, own),
      roas: ratio(revenue, ads),
      extrasPerOp: ratio(extras, ops),
    };
  });
  return out;
}

/**
 * Taxa de cancelamento por COORTE: das reservas CRIADAS no período, quantas
 * estão hoje canceladas. (Antes dividia os cancelamentos feitos no período —
 * de reservas criadas em qualquer altura — pelas criadas não canceladas: duas
 * populações diferentes, podia passar dos 100 %.)
 */
export function cohortCancelRate(created: number, cancelledOfCreated: number): number | null {
  if (!created) return null;
  return Math.min(1, Math.max(0, cancelledOfCreated / created));
}

export { ORIGIN_GROUPS };
