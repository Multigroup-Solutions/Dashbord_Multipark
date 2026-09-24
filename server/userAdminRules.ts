/**
 * Regras PURAS da gestão de utilizadores (roles, convites) — testáveis sem BD.
 */
import { normalizeEmail } from "@shared/email";

/** Os roles reais (igual ao enum de `users.role` em drizzle/schema.ts). */
export const USER_ROLES = ["super_admin", "admin", "supervisor", "team_leader", "backoffice", "frontoffice", "extra", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface RoleChangeTarget {
  id: number;
  role: string;
  isActive: number | boolean | null | undefined;
}

/**
 * Pode `actorId` mudar o role de `target` para `newRole` (ou desativá-lo,
 * `newRole = null`)? Devolve a mensagem de erro (PT-PT) ou null.
 *  - um super_admin não se despromove nem se desativa a si próprio;
 *  - nunca se tira o ÚLTIMO super_admin ativo (despromover ou desativar).
 */
export function superAdminGuard(
  actorId: number,
  target: RoleChangeTarget,
  newRole: string | null,
  activeSuperAdminCount: number,
): string | null {
  const isSuper = target.role === "super_admin";
  const losesSuper = isSuper && newRole !== "super_admin"; // despromoção ou desativação
  if (!losesSuper) return null;
  if (target.id === actorId) {
    return newRole === null
      ? "Não podes desativar a tua própria conta."
      : "Não podes retirar o teu próprio role de super_admin.";
  }
  const targetActive = target.isActive === true || Number(target.isActive) === 1;
  if (targetActive && activeSuperAdminCount <= 1) {
    return "Não é possível remover o último super_admin ativo.";
  }
  return null;
}

export interface InviteRow {
  email: string | null;
  inviteStatus: string;
  expiresAt: string | Date;
}

/**
 * Pode o utilizador com sessão (`sessionEmail`) concluir este convite?
 * Devolve { code, message } do erro ou null. O email da sessão tem de ser o
 * do convite (forma canónica) — senão qualquer pessoa com o link ficava com
 * o role da conta convidada.
 */
export function inviteCompletionError(
  invite: InviteRow | null | undefined,
  sessionEmail: string | null | undefined,
  now: Date = new Date(),
): { code: "NOT_FOUND" | "BAD_REQUEST" | "FORBIDDEN"; message: string } | null {
  if (!invite) return { code: "NOT_FOUND", message: "Token inválido" };
  if (invite.inviteStatus === "accepted") return { code: "BAD_REQUEST", message: "Convite já utilizado" };
  if (invite.inviteStatus === "expired" || now > new Date(invite.expiresAt)) return { code: "BAD_REQUEST", message: "Convite expirado" };
  const expected = normalizeEmail(invite.email);
  const actual = normalizeEmail(sessionEmail);
  if (!expected || !actual || expected !== actual) {
    return { code: "FORBIDDEN", message: `Este convite é para ${invite.email ?? "outro email"}. Entra com essa conta Google para o aceitar.` };
  }
  return null;
}
