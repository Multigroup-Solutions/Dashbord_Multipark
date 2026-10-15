/**
 * Plano 64 (B4) — "Entregas hoje / este mês" do Geral (Jorge: "passa a
 * entregas hoje mas com IVA só dos parques que operamos").
 *
 * É a MESMA leitura de "entregues" da Faturação — readFinanceAgg({ kind:
 * "delivered" }) (server/multiparkDb/financeAgg.ts): CHECKED_OUT pelo dia de
 * Lisboa da saída, valor = linhas de preço (senão o bookingPrice) —, chamada
 * DIRETAMENTE com outra lista de parques: os que OPERAMOS (os nossos + os do
 * Marketplace operado; fora os "Parques que a operação não faz"), o universo
 * das Reservas do dia. Mostra-se o valor BRUTO (c/ IVA), sem refazer a conta.
 *
 * Só LÊ: o motor (engine.ts), a Caixa (cash.ts), o liveBookings.ts e o
 * financeAgg.ts não mudam — a Faturação continua só com os parques nossos,
 * sem IVA. Lança se a BD da Multipark falhar (o cartão mostra "—").
 */
import type { LiveContext } from "./liveBookings";
import type { FinanceAggRow } from "../multiparkDb/financeAgg";
import type { SqlParam } from "../multiparkDb/client";
import { isParkExcluded } from "../../shared/reservasDoDia";
import { lisbonDayOf, lisbonDayRangeUtc } from "../../shared/lisbonDay";
import { createLiveCache } from "../multiparkDb/liveCache";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

/**
 * Os parques que OPERAMOS no âmbito: os nossos (centro ∈ `projectIds`) e os do
 * Marketplace (nó ∈ `projectIds`), menos os "Parques que a operação não faz"
 * pela regra única isParkExcluded (Definições `operations.excludedParks` OU a
 * lista por nome). Sem `projectIds` (acesso nacional) entram também os sem
 * centro, como no motor. PURA.
 */
export function operatedParkIds(
  ctx: Pick<LiveContext, "ourParks" | "parkInfo" | "marketplaceParks" | "marketplaceParkInfo">,
  projectIds: readonly number[] | undefined,
  excludedParkIds: readonly string[],
): string[] {
  const scope = projectIds ? new Set(projectIds) : null;
  const ex = new Set(excludedParkIds);
  const inScope = (pid: number | null | undefined) => !scope || (pid != null && scope.has(pid));
  const out: string[] = [];
  for (const [id, pid] of ctx.ourParks) {
    if (inScope(pid) && !isParkExcluded({ id, name: ctx.parkInfo?.get(id)?.name }, ex)) out.push(id);
  }
  for (const [id, pid] of ctx.marketplaceParks ?? new Map<string, number | null>()) {
    if (inScope(pid) && !isParkExcluded({ id, name: ctx.marketplaceParkInfo?.get(id)?.name }, ex)) out.push(id);
  }
  return out;
}

export interface DeliveryTotals { count: number; gross: number }
export interface Deliveries { day: string; monthStart: string; today: DeliveryTotals; month: DeliveryTotals }

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Linhas de "entregues" (do dia 1 do mês até hoje) → hoje e este mês, valor c/ IVA. PURA. */
export function summarizeDeliveries(rows: ReadonlyArray<Pick<FinanceAggRow, "day" | "count" | "total">>, today: string): Deliveries {
  const monthStart = `${today.slice(0, 7)}-01`;
  const t = { count: 0, gross: 0 }, m = { count: 0, gross: 0 };
  for (const r of rows) {
    if (r.day < monthStart || r.day > today) continue;
    m.count += r.count; m.gross += r.total;
    if (r.day === today) { t.count += r.count; t.gross += r.total; }
  }
  return { day: today, monthStart, today: { count: t.count, gross: r2(t.gross) }, month: { count: m.count, gross: r2(m.gross) } };
}

/** A mesma leitura a cada minuto, por parques × dias (a chave leva os parques: o âmbito de quem pede). */
const deliveriesCache = createLiveCache(60_000);
export function resetDeliveriesCache(): void { deliveriesCache.clear(); }

/**
 * Entregas de hoje e deste mês (até hoje), c/ IVA, nos parques que operamos
 * do âmbito: o mesmo âmbito do motor (financeProjectIds — a cidade/marca do
 * topo ou as cidades de quem pede). Uma leitura: do dia 1 do mês até hoje.
 */
export async function liveDeliveries(filters: { projectId?: number } = {}, nowMs = Date.now(), query?: Query): Promise<Deliveries> {
  const [{ loadLiveContext }, { financeProjectIds }, { readFinanceAgg, FINANCE_AGG_LIMIT }, { getSetting }] = await Promise.all([
    import("./liveBookings"), import("./scope"), import("../multiparkDb/financeAgg"), import("../appSettings"),
  ]);
  const today = lisbonDayOf(nowMs);
  const [ctx, projectIds, excluded] = await Promise.all([
    loadLiveContext(), financeProjectIds(filters.projectId), getSetting("operations.excludedParks"),
  ]);
  const parkIds = operatedParkIds(ctx, projectIds, (excluded as string[] | null) ?? []);
  if (!parkIds.length) return summarizeDeliveries([], today);
  const range = lisbonDayRangeUtc(`${today.slice(0, 7)}-01`, today);
  const read = () => readFinanceAgg({ kind: "delivered", start: range.start, end: range.end, parkIds }, query);
  const rows = query ? await read() : await deliveriesCache.get(JSON.stringify(["delivered", range.start, range.end, [...parkIds].sort()]), read);
  // Teto: chegar ao limite = soma cortada → erro (o cartão mostra "—"), nunca um valor a menos.
  if (rows.length >= FINANCE_AGG_LIMIT) {
    throw new Error(`Leitura incompleta: mais de ${FINANCE_AGG_LIMIT.toLocaleString("pt-PT")} linhas de entregas.`);
  }
  return summarizeDeliveries(rows, today);
}
