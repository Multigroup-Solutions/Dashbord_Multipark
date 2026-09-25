/**
 * tRPC `marketing.web.*` — Web & SEO (GA4, Search Console, PageSpeed).
 * Todas as rotas passam pela matriz de acessos do módulo Marketing (hoje só
 * super_admin — ver shared/access.ts; nada aqui alarga isso): ver = "view",
 * configurar/testar/atualizar = "manage".
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { can, requireAccess, withOverrides } from "../_core/access";
import { WEB_BRAND_IDS, daysBetweenInclusive, scopeByBrand, webAnalyticsConfigSchema, WEB_ANALYTICS_SETTING_KEY } from "../../shared/webAnalytics";
import { addDays } from "../../shared/lisbonDay";

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida (AAAA-MM-DD).");
const brandInput = z.union([z.enum(WEB_BRAND_IDS), z.literal("")]).optional();
const compareInput = z.enum(["previous", "yoy"]).default("previous");

const rangeInput = z.object({ from: ISO, to: ISO, brand: brandInput, compare: compareInput }).refine((v) => v.from <= v.to, "O início tem de ser antes do fim.")
  .refine((v) => daysBetweenInclusive(v.from, v.to) <= 400, "No máximo 400 dias.");

export const GA_LIST_DIMS = ["channel", "landing", "device", "country", "city", "event"] as const;
export const SC_LIST_DIMS = ["query", "page", "device", "country"] as const;
export const GA_LIST_SORTS = ["sessions", "keyEvents", "revenue", "losing", "gaining"] as const;
export const SC_LIST_SORTS = ["clicks", "impressions", "position", "losing", "gaining", "positionWorse"] as const;

const listInput = z.discriminatedUnion("source", [
  z.object({ source: z.literal("ga"), dim: z.enum(GA_LIST_DIMS), sort: z.enum(GA_LIST_SORTS).default("sessions") }),
  z.object({ source: z.literal("sc"), dim: z.enum(SC_LIST_DIMS), sort: z.enum(SC_LIST_SORTS).default("clicks") }),
]).and(z.object({
  from: ISO, to: ISO, brand: brandInput, compare: compareInput,
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(5).max(100).default(25),
  search: z.string().trim().max(100).optional(),
}));

type CtxUser = { id: number; role: string; accessOverrides?: any };

function badRequest(e: unknown): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: String((e as any)?.message ?? e).slice(0, 300) });
}

export const webAnalyticsRouter = router({
  overview: protectedProcedure.input(rangeInput).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "marketing", "view");
    const { webOverview } = await import("./service");
    try { return await webOverview({ from: input.from, to: input.to, brand: input.brand || null, compare: input.compare }); } catch (e) { badRequest(e); }
  }),

  /** Tabelas grandes (páginas, pesquisas, canais, geografia…) — paginadas no SQL. */
  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "marketing", "view");
    if (input.from > input.to || daysBetweenInclusive(input.from, input.to) > 400) throw new TRPCError({ code: "BAD_REQUEST", message: "Período inválido." });
    const { loadWebAnalyticsConfig } = await import("./service");
    const { dimCompare } = await import("./queries");
    const { comparisonRange } = await import("../../shared/webAnalytics");
    const cfg = await loadWebAnalyticsConfig();
    const scope = scopeByBrand(cfg, input.brand || null);
    const prev = comparisonRange(input.from, input.to, input.compare);
    try {
      const r = await dimCompare({
        source: input.source, ids: input.source === "ga" ? scope.properties : scope.sites, dim: input.dim,
        cur: { from: input.from, to: input.to }, prev, sort: input.sort, limit: input.pageSize, offset: (input.page - 1) * input.pageSize, search: input.search,
      });
      const labels = new Map(cfg.ga4Properties.map((p) => [p.propertyId, p.label || `GA4 ${p.propertyId}`]));
      return { ...r, page: input.page, pageSize: input.pageSize, prevRange: prev, rows: r.rows.map((x) => ({ ...x, sourceLabel: x.sourceId ? labels.get(x.sourceId) ?? x.sourceId : null })) };
    } catch (e) { badRequest(e); }
  }),

  pagespeed: protectedProcedure.input(z.object({ brand: brandInput, weeks: z.number().int().min(4).max(104).default(26) }).optional()).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "marketing", "view");
    const { loadWebAnalyticsConfig } = await import("./service");
    const { pagespeedHistory } = await import("./queries");
    const { lisbonToday } = await import("../../shared/expensePeriods");
    const cfg = await loadWebAnalyticsConfig();
    const urls = cfg.pagespeedUrls.filter((u) => !input?.brand || u.brand === input.brand);
    const runs = await pagespeedHistory(urls.map((u) => u.url), addDays(lisbonToday(), -7 * (input?.weeks ?? 26)));
    return { enabled: cfg.pagespeedEnabled, urls, runs, thresholdMobile: cfg.alerts.pagespeedMobileMin };
  }),

  settings: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "marketing", "view");
      const { loadWebAnalyticsConfig } = await import("./service");
      const { dwdConfigured, workspaceConfig } = await import("../google/workspace");
      const { dbWebStore } = await import("./store");
      let lastRun: unknown = null, lastSuccessAt: string | null = null;
      try {
        const raw = await dbWebStore.getState("lastRun");
        lastRun = raw ? JSON.parse(raw) : null;
        lastSuccessAt = await dbWebStore.getState("lastSuccessAt");
      } catch { /* sem BD/tabela ainda */ }
      return {
        canEdit: can(withOverrides(ctx.user as CtxUser) as any, "marketing", "manage"),
        config: await loadWebAnalyticsConfig(),
        serviceAccount: dwdConfigured(),
        serviceAccountEmail: workspaceConfig().serviceAccount?.client_email ?? null,
        pagespeedKey: !!String(process.env.GOOGLE_PAGESPEED_API_KEY ?? "").trim(),
        lastRun,
        lastSuccessAt,
      };
    }),
    save: protectedProcedure.input(webAnalyticsConfigSchema).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { setSetting } = await import("../appSettings");
      try {
        const r = await setSetting(WEB_ANALYTICS_SETTING_KEY, input, ctx.user.id);
        try {
          const { logActivity } = await import("../db");
          if (r.changed) await logActivity({ userId: ctx.user.id, action: "update", entity: "app_setting", entityId: null, details: `${WEB_ANALYTICS_SETTING_KEY} atualizado (GA4: ${input.ga4Properties.length}, Search Console: ${input.searchConsoleSites.length}, PageSpeed: ${input.pagespeedUrls.length})` } as any);
        } catch { /* registo */ }
        return { ok: true, changed: r.changed };
      } catch (e) { badRequest(e); }
    }),
    /** Testa o acesso a cada propriedade (GA4 e Search Console) — diz quais faltam e o email a adicionar. */
    check: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { checkWebAccess } = await import("./service");
      return checkWebAccess();
    }),
    runNow: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { runWebAnalyticsSync } = await import("./sync");
      const r = await runWebAnalyticsSync({ deadlineAt: Date.now() + 45_000 });
      return { ok: r.ok, done: r.done, busy: !!r.busy, configured: r.configured, errors: r.errors, warnings: r.warnings, pagespeed: r.pagespeed, windows: r.units.reduce((s, u) => s + u.windows, 0) };
    }),
    /** Volta a gerar o resumo semanal agora (IA lite se ligada; senão texto fixo). */
    refreshInsight: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { loadWebAnalyticsConfig, runWebInsight } = await import("./service");
      const { lisbonToday } = await import("../../shared/expensePeriods");
      return (await runWebInsight(await loadWebAnalyticsConfig(), lisbonToday(), { force: true })) ?? { created: false, ai: false };
    }),
  }),
});
