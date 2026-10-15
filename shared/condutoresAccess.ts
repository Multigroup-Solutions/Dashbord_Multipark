/**
 * Pessoas → Condutores e agentes: quem vê o quê (Jorge, 14 out 2026: "isto
 * não devia aparecer a toda a gente"). PURO — o mesmo no menu, na página e
 * nos testes; o servidor confirma com requireAccess (módulo
 * `condutores_agentes`) e, no Desempenho, com o papel.
 *
 *  - Condutores e Agentes: módulo `condutores_agentes` — supervisor (as
 *    cidades dele), back office, admin e super admin (shared/access.ts). Front
 *    office e team leader não. Uma permissão por pessoa (Permissões) pode
 *    dar ou tirar o módulo, como os outros.
 *  - Desempenho: só o super admin, pelo PAPEL (nenhuma permissão por pessoa o
 *    abre — evaluation.peoplePerformance também só olha para o papel).
 */
import { can, type AccessOverrides } from "./access";

export const CONDUTORES_MODULE = "condutores_agentes" as const;
export const CONDUTORES_TABS = ["drivers", "agents", "performance"] as const;
export type CondutoresTab = (typeof CONDUTORES_TABS)[number];

type UserLike = { role: string | null | undefined; accessOverrides?: AccessOverrides | null } | null | undefined;

/** Separadores que esta pessoa vê, pela ordem do ecrã ([] = sem acesso à página). PURA. */
export function condutoresTabs(user: UserLike): CondutoresTab[] {
  if (!user) return [];
  const tabs: CondutoresTab[] = [];
  if (can(user, CONDUTORES_MODULE, "view")) tabs.push("drivers", "agents");
  if (user.role === "super_admin") tabs.push("performance");
  return tabs;
}

/** O separador com que a página abre: o pedido (se o vê), senão o primeiro. PURA. */
export function initialCondutoresTab(tabs: readonly CondutoresTab[], wanted: CondutoresTab | null): CondutoresTab | null {
  if (wanted && tabs.includes(wanted)) return wanted;
  return tabs[0] ?? null;
}
