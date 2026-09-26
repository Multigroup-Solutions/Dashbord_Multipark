/**
 * tRPC: integrations.hub — o hub /integracoes (um cartão por fornecedor).
 * Ver: módulo "integracoes" (view). Testar: "edit" (os testes são baratos e
 * sem efeitos, mas vão a serviços externos). Nunca devolve segredos.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess } from "../_core/access";

export const integrationsHubRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "integracoes", "view");
    const { listIntegrationStatuses, encryptionKeyStatus } = await import("../integrationsStatus");
    return { now: Date.now(), encryptionKey: encryptionKeyStatus(), items: await listIntegrationStatuses() };
  }),
  test: protectedProcedure
    .input(z.object({ id: z.string().max(40) }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "integracoes", "edit");
      const { integrationTestSuperAdminOnly, testIntegration } = await import("../integrationsStatus");
      if (integrationTestSuperAdminOnly(input.id) && ctx.user.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin pode testar esta ligação." });
      }
      const r = await testIntegration(input.id);
      try {
        const { logActivity } = await import("../db");
        await logActivity({ userId: ctx.user.id, action: "test", entity: "integration", entityId: null, details: `${input.id}: ${r.ok ? "OK" : "falhou"}` } as any);
      } catch { /* o registo nunca parte o teste */ }
      return r;
    }),
});
