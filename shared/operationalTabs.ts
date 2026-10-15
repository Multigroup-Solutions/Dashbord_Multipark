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
 * 12 out 2026 (Jorge):
 *   - Semana: Actividade Diária (como a Atividade do Dia);
 *   - Resumo do dia (veio da Passagem de turno): a MESMA permissão de lá,
 *     "Passagem — Resumo do dia" (supervisor e acima);
 *   - Avaliação do mês (cópia do "Mês" da Avaliação): a mesma regra do
 *     separador "Mês" — Avaliação para além do próprio (canRank).
 */
import { can, scopeFor, seesBeyondOwn, type ModuleId } from "./access";

export const OPERATIONAL_TABS = ["dia", "resumo", "semana", "mes", "live", "history", "pdas", "radio"] as const;
export type OperationalTab = (typeof OPERATIONAL_TABS)[number];

/** O separador "Mês" da Avaliação (ranking do período): Avaliação para além do próprio. A MESMA regra da AvaliacaoPage. */
export function canSeeEvaluationRanking(user: UserLike | null | undefined): boolean {
  return !!user && can(user, "avaliacao", "view") && scopeFor(user, "avaliacao") !== "own";
}

type UserLike = Parameters<typeof can>[0];

export function operationalAccess(user: UserLike | null | undefined): { tabs: OperationalTab[]; ownSpeedOnly: boolean } {
  if (!user) return { tabs: [], ownSpeedOnly: false };
  const beyond = (m: ModuleId) => can(user, m, "view") && seesBeyondOwn(user, m);
  const tabs: OperationalTab[] = [];
  if (beyond("atividade_diaria")) tabs.push("dia", "semana", "live");
  if (beyond("historico_diario")) tabs.push("history");
  if (beyond("pdas")) tabs.push("pdas");
  // o próprio histórico de velocidade (condutor/extra) não se perde por ter o Rádio
  const ownSpeedOnly = !tabs.length && can(user, "historico_diario", "view") && scopeFor(user, "historico_diario") === "own";
  if (can(user, "radio", "view")) tabs.push("radio");
  // 12 out 2026: depois de decidir o "só o próprio histórico" (como o Rádio).
  if (can(user, "passagem_resumo_dia", "view")) tabs.push("resumo");
  if (canSeeEvaluationRanking(user)) tabs.push("mes");
  return { tabs, ownSpeedOnly };
}
