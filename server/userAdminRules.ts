/**
 * Regras PURAS da gestão de utilizadores (roles, convites) — testáveis sem BD.
 */
import { normalizeEmail } from "@shared/email";

/** Os roles reais (igual ao enum de `users.role` em drizzle/schema.ts). */
export const USER_ROLES = ["super_admin", "admin", "supervisor", "team_leader", "backoffice", "frontoffice", "condutor", "extra", "user"] as const;
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

const RANK: Record<string, number> = { user: 0, extra: 1, condutor: 2, team_leader: 3, supervisor: 4, frontoffice: 5, backoffice: 5, admin: 6, super_admin: 7 };
const rank = (r: string | null | undefined) => RANK[String(r ?? "")] ?? -1;

/**
 * Pode `actor` ligar a conta `linked` a uma ficha? Se a ficha já tem conta
 * principal (`primaryRole`), a ligada entra como conta EXTRA e HERDA o papel
 * da principal (a mesma pessoa, as mesmas permissões). Devolve o erro (PT-PT)
 * ou null. Sem isto, um admin ligava o próprio login à ficha de um
 * super_admin e ficava super_admin (ou despromovia um super_admin ao ligá-lo
 * a uma ficha de papel mais baixo).
 *  - super_admin pode tudo (o último super_admin continua protegido);
 *  - ninguém mexe em contas acima de si;
 *  - como extra, o papel herdado não pode ficar acima do de quem liga.
 */
export function linkRoleGuard(o: {
  actor: { id: number; role: string };
  linked: RoleChangeTarget;
  primaryRole: string | null;
  activeSuperAdminCount: number;
}): string | null {
  const becomes = o.primaryRole ?? o.linked.role; // principal: o papel não muda
  if (o.actor.role !== "super_admin") {
    if (rank(o.linked.role) > rank(o.actor.role)) return "Não podes ligar uma conta com um papel acima do teu.";
    if (rank(becomes) > rank(o.actor.role)) return "Esta ficha é de alguém com um papel acima do teu: só um super_admin pode ligar contas a ela.";
  }
  return superAdminGuard(o.actor.id, o.linked, becomes, o.activeSuperAdminCount);
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
