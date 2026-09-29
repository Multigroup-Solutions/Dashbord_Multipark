/**
 * Quem pode fazer a conferência de caixa (era / é): a MESMA porta da
 * Faturação → Caixa — módulo "faturacao" (ver) + totais financeiros (sem deny
 * de `finance.view_totals`). Ver server/routers.ts → requireFinanceTotals.
 */
import { canSeeFinanceTotalsFor } from "../../shared/access";
import { canAccess } from "../_core/access";

type U = { id?: number; role: string; accessOverrides?: any };

/** PURA (dados os overrides de permissão do utilizador). */
export function cashCheckAllowed(user: U | null | undefined, permissionOverrides: Record<string, string> = {}): boolean {
  if (!user) return false;
  return canAccess(user, "faturacao", "view") && canSeeFinanceTotalsFor(user, permissionOverrides);
}
