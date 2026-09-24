/**
 * tRPC: integrations.meta — estado da integração Meta Ads (configurada ou não,
 * contas, última recolha, erros), marca/cidade das contas, recolha manual.
 * Só admin+. A associação campanha → marca/cidade usa a mesma rota do Google
 * (integrations.googleAds.campaigns.update) e a mesma tabela ad_campaigns.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { requireAccess } from "../../_core/access";
import { getDb } from "../../db";
import { adAccounts } from "../../../drizzle/schema";
import { META_PROVIDER } from "./config";
import { listMetaSyncRuns, metaStatus, runMetaAdsSync } from "./sync";


export const metaAdsRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "integracoes", "view");
    return metaStatus();
  }),
  accounts: router({
    update: protectedProcedure
      .input(z.object({ id: z.number(), selected: z.boolean().optional(), projectId: z.number().nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "integracoes", "manage");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const patch: Record<string, unknown> = {};
        if (input.selected !== undefined) patch.selected = input.selected ? 1 : 0;
        if (input.projectId !== undefined) patch.projectId = input.projectId;
        await db.update(adAccounts).set(patch).where(and(eq(adAccounts.id, input.id), eq(adAccounts.provider, META_PROVIDER)));
        return { success: true };
      }),
  }),
  sync: router({
    run: protectedProcedure
      .input(z.object({ kind: z.enum(["initial", "daily", "monthly", "manual"]).default("daily") }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "integracoes", "edit");
        return runMetaAdsSync({ kind: input.kind, deadlineAt: Date.now() + 40_000, triggeredById: ctx.user.id });
      }),
    runs: protectedProcedure.input(z.object({ limit: z.number().min(1).max(100).optional() }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "integracoes", "view");
      return listMetaSyncRuns(input?.limit ?? 10);
    }),
  }),
});
