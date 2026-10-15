/**
 * "Funcionário (quem comprou)" numa despesa (Jorge, 14 out 2026): só team
 * leader e acima — sem extras nem condutores — por ordem alfabética.
 *
 * Fonte: a FICHA (cargo em `employees.position`) OU o papel da CONTA ligada
 * (`users.role`), o que for mais alto. O cargo diz o que a pessoa é no RH; o
 * papel diz o que faz no dashboard — um team leader promovido no dashboard
 * antes de o RH mudar a ficha (ou o contrário) conta na mesma. Fichas
 * inativas ficam de fora; o papel só conta se a CONTA estiver ativa.
 *
 * Diferença para shared/teamLeaderEligibility.ts (TL na escala do Extras-Dia):
 * lá decide SÓ a conta (o TL tem de entrar no dashboard para operar a escala;
 * sem conta → não). Aqui é "quem fez a compra": uma ficha com cargo de chefia
 * sem login (ex.: supervisor que não usa o dashboard) também conta. A
 * permissão "Pode ser TL na escala" não entra aqui (é da escala, não das
 * despesas). PURA.
 */
import { ROLE_RANK, roleRank } from "./access";

/** Cargos da ficha que contam como "team leader e acima". */
export const BUYER_POSITIONS: readonly string[] = ["team_leader", "supervisor", "frontoffice", "backoffice", "director"];

export interface BuyerCandidate {
  id: number;
  fullName: string | null;
  position?: string | null;
  isActive?: number | boolean | null;
  /** Papel da conta ligada à ficha (users.role), se houver. */
  accountRole?: string | null;
  /** A conta está ativa (users.isActive)? Desativada → o papel não conta. */
  accountActive?: number | boolean | null;
}

export function isExpenseBuyerEligible(c: Pick<BuyerCandidate, "position" | "isActive" | "accountRole" | "accountActive">): boolean {
  const active = c.isActive === undefined || c.isActive === null ? true : !!c.isActive;
  if (!active) return false;
  if (BUYER_POSITIONS.includes(String(c.position ?? ""))) return true;
  if (c.accountActive === 0 || c.accountActive === false) return false;
  return roleRank(c.accountRole) >= ROLE_RANK.team_leader;
}

/** Os que podem ser "quem comprou", por ordem alfabética (pt). PURA. */
export function expenseBuyerOptions(list: ReadonlyArray<BuyerCandidate>): Array<{ id: number; fullName: string }> {
  return list
    .filter((c) => isExpenseBuyerEligible(c) && String(c.fullName ?? "").trim())
    .map((c) => ({ id: c.id, fullName: String(c.fullName).trim() }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "pt", { sensitivity: "base" }) || a.id - b.id);
}

export const BUYER_NOT_ELIGIBLE_MESSAGE = "Quem comprou tem de ser team leader ou acima (sem extras nem condutores).";
