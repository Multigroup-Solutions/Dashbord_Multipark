/**
 * Guardas partilhadas pelos routers (saíram do routers.ts a 1 out 2026, P2 —
 * só mudança de sítio): limiares de papel dentro de um módulo, totais
 * financeiros (deny de finance.view_totals) e o motivo de desativação.
 * A porta de cada módulo continua a ser `requireAccess` (server/_core/access).
 */
import { TRPCError } from "@trpc/server";
import { requireAccess } from "./_core/access";
import { ROLE_RANK as ACCESS_ROLE_RANK, canSeeFinanceTotalsFor, type ModuleId, type Action as AccessAction } from "../shared/access";
import { resolveDeactivation, type DeactivationInput, type ResolvedDeactivation } from "../shared/deactivationReasons";

// Hierarquia (modelo de acessos, shared/access.ts): user < extra < condutor <
// team_leader < supervisor < frontoffice = backoffice < admin < super_admin.
// A porta de cada módulo é `requireAccess(user, módulo, ação)`; `requireRole`
// fica só para limiares FINOS dentro de um módulo (ex.: só super_admin apaga).
export const ROLE_HIERARCHY: Record<string, number> = { ...ACCESS_ROLE_RANK };

export function requireRole(userRole: string, minRole: string) {
  if ((ROLE_HIERARCHY[userRole] ?? -1) < (ROLE_HIERARCHY[minRole] ?? 0)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
  }
}

/** Deny explícito de uma permissão por utilizador (regra Jorge: "menos
 * permissões por utilizador" — ex.: backoffice de despesas sem ver totais). */
export async function isPermissionDenied(userId: number, permission: string): Promise<boolean> {
  const { getUserPermissionOverrides } = await import("./db");
  const ov = await getUserPermissionOverrides(userId);
  return ov[permission] === "deny";
}

/** Totais financeiros: módulo Financeiro (admin+) sem deny de
 * finance.view_totals; um grant explícito abre-os a supervisor/front/backoffice. */
export async function canSeeFinanceTotals(user: { id: number; role: string }): Promise<boolean> {
  const { getUserPermissionOverrides } = await import("./db");
  return canSeeFinanceTotalsFor(user, await getUserPermissionOverrides(user.id));
}

/** Porta do módulo + totais financeiros (respeita o deny de finance.view_totals). */
export async function requireFinanceTotals(user: { id: number; role: string }, module: ModuleId, action: AccessAction = "view") {
  requireAccess(user, module, action);
  if (!(await canSeeFinanceTotals(user))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para ver totais financeiros." });
  }
}

/**
 * Motivo/notas da desativação pela regra ÚNICA de shared/deactivationReasons.ts
 * (usada pelos DOIS caminhos: `users.toggleActive` e `rh.setActive`). A mensagem
 * em PT do validador é a que chega ao utilizador.
 */
export function resolveDeactivationOrThrow(input: DeactivationInput): ResolvedDeactivation {
  try {
    return resolveDeactivation(input);
  } catch (err: any) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err?.message || "Motivo de desativação inválido" });
  }
}
