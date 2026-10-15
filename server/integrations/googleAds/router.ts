/**
 * tRPC: integrations.googleAds — estado, contas, associação a marcas/cidades,
 * recolha manual, execuções, desligar. Só admin+; desligar só super admin (19b).
 * Mudanças de contas/campanhas e o desligar ficam registados (antes → depois).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { requireAccess } from "../../_core/access";
import { getDb, logActivity } from "../../db";
import { adAccounts, adCampaigns } from "../../../drizzle/schema";
import { GOOGLE_ADS_PROVIDER, OAUTH_CALLBACK_PATH, missingApiEnvs, missingOAuthEnvs, readGoogleAdsConfig } from "./config";
import { connectionSummary, disconnect, getConnection, hasStoredRefreshToken } from "./oauth";
import { isSyncStale, lastSuccessfulSyncAt, listSyncRuns, refreshAccounts, runGoogleAdsSync } from "./sync";
import { CAMPAIGN_SUGGEST_PROVIDERS as SUGGEST_PROVIDERS } from "../../../shared/adCampaignMapping";


export const googleAdsRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "integracoes", "view");
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
      // 8 out 2026: leitura dos cliques (gclid → campanha): último dia lido e dias em falta
      clicks: await (await import("./clicks")).clickSyncStatus(),
    };
  }),

  accounts: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "integracoes", "view");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
      return db.select().from(adAccounts).where(eq(adAccounts.provider, GOOGLE_ADS_PROVIDER)).orderBy(adAccounts.isManager, adAccounts.name);
    }),
    refresh: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "integracoes", "edit");
      return refreshAccounts();
    }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), selected: z.boolean().optional(), projectId: z.number().nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "integracoes", "manage");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const [before] = await db.select().from(adAccounts).where(and(eq(adAccounts.id, input.id), eq(adAccounts.provider, GOOGLE_ADS_PROVIDER))).limit(1);
        if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Conta não encontrada" });
        const patch: Record<string, unknown> = {};
        if (input.selected !== undefined) patch.selected = input.selected ? 1 : 0;
        if (input.projectId !== undefined) patch.projectId = input.projectId;
        if (!Object.keys(patch).length) return { success: true };
        await db.update(adAccounts).set(patch).where(and(eq(adAccounts.id, input.id), eq(adAccounts.provider, GOOGLE_ADS_PROVIDER)));
        // 19b: fica registado quem mudou o quê (antes não havia rasto)
        const changes: string[] = [];
        if (input.selected !== undefined && !!before.selected !== input.selected) changes.push(input.selected ? "passa a ser recolhida" : "deixa de ser recolhida (o gasto já recolhido continua a contar)");
        if (input.projectId !== undefined && (before.projectId ?? null) !== input.projectId) changes.push(`marca/cidade #${before.projectId ?? "—"} → #${input.projectId ?? "—"}`);
        if (changes.length) await logActivity({ userId: ctx.user.id, action: "update", entity: "ad_accounts", entityId: before.id, details: `Google Ads, conta ${before.name ?? before.customerId} (${before.customerId}): ${changes.join("; ")}` });
        return { success: true };
      }),
  }),

  campaigns: router({
    list: protectedProcedure.input(z.object({ accountId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "marketing", "view");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
      const conds = [eq(adCampaigns.provider, GOOGLE_ADS_PROVIDER)];
      if (input?.accountId) conds.push(eq(adCampaigns.accountId, input.accountId));
      return db.select().from(adCampaigns).where(and(...conds)).orderBy(adCampaigns.name);
    }),
    // Marca/cidade de UMA campanha. scope 'national' = da marca, sem cidade
    // (Brand, Pmax, Portugal) → projectId fica NULL de propósito.
    update: protectedProcedure
      .input(z.object({ id: z.number(), projectId: z.number().nullable(), scope: z.enum(["city", "national"]).optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "marketing", "manage");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const scope = input.scope ?? "city";
        const [before] = await db.select({ id: adCampaigns.id, name: adCampaigns.name, provider: adCampaigns.provider, projectId: adCampaigns.projectId, scope: adCampaigns.scope }).from(adCampaigns).where(eq(adCampaigns.id, input.id)).limit(1);
        if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Campanha não encontrada" });
        const projectId = scope === "national" ? null : input.projectId;
        await db.update(adCampaigns).set({ projectId, scope }).where(eq(adCampaigns.id, input.id));
        if ((before.projectId ?? null) !== projectId || before.scope !== scope) {
          const show = (sc: string | null, p: number | null) => (sc === "national" ? "nacional" : p == null ? "por associar" : `#${p}`);
          await logActivity({ userId: ctx.user.id, action: "map", entity: "ad_campaigns", entityId: before.id, details: `Campanha ${before.provider === "meta" ? "Meta" : "Google Ads"} «${before.name ?? before.id}»: ${show(before.scope, before.projectId ?? null)} → ${show(scope, projectId)}` });
        }
        return { success: true };
      }),
    // Sugestões marca/cidade pelo NOME da campanha ("Airpark - Faro - EN") e
    // pela marca da conta — regra pura em shared/adCampaignMapping.ts.
    // Google Ads E Meta (a mesma tabela ad_campaigns).
    // Só campanhas ainda sem marca/cidade; o Jorge confirma antes de aplicar.
    suggest: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "marketing", "view");
      const db = await getDb();
      if (!db) return [];
      const { suggestCampaignProjects } = await import("../../../shared/adCampaignMapping");
      const { getProjects } = await import("../../db");
      const rows = await db.select({ id: adCampaigns.id, name: adCampaigns.name, projectId: adCampaigns.projectId, scope: adCampaigns.scope, accountProjectId: adAccounts.projectId })
        .from(adCampaigns).leftJoin(adAccounts, eq(adAccounts.id, adCampaigns.accountId)).where(inArray(adCampaigns.provider, [...SUGGEST_PROVIDERS]));
      return suggestCampaignProjects(rows, await getProjects());
    }),
    applySuggestions: protectedProcedure
      .input(z.object({ campaignIds: z.array(z.number().int().positive()).max(500).optional() }).optional())
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "marketing", "manage");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const { suggestCampaignProjects } = await import("../../../shared/adCampaignMapping");
        const { getProjects, logActivity } = await import("../../db");
        const rows = await db.select({ id: adCampaigns.id, name: adCampaigns.name, projectId: adCampaigns.projectId, scope: adCampaigns.scope, accountProjectId: adAccounts.projectId })
          .from(adCampaigns).leftJoin(adAccounts, eq(adAccounts.id, adCampaigns.accountId)).where(inArray(adCampaigns.provider, [...SUGGEST_PROVIDERS]));
        const wanted = input?.campaignIds ? new Set(input.campaignIds) : null;
        const suggestions = suggestCampaignProjects(rows, await getProjects()).filter((s) => !wanted || wanted.has(s.campaignId));
        for (const s of suggestions) {
          // Nunca sobrepõe uma marca/cidade já escolhida à mão (só as "por associar":
          // projectId NULL e scope 'city').
          const untouched = and(eq(adCampaigns.id, s.campaignId), sql`${adCampaigns.projectId} IS NULL`, eq(adCampaigns.scope, "city"));
          if (s.kind === "national") await db.update(adCampaigns).set({ scope: "national", projectId: null }).where(untouched);
          else await db.update(adCampaigns).set({ projectId: s.projectId, scope: "city" }).where(untouched);
        }
        await logActivity({ userId: ctx.user.id, action: "map", entity: "ad_campaigns", details: `Marca/cidade sugerida pelo nome aplicada a ${suggestions.length} campanha(s) Google Ads/Meta` });
        return { applied: suggestions.length, suggestions };
      }),
  }),

  sync: router({
    run: protectedProcedure
      .input(z.object({ kind: z.enum(["initial", "daily", "monthly", "manual", "hourly", "nightly", "recent"]).default("manual") }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "integracoes", "edit");
        // 19b: a inicial (37 meses) é pesada e reescreve o histórico todo → só quem gere
        if (input.kind === "initial") requireAccess(ctx.user, "integracoes", "manage");
        // prazo curto: no Vercel a função tem 60 s; o resultado diz se ficou parcial
        return runGoogleAdsSync({ kind: input.kind, deadlineAt: Date.now() + 40_000, triggeredById: ctx.user.id });
      }),
    runs: protectedProcedure.input(z.object({ limit: z.number().min(1).max(100).optional() }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "integracoes", "view");
      return listSyncRuns(input?.limit ?? 20);
    }),
    // 8 out 2026: ler já os cliques (gclid → campanha) — o mesmo da volta de hora a hora (só leitura na Google).
    clicks: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "integracoes", "edit");
      const { runGoogleAdsClickSync } = await import("./clicks");
      return runGoogleAdsClickSync({ deadlineAt: Date.now() + 40_000 });
    }),
  }),

  // 19b (decisão do Jorge): ligar e desligar o Google Ads só super admin.
  // Desligar revoga o token na Google; os dados recolhidos ficam.
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    requireAccess(ctx.user, "integracoes", "manage");
    if (ctx.user.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin pode desligar o Google Ads" });
    const conn = await getConnection();
    const r = await disconnect();
    await logActivity({ userId: ctx.user.id, action: "disconnect", entity: "integration_connections", details: `Google Ads desligado${conn?.accountEmail ? ` (${conn.accountEmail})` : ""}${r.revoked ? " · token revogado na Google" : " · não foi possível revogar o token na Google"}` });
    // D51: avisa os admins e o super admin (interruptor; nunca lança).
    const { notifyIntegrationDisconnected } = await import("../../integrationDisconnectNotify");
    await notifyIntegrationDisconnected({ integration: "Google Ads", byUserId: ctx.user.id, byName: ctx.user.name, accountEmail: conn?.accountEmail ?? null, revoked: r.revoked });
    return { success: true, revoked: r.revoked };
  }),
});
