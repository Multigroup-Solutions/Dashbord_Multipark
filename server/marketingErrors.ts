/**
 * Erros do Marketing (P3 lote 19a): um erro do servidor (BD da Multipark em
 * baixo, Google, Meta) sai como erro do servidor — antes saía como
 * BAD_REQUEST ("pedido inválido") e confundia-se com datas mal escritas.
 * E um período tem máximo: sem ele, "Canais e clientes" lia todo o histórico.
 */
import { TRPCError } from "@trpc/server";

export const MARKETING_MAX_DAYS = 400;

export class MarketingInputError extends Error {}

/** Valida o período (AAAA-MM-DD, início ≤ fim, ≤ 400 dias). PURA. */
export function marketingPeriodGuard(from: string, to: string): void {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(from) || !iso.test(to)) throw new MarketingInputError("Datas inválidas (AAAA-MM-DD)");
  if (to < from) throw new MarketingInputError("O fim do período é antes do início.");
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MARKETING_MAX_DAYS) throw new MarketingInputError(`Período demasiado longo (${days} dias; máximo ${MARKETING_MAX_DAYS}). Escolhe um período mais curto.`);
}

/** Erro → TRPCError: entrada inválida = BAD_REQUEST; o resto = erro do servidor. PURA. */
export function marketingError(e: unknown): TRPCError {
  if (e instanceof TRPCError) return e;
  const message = String((e as any)?.message ?? e);
  if (e instanceof MarketingInputError || /^(Datas inválidas|Mês inválido)/.test(message)) return new TRPCError({ code: "BAD_REQUEST", message });
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
}
