/**
 * Cidade de um lead de extra — regras PURAS (Jorge, 7 out 2026, no "Novo
 * lead": "deve dar para por aqui a cidade em que vai estar o extra").
 *
 *  - "Cidade *" é obrigatória ao criar; "Sem cidade" (lead visível a todas as
 *    cidades) só para quem vê todas as cidades — a mesma regra do servidor
 *    (`assertLeadCity`, que ainda confirma que é um nó de nível cidade);
 *  - quem só tem uma cidade já a tem escolhida;
 *  - converter o lead em extra pré-escolhe a cidade do lead (se for uma das
 *    cidades de quem converte), senão a única cidade de quem converte.
 */

/** Valor do seletor para "Sem cidade" (escolha explícita, só para quem vê todas). */
export const LEAD_NO_CITY = "none";

export const LEAD_CITY_REQUIRED_MSG = "Escolhe a cidade do lead.";
export const LEAD_NO_CITY_FORBIDDEN_MSG = "«Sem cidade» só para quem vê todas as cidades: escolhe a cidade do lead.";
export const LEAD_CITY_OUT_OF_SCOPE_MSG = "Essa cidade não está nas tuas cidades autorizadas.";

/**
 * Cidade de um lead novo no servidor. `scope` = projetos do âmbito de cidades
 * de quem cria (undefined = vê todas). Sem o campo (`undefined`, chamadas
 * antigas) → a cidade por omissão de quem cria (null se vê todas).
 */
export function resolveNewLeadCity(
  requested: number | null | undefined,
  ctx: { scope: readonly number[] | undefined; defaultCityId: number | null },
): { ok: true; projectId: number | null } | { ok: false; error: string } {
  if (requested === undefined) return { ok: true, projectId: ctx.defaultCityId };
  if (requested === null) return ctx.scope === undefined ? { ok: true, projectId: null } : { ok: false, error: LEAD_NO_CITY_FORBIDDEN_MSG };
  if (!Number.isSafeInteger(requested) || requested <= 0) return { ok: false, error: LEAD_CITY_REQUIRED_MSG };
  return ctx.scope === undefined || ctx.scope.includes(requested) ? { ok: true, projectId: requested } : { ok: false, error: LEAD_CITY_OUT_OF_SCOPE_MSG };
}

/** Escolha inicial do seletor no "Novo lead": a única cidade de quem cria, senão nada (obriga a escolher). */
export function defaultNewLeadCity(cityIds: readonly number[]): string {
  return cityIds.length === 1 ? String(cityIds[0]) : "";
}

/** Validação do seletor no "Novo lead" (o mesmo que o servidor diria). "" = por escolher. */
export function newLeadCityError(value: string, canChooseNoCity: boolean): string | null {
  if (!value) return LEAD_CITY_REQUIRED_MSG;
  if (value === LEAD_NO_CITY) return canChooseNoCity ? null : LEAD_NO_CITY_FORBIDDEN_MSG;
  return null;
}

/** Seletor → `projectId` do pedido ("none" → null). */
export function leadCityToProjectId(value: string): number | null {
  if (!value || value === LEAD_NO_CITY) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Cidade pré-escolhida ao converter em extra: a do lead (se for uma das de quem converte), senão a única. */
export function defaultConvertCity(lead: { projectId: number | null }, cityIds: readonly number[]): string {
  if (lead.projectId != null && cityIds.includes(lead.projectId)) return String(lead.projectId);
  return cityIds.length === 1 ? String(cityIds[0]) : "";
}
