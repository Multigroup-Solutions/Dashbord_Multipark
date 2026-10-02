/**
 * Extras Dia — que euros cada conta vê (P3 lote 15c). As mesmas regras no
 * servidor (que tira os valores) e no ecrã (que esconde as colunas):
 *  - custos e taxas dos extras: quem planeia a escala (Extras Dia "edit");
 *  - custo do team leader (vem do salário: custo × 15 = ordenado): só quem
 *    vê salários (RH — ordenados) ou os totais financeiros.
 * Quem só vê a escala (ex.: condutor) fica com escalas e turnos, sem euros.
 */
import { can } from "./access";

type UserLike = Parameters<typeof can>[0];

export interface ExtrasCostView { costs: boolean; salaries: boolean }

export function extrasCostView(user: UserLike | null | undefined, opts: { financeTotals: boolean }): ExtrasCostView {
  if (!user) return { costs: false, salaries: false };
  return { costs: can(user, "extras_dia", "edit"), salaries: can(user, "rh_salarios", "view") || opts.financeTotals };
}

/** Tira as taxas e os euros de um texto ("Júnior 4,50 €/h" → "Júnior"; "(24h, 108,00 €)" → "(24h)"). PURA. */
export function stripEuros(text: string): string {
  return text
    .replace(/\s*\d+(?:[.,]\d+)?\s*€\/h/g, "")
    .replace(/,\s*\d+(?:[.,]\d+)?\s*€\)/g, ")")
    .replace(/\s*\d+(?:[.,]\d+)?\s*€/g, "");
}

/** Linha da escala sem os euros que a conta não vê (custo null = escondido). PURA. */
export function maskAssignmentCost<T extends { isTeamLeader: boolean; cost: number; proposalReason: string | null }>(a: T, v: ExtrasCostView): Omit<T, "cost"> & { cost: number | null } {
  const hide = a.isTeamLeader ? !v.salaries : !v.costs;
  return {
    ...a,
    cost: hide ? null : a.cost,
    proposalReason: !v.costs && a.proposalReason ? stripEuros(a.proposalReason) : a.proposalReason,
  };
}
