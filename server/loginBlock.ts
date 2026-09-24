/**
 * BLOQUEIO DE LOGIN (docs em falta / faltas / manual) — aplicado também no
 * SERVIDOR. Antes só a interface (DashboardLayout) mostrava o ecrã de
 * bloqueio; com a cookie válida a API continuava aberta.
 *
 * Aplica-se a quem está abaixo de admin (extras e restante operação). admin
 * e super_admin nunca ficam trancados fora por uma flag da ficha — são eles
 * que levantam o bloqueio.
 *
 * O auth.me / auth.logout são públicos e não passam por aqui: a interface
 * continua a receber a ficha (com o motivo) para mostrar o ecrã de bloqueio.
 */
const RANK: Record<string, number> = { super_admin: 7, admin: 6, supervisor: 5, team_leader: 4, backoffice: 3, frontoffice: 2, extra: 1, user: 0 };

export const LOGIN_BLOCKED_FALLBACK_MSG = "O teu acesso está bloqueado. Contacta o teu supervisor.";

export interface LoginBlockState {
  loginBlocked: number | boolean | null | undefined;
  loginBlockedReason?: string | null;
}

/** Pura: devolve a mensagem de erro (PT-PT) se o pedido deve ser recusado, senão null. */
export function loginBlockMessage(role: string, employee: LoginBlockState | null | undefined): string | null {
  if ((RANK[role] ?? 0) >= RANK.admin) return null;
  if (!employee || !employee.loginBlocked) return null;
  const reason = employee.loginBlockedReason?.trim();
  return reason ? `Acesso bloqueado: ${reason}` : LOGIN_BLOCKED_FALLBACK_MSG;
}

// Cache curta por utilizador — evita uma query extra em cada pedido. Um
// desbloqueio/bloqueio tem efeito em ≤ 30 s.
const cache = new Map<number, { value: LoginBlockState | null; expiresAt: number }>();
const TTL_MS = 30_000;

export function invalidateLoginBlock(userId?: number) {
  if (userId == null) cache.clear(); else cache.delete(userId);
}

async function loadBlockState(userId: number): Promise<LoginBlockState | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  let value: LoginBlockState | null = null;
  try {
    const { getEmployeeByUserId } = await import("./db");
    const emp = await getEmployeeByUserId(userId);
    value = emp ? { loginBlocked: emp.employee.loginBlocked, loginBlockedReason: emp.employee.loginBlockedReason } : null;
  } catch {
    return null; // BD indisponível — não tranca ninguém por falha técnica (e não guarda em cache)
  }
  cache.set(userId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

/** Mensagem de bloqueio para este utilizador (null = pode continuar). */
export async function loginBlockFor(user: { id: number; role: string }): Promise<string | null> {
  if ((RANK[user.role] ?? 0) >= RANK.admin) return null;
  return loginBlockMessage(user.role, await loadBlockState(user.id));
}
