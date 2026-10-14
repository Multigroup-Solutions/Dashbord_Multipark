/**
 * Condutores e agentes (Pessoas): quem vê cada separador (Jorge, 14 out 2026).
 *  - Condutores e Agentes: supervisor, admin e super admin (antes era o módulo
 *    Críticas, que inclui os team leaders — "isto só deve aparecer ao supervisor").
 *  - Desempenho: só o super admin (já era assim, 37a).
 * Front office e back office não entram: não supervisionam condutores. PURO.
 */
export const PEOPLE_MOVEMENT_ROLES = ["supervisor", "admin", "super_admin"] as const;

type RoleSubject = string | { role?: string | null } | null | undefined;

const roleOf = (u: RoleSubject): string => (typeof u === "string" ? u : String(u?.role ?? ""));

/** Vê Condutores e Agentes (a página, o menu e as consultas do servidor). */
export function canSeePeopleMovements(u: RoleSubject): boolean {
  return (PEOPLE_MOVEMENT_ROLES as readonly string[]).includes(roleOf(u));
}

/** Vê o Desempenho (o ranking de toda a gente). */
export function canSeePeoplePerformance(u: RoleSubject): boolean {
  return roleOf(u) === "super_admin";
}
