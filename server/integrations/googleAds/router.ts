/**
 * tRPC: integrations.googleAds — estado, contas, associação a marcas/cidades,
 * recolha manual, execuções, desligar, atribuição das reservas. Só admin+.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb } from "../../db";
import { adAccounts, adCampaigns } from "../../../drizzle/schema";
import { GOOGLE_ADS_PROVIDER, OAUTH_CALLBACK_PATH, missingApiEnvs, missingOAuthEnvs, readGoogleAdsConfig } from "./config";
import { connectionSummary, disconnect, getConnection, hasStoredRefreshToken } from "./oauth";
import { isSyncStale, lastSuccessfulSyncAt, listSyncRuns, refreshAccounts, runGoogleAdsSync } from "./sync";
import { backfillBookingAttribution } from "./marketingStats";

const RANK: Record<string, number> = { super_admin: 7, admin: 6 };
function requireAdmin(role: string) {
  if ((RANK[role] ?? 0) < RANK.admin) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
}

export const googleAdsRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.user.role);
    const cfg = readGoogleAdsConfig();
    const conn = await getConnection();
    const db = await getDb();
    const accounts = db ? await db.select().from(adAccounts).where(eq(adAccounts.provider, GOOGLE_ADS_PROVIDER)) : [];
    const campaignsCount = db ? (await db.select({ n: adCampaigns.id }).from(adCampaigns).where(eq(adCampaigns.provider, GOOGLE_ADS_PROVIDER))).length : 0;
    return {
      ...connectionSummary(conn),
      hasRefreshToken: await hasStoredRefreshToken(),
      config: {
        missingOAuth: missingOAuthEnvs(cfg),
        missingApi: missingApiEnvs(cfg),
        apiVersion: cfg.apiVersion,
        redirectUri: cfg.redirectUri ?? `(derivado do host)${OAUTH_CALLBACK_PATH}`,
        loginCustomerId: cfg.loginCustomerId,
      },
      accounts: { total: accounts.length, selected: accounts.filter((a) => a.selected).length, managers: accounts.filter((a) => a.isManager).length },
      campaignsCount,
      lastSuccessfulSyncAt: await lastSuccessfulSyncAt(),
      stale: await isSyncStale(),
    };
  }),

  accounts: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireAdmin(ctx.user.role);
      const db = await getDb();
      if (!db) return [];
      return db.select().from(adAccounts).where(eq(adAccounts.provider, GOOGLE_ADS_PROVIDER)).orderBy(adAccounts.isManager, adAccounts.name);
    }),
    refresh: protectedProcedure.mutation(async ({ ctx }) => {
      requireAdmin(ctx.user.role);
      return refreshAccounts();
    }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), selected: z.boolean().optional(), projectId: z.number().nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAdmin(ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const patch: Record<string, unknown> = {};
        if (input.selected !== undefined) patch.selected = input.selected ? 1 : 0;
        if (input.projectId !== undefined) patch.projectId = input.projectId;
        await db.update(adAccounts).set(patch).where(and(eq(adAccounts.id, input.id), eq(adAccounts.provider, GOOGLE_ADS_PROVIDER)));
        return { success: true };
      }),
  }),

  campaigns: router({
    list: protectedProcedure.input(z.object({ accountId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
      requireAdmin(ctx.user.role);
      const db = await getDb();
      if (!db) return [];
      const conds = [eq(adCampaigns.provider, GOOGLE_ADS_PROVIDER)];
      if (input?.accountId) conds.push(eq(adCampaigns.accountId, input.accountId));
      return db.select().from(adCampaigns).where(and(...conds)).orderBy(adCampaigns.name);
    }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), projectId: z.number().nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireAdmin(ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        await db.update(adCampaigns).set({ projectId: input.projectId }).where(eq(adCampaigns.id, input.id));
        return { success: true };
      }),
    // Sugestões marca/cidade pelo NOME da campanha ("Airpark - Faro - EN") e
    // pela marca da conta — regra pura em shared/adCampaignMapping.ts.
    // Só campanhas ainda sem marca/cidade; o Jorge confirma antes de aplicar.
    suggest: protectedProcedure.query(async ({ ctx }) => {
      requireAdmin(ctx.user.role);
      const db = await getDb();
      if (!db) return [];
      const { suggestCampaignProjects } = await import("../../../shared/adCampaignMapping");
      const { getProjects } = await import("../../db");
      const rows = await db.select({ id: adCampaigns.id, name: adCampaigns.name, projectId: adCampaigns.projectId, accountProjectId: adAccounts.projectId })
        .from(adCampaigns).leftJoin(adAccounts, eq(adAccounts.id, adCampaigns.accountId)).where(eq(adCampaigns.provider, GOOGLE_ADS_PROVIDER));
      return suggestCampaignProjects(rows, await getProjects());
    }),
    applySuggestions: protectedProcedure
      .input(z.object({ campaignIds: z.array(z.number().int().positive()).max(500).optional() }).optional())
      .mutation(async ({ ctx, input }) => {
        requireAdmin(ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const { suggestCampaignProjects } = await import("../../../shared/adCampaignMapping");
        const { getProjects, logActivity } = await import("../../db");
        const rows = await db.select({ id: adCampaigns.id, name: adCampaigns.name, projectId: adCampaigns.projectId, accountProjectId: adAccounts.projectId })
          .from(adCampaigns).leftJoin(adAccounts, eq(adAccounts.id, adCampaigns.accountId)).where(eq(adCampaigns.provider, GOOGLE_ADS_PROVIDER));
        const wanted = input?.campaignIds ? new Set(input.campaignIds) : null;
        const suggestions = suggestCampaignProjects(rows, await getProjects()).filter((s) => !wanted || wanted.has(s.campaignId));
        for (const s of suggestions) {
          // Nunca sobrepõe uma marca/cidade já escolhida à mão (só as NULL).
          await db.update(adCampaigns).set({ projectId: s.projectId }).where(and(eq(adCampaigns.id, s.campaignId), sql`${adCampaigns.projectId} IS NULL`));
        }
        await logActivity({ userId: ctx.user.id, action: "map", entity: "ad_campaigns", details: `Marca/cidade sugerida pelo nome aplicada a ${suggestions.length} campanha(s) Google Ads` });
        return { applied: suggestions.length, suggestions };
      }),
  }),

  sync: router({
    run: protectedProcedure
      .input(z.object({ kind: z.enum(["initial", "daily", "monthly", "manual", "hourly", "nightly"]).default("manual") }))
      .mutation(async ({ ctx, input }) => {
        requireAdmin(ctx.user.role);
        // prazo curto: no Vercel a função tem 60 s; o resultado diz se ficou parcial
        return runGoogleAdsSync({ kind: input.kind, deadlineAt: Date.now() + 40_000, triggeredById: ctx.user.id });
      }),
    runs: protectedProcedure.input(z.object({ limit: z.number().min(1).max(100).optional() }).optional()).query(async ({ ctx, input }) => {
      requireAdmin(ctx.user.role);
      return listSyncRuns(input?.limit ?? 20);
    }),
  }),

  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    requireAdmin(ctx.user.role);
    await disconnect();
    return { success: true };
  }),

  backfillAttribution: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(5000).optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.user.role);
      return backfillBookingAttribution(input?.limit ?? 1000);
    }),
});
