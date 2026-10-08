/**
 * 49c (Jorge, 8 out 2026) — quem pode voltar a entrar e como. Regras PURAS,
 * usadas no login (server/comebackLogin.ts), no "Voltei" e nos ecrãs.
 *
 *  - DESATIVADO (roubou, despedido, …, ver shared/deactivationReasons.ts): a
 *    conta fica bloqueada, como sempre.
 *  - INATIVO (inatividade, fora do país, pedido próprio, …): a conta volta a
 *    abrir como UTILIZADOR — vê a ficha, atualiza os dados e os dias livres e
 *    carrega em "Voltei". A ficha continua inativa até o RH a reativar.
 *  - Só para extras e condutores. Quem é da estrutura (team leader,
 *    supervisor, back/front office, admin…) fica bloqueado como hoje.
 *  - Os antigos "Suspenso: sem atividade…" (lote 41a, bloqueio manual) passam
 *    a inativos quando voltam a entrar.
 */
import { deactivationBlocksLogin, deactivationKind, CANDIDATE_REASON } from "./deactivationReasons";
import { ROLE_RANK } from "./access";

/** Postos que podem voltar sozinhos (o resto é estrutura). */
export const COMEBACK_POSITIONS = ["extra", "driver", "senior_driver"] as const;

export function isComebackPosition(position: string | null | undefined): boolean {
  return (COMEBACK_POSITIONS as readonly string[]).includes(String(position ?? ""));
}

/** Papel de conta de quem pode voltar sozinho: utilizador, extra ou condutor. */
export function isComebackRole(role: string | null | undefined): boolean {
  const r = ROLE_RANK[String(role ?? "") as keyof typeof ROLE_RANK];
  return r !== undefined && r <= ROLE_RANK.condutor;
}

export interface LoginFicha {
  id: number;
  position: string | null;
  isActive: number | boolean | null;
  deactivationReason?: string | null;
  blockedManually?: number | boolean | null;
  blockedByDocs?: number | boolean | null;
  blockedByPenalties?: number | boolean | null;
  loginBlockedReason?: string | null;
}

export interface LoginAccount {
  id: number;
  role: string | null;
  isActive: number | boolean | null;
  deactivationReason?: string | null;
}

/** O texto do bloqueio manual por inatividade do lote 41a ("Suspenso: sem atividade há mais de 6 meses"). PURA. */
export function isInactivitySuspensionText(text: string | null | undefined): boolean {
  return /suspenso:\s*sem atividade/i.test(String(text ?? ""));
}

/**
 * A ficha está bloqueada SÓ pela suspensão por inatividade do 41a (sem
 * documentos nem faltas a bloquear também)? PURA.
 */
export function isOnlyInactivitySuspension(f: LoginFicha): boolean {
  return !!f.blockedManually && !f.blockedByDocs && !f.blockedByPenalties && isInactivitySuspensionText(f.loginBlockedReason);
}

export type LoginComebackDecision =
  /** Nada a fazer: segue o login normal (aceita ou recusa como sempre). */
  | { kind: "none" }
  /** Conta desativada de quem está INATIVO → volta como utilizador. */
  | { kind: "reactivate"; employeeId: number }
  /** Conta ativa com a ficha "Suspensa: sem atividade" (41a) → a ficha passa a inativa e a conta a utilizador. */
  | { kind: "convert_suspension"; employeeId: number };

const on = (v: number | boolean | null | undefined) => v === true || Number(v) === 1;

/**
 * O que fazer no login com esta conta e as fichas ligadas a ela (principal ou
 * conta extra). PURA. Na dúvida, "none" (o login segue a regra de sempre:
 * conta desativada não entra).
 */
export function loginComebackDecision(account: LoginAccount, fichas: readonly LoginFicha[]): LoginComebackDecision {
  if (!fichas.length) return { kind: "none" }; // sem ficha: conta desativada à mão fica bloqueada
  if (!isComebackRole(account.role)) return { kind: "none" }; // estrutura: como hoje
  if (!fichas.every((f) => isComebackPosition(f.position))) return { kind: "none" };

  if (!on(account.isActive)) {
    // A própria conta tem um motivo de bloqueio (segurança, duplicada, roubou…)?
    if (account.deactivationReason && deactivationBlocksLogin(account.deactivationReason)) return { kind: "none" };
    // Todas as fichas inativas e nenhuma com motivo que bloqueia (sem motivo = bloqueia).
    if (fichas.some((f) => on(f.isActive))) return { kind: "none" };
    if (fichas.some((f) => deactivationBlocksLogin(f.deactivationReason))) return { kind: "none" };
    const latest = [...fichas].sort((a, b) => b.id - a.id)[0];
    return { kind: "reactivate", employeeId: latest.id };
  }

  // Conta ativa: só interessa a ficha ativa "Suspensa: sem atividade" (41a).
  const active = fichas.filter((f) => on(f.isActive));
  if (active.length === 1 && isOnlyInactivitySuspension(active[0])) return { kind: "convert_suspension", employeeId: active[0].id };
  return { kind: "none" };
}

export interface ComebackFicha {
  isActive: number | boolean | null;
  position: string | null;
  deactivationReason?: string | null;
}

/**
 * A ficha é de alguém INATIVO que pode dizer "Voltei"? Inativa, motivo que não
 * bloqueia, não é candidato (esse espera a aprovação) e é extra/condutor. PURA.
 */
export function canSayComeback(f: ComebackFicha | null | undefined): boolean {
  if (!f || on(f.isActive)) return false;
  if (!isComebackPosition(f.position)) return false;
  return deactivationKind(f.deactivationReason) === "inativo";
}

/** É a ficha de um candidato (por aprovar)? PURA. */
export function isCandidateFicha(f: { isActive: number | boolean | null; deactivationReason?: string | null } | null | undefined): boolean {
  return !!f && !on(f.isActive) && f.deactivationReason === CANDIDATE_REASON;
}

/**
 * Ao ATIVAR uma ficha (aprovar o candidato ou reativar quem voltou): a conta
 * que está como "utilizador" passa ao papel do posto. Os outros papéis ficam
 * como estão (nunca se mexe num papel dado à mão). PURA.
 */
export function roleAfterActivation(accountRole: string | null | undefined, positionRole: string): string | null {
  return accountRole === "user" && positionRole && positionRole !== "user" ? positionRole : null;
}

/** Linha do registo quando a pessoa volta a entrar. */
export const COMEBACK_LOGIN_LOG = "Voltou a entrar como utilizador; a ficha continua inativa até o RH reativar";
