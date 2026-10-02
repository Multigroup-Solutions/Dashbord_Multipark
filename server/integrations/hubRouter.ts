/**
 * tRPC: integrations.hub — o hub /integracoes (um cartão por fornecedor).
 * Ver: módulo "integracoes" (view). Testar: "edit" (os testes são baratos e
 * sem efeitos, mas vão a serviços externos). Nunca devolve segredos.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess } from "../_core/access";

const TEST_LIMIT = 10;
const TEST_WINDOW_MS = 60_000;
const recentTests = new Map<number, number[]>();
/** Até 10 testes por pessoa por minuto (por instância). PURA no essencial; exportada para os testes. */
export function hubTestAllowed(userId: number, now = Date.now()): boolean {
  const list = (recentTests.get(userId) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
  if (list.length >= TEST_LIMIT) { recentTests.set(userId, list); return false; }
  list.push(now);
  recentTests.set(userId, list);
  return true;
}

export const integrationsHubRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "integracoes", "view");
    const { listIntegrationStatusesFull, encryptionKeyStatus } = await import("../integrationsStatus");
    const { items, statusError } = await listIntegrationStatusesFull();
    // 19d: `statusError` ≠ vazio — o hub mostra "Estado desconhecido", nunca "Sem problemas"
    return { now: Date.now(), encryptionKey: encryptionKeyStatus(), items, statusError };
  }),
  test: protectedProcedure
    .input(z.object({ id: z.string().max(40) }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "integracoes", "edit");
      const { integrationTestSuperAdminOnly, testIntegration } = await import("../integrationsStatus");
      if (integrationTestSuperAdminOnly(input.id) && ctx.user.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin pode testar esta ligação." });
      }
      // 19d: limite por pessoa (há testes com custo, ex.: IA) — 10 por minuto
      if (!hubTestAllowed(ctx.user.id)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Demasiados testes seguidos — espera um minuto." });
      const r = await testIntegration(input.id, ctx.user.id);
      try {
        const { logActivity } = await import("../db");
        await logActivity({ userId: ctx.user.id, action: "test", entity: "integration", entityId: null, details: `${input.id}: ${r.ok ? "OK" : "falhou"}` } as any);
      } catch { /* o registo nunca parte o teste */ }
      return r;
    }),
});
