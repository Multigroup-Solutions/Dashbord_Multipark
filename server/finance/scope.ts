/**
 * Que centros cobre um cálculo financeiro (FM02, P1 — 1 out 2026).
 *
 * Com `projectId`: esse centro e os descendentes. SEM ele, o ALCANCE DE
 * CIDADE do pedido (cityScope): antes um pedido sem centro escolhido dava os
 * totais NACIONAIS a quem só vê a sua cidade (ex.: um supervisor com
 * "ver totais financeiros"). Sem utilizador (crons, relatórios) ou com acesso
 * nacional → `undefined` = todos os centros, como sempre.
 */
import { scopedProjectIds } from "../cityScope";
import { resolveProjectIds } from "../db";

export async function financeProjectIds(projectId?: number | null): Promise<number[] | undefined> {
  if (projectId) return resolveProjectIds(projectId);
  return scopedProjectIds();
}
