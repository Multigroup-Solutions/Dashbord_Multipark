/**
 * O âmbito das Ocorrências (plano 64, H1): os MESMOS filtros na página
 * Ocorrências (`incidents.multipark`) e no relatório semanal de operações,
 * para o número do email bater com o da página.
 *   - 44c: o corte do fecho automático (as médias por resolver com 3 dias
 *     contam como fechadas sozinhas — só muda as abertas, não o total);
 *   - as cidades de quem pede (undefined = todas: o cron não tem utilizador);
 *   - 23a (D16): sem os "Parques que a operação não faz" (Definições) e, 28a,
 *     sem os que não operamos pelo nome (lista do Jorge; o SQL só aceita ids).
 * Só leitura. Nunca lança: sem a definição ou sem a lista dos não operados,
 * fica o que se conseguiu ler (como sempre na página).
 */
import { occurrenceAutoCloseCutoff } from "../../shared/occurrenceAutoClose";
import type { OccurrenceFilters } from "./read";

export interface OccurrenceScopeFilters {
  autoCloseBefore: string;
  cities: OccurrenceFilters["cities"];
  excludedParkIds: string[];
}

export async function occurrenceFiltersFor(now: number, cities: string[] | undefined): Promise<OccurrenceScopeFilters> {
  const { getSetting } = await import("../appSettings");
  const { getNotOperatedParkIds } = await import("./dayBookings");
  const settingIds = (await getSetting("operations.excludedParks").catch(() => null)) ?? [];
  const excludedParkIds = [...new Set([...settingIds, ...(await getNotOperatedParkIds())])];
  return { autoCloseBefore: occurrenceAutoCloseCutoff(now), cities, excludedParkIds };
}
