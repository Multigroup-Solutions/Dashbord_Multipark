/**
 * Abas da Actividade Diária (/operacional) que uma conta pode abrir — as
 * mesmas permissões que o servidor exige em cada leitura. Antes apareciam
 * todas e quem não tinha acesso via "sem dados" em vez do motivo. PURO.
 *   - Atividade do Dia e Ao Vivo: Actividade Diária (para além do próprio);
 *   - Histórico Diário: Histórico diário (GPS);
 *   - PDAs: PDAs;
 *   - Rádio (43b, Jorge 7 out 2026: "o rádio passa para dentro da atividade
 *     diária"): o módulo Rádio — quem só tem o Rádio também entra.
 * Quem só tem o próprio Histórico diário (condutor/extra) vê só o seu
 * histórico de velocidade (`ownSpeedOnly`).
 */
import { can, scopeFor, seesBeyondOwn, type ModuleId } from "./access";

export const OPERATIONAL_TABS = ["dia", "live", "history", "pdas", "radio"] as const;
export type OperationalTab = (typeof OPERATIONAL_TABS)[number];

type UserLike = Parameters<typeof can>[0];

export function operationalAccess(user: UserLike | null | undefined): { tabs: OperationalTab[]; ownSpeedOnly: boolean } {
  if (!user) return { tabs: [], ownSpeedOnly: false };
  const beyond = (m: ModuleId) => can(user, m, "view") && seesBeyondOwn(user, m);
  const tabs: OperationalTab[] = [];
  if (beyond("atividade_diaria")) tabs.push("dia", "live");
  if (beyond("historico_diario")) tabs.push("history");
  if (beyond("pdas")) tabs.push("pdas");
  // o próprio histórico de velocidade (condutor/extra) não se perde por ter o Rádio
  const ownSpeedOnly = !tabs.length && can(user, "historico_diario", "view") && scopeFor(user, "historico_diario") === "own";
  if (can(user, "radio", "view")) tabs.push("radio");
  return { tabs, ownSpeedOnly };
}
