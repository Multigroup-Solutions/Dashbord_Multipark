/**
 * Visibilidade por cidade no recrutamento de extras (ponto 10): candidaturas,
 * leads e conversas do WhatsApp. Quem só tem acesso a uma cidade deixa de ver
 * as das outras. O que não se consegue ligar a nenhuma cidade continua visível
 * (melhor ver a mais do que perder um candidato).
 */
import { cityScope, scopedProjectIds } from "./cityScope";
import { matchCityKey, type CityKey } from "../shared/city";

/** projectId dentro do âmbito do utilizador? `scope` undefined = todas as cidades. */
export function projectVisible(projectId: number | null | undefined, scope: number[] | undefined): boolean {
  if (scope === undefined || projectId == null) return true;
  return scope.includes(projectId);
}

/** Cidade escrita à mão (candidatura do site) dentro das cidades do utilizador? */
export function cityTextVisible(text: string | null | undefined, allowed: CityKey[] | undefined): boolean {
  if (allowed === undefined) return true;
  const key = matchCityKey(text ?? "");
  return key == null || allowed.includes(key);
}

/** Cidades (lisboa/porto/faro) do utilizador atual; undefined = todas. */
export function currentCityKeys(): CityKey[] | undefined {
  const access = cityScope.getStore();
  if (!access || access.all) return undefined;
  const names = access.cityNames ?? (access.cityName ? [access.cityName] : []);
  return names.map((n) => matchCityKey(n)).filter((k): k is CityKey => k != null);
}

export { scopedProjectIds };

/** Cidade por omissão de quem cria (null se vê todas). */
export function currentDefaultCityId(): number | null {
  const access = cityScope.getStore();
  if (!access || access.all) return null;
  return access.defaultCityId ?? access.cityIds[0] ?? null;
}
