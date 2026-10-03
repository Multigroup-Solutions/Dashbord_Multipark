/**
 * Entrada e navegação (P3 lote 20d): que ecrãs abrem para quem, sem
 * depender só do menu. PURO (testado no servidor).
 */

/** Ecrãs pessoais: abrem para TODOS (extra e condutor incluídos), estejam ou não no menu. */
export const PERSONAL_ROUTES = ["/perfil", "/modulos"] as const;

/**
 * Sem centro de custos atribuído, além dos pessoais abre o que o servidor
 * também deixa à própria pessoa (server/cityAccess.ts: isPersonalAccessPath /
 * ownRecordEmployeeId): a própria ficha, a disponibilidade e a avaliação.
 */
export const NO_COST_CENTER_ROUTES = [...PERSONAL_ROUTES, "/rh", "/disponibilidade", "/avaliacao"] as const;

/** Ecrãs de entrada: quem não os pode ver é levado para o seu (não é "sem acesso"). */
export const LANDING_ROUTES = ["/", "/dashboard", "/dashboards"] as const;

/** "/rh/123" → "/rh". PURA. */
export function routeBase(path: string): string {
  return "/" + (String(path ?? "").split("?")[0].split("/")[1] ?? "");
}

const has = (list: readonly string[], path: string) => list.includes(path) || list.includes(routeBase(path));

export function isPersonalRoute(path: string): boolean {
  return has(PERSONAL_ROUTES, path);
}

export function allowedWithoutCostCenter(path: string): boolean {
  return has(NO_COST_CENTER_ROUTES, path);
}

export type RouteDecision = { kind: "ok" } | { kind: "redirect"; to: string } | { kind: "no_access" };

/**
 * O que fazer com um caminho (PURA):
 *  - pessoal ou no menu da pessoa → abre;
 *  - ecrã de entrada que a pessoa não vê → leva para o primeiro do menu dela;
 *  - extra/condutor (papel baixo) fora do menu, ou qualquer pessoa num ecrã
 *    do menu que não é para ela → "Sem acesso" (antes saltava em silêncio
 *    para outra página, e o Perfil nem abria a um extra).
 *  - páginas fora do menu (fichas, detalhes) para os outros papéis → abre (o
 *    servidor decide o que mostra).
 */
export function decideRoute(o: {
  path: string;
  allowedPaths: ReadonlySet<string>;
  allMenuPaths: ReadonlySet<string>;
  lowRole: boolean;
  firstAllowed: string;
}): RouteDecision {
  const { path, allowedPaths, allMenuPaths, lowRole } = o;
  const base = routeBase(path);
  if (isPersonalRoute(path)) return { kind: "ok" };
  if (allowedPaths.has(path) || allowedPaths.has(base)) return { kind: "ok" };
  if ((LANDING_ROUTES as readonly string[]).includes(path)) return { kind: "redirect", to: o.firstAllowed };
  if (lowRole) return { kind: "no_access" };
  if (allMenuPaths.has(path)) return { kind: "no_access" };
  return { kind: "ok" };
}
