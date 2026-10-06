/**
 * Quem pode fazer a conferência de caixa (era / é): a porta da Caixa —
 * módulo "caixa" (29c: item próprio no menu) ou, para quem já o tinha, o da
 * "faturacao" — + totais financeiros (sem deny de `finance.view_totals`).
 * Ver server/routers.ts → requireFinanceTotals.
 */
import type { Action } from "../../shared/access";
import { canSeeFinanceTotalsFor } from "../../shared/access";
import { canAccess } from "../_core/access";

type U = { id?: number; role: string; accessOverrides?: any };

/**
 * 29c: módulo que dá esta ação na Caixa a este utilizador — "caixa" se o
 * tiver, senão "faturacao" (quem já tinha a Faturação continua com a Caixa;
 * a Caixa pode dar-se sozinha a quem faz a correção). PURA.
 */
export function cashModuleFor(user: U | null | undefined, action: Action = "view"): "caixa" | "faturacao" {
  return user && canAccess(user, "caixa", action) ? "caixa" : "faturacao";
}

/** Tem esta ação na Caixa (pelo módulo da Caixa ou pelo da Faturação)? PURA. */
export function canCash(user: U | null | undefined, action: Action = "view"): boolean {
  return !!user && (canAccess(user, "caixa", action) || canAccess(user, "faturacao", action));
}

/** PURA (dados os overrides de permissão do utilizador). */
export function cashCheckAllowed(user: U | null | undefined, permissionOverrides: Record<string, string> = {}): boolean {
  if (!user) return false;
  return canCash(user, "view") && canSeeFinanceTotalsFor(user, permissionOverrides);
}
