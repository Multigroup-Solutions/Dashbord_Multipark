/**
 * Página "Definições" (/definicoes): estado do sistema (crons), interruptores
 * das automações, integrações, definições editáveis (com auditoria) e
 * segurança (API keys, sessões). Tudo admin+ (mesmo guarda das integrações),
 * exceto o que é da própria pessoa (terminar as SUAS sessões) e o que mexe em
 * API keys / sessões de todos (super_admin, como a página de API Keys).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { protectedProcedure, router } from "./_core/trpc";
import { getSessionCookieOptions } from "./_core/cookies";
import { AUTOMATION_FLAGS, SETTING_KEYS, flagSettingKey, isAutomationFlag } from "../shared/appSettings";

const RANK: Record<string, number> = { super_admin: 7, admin: 6 };
function requireAdmin(role: string) {
  if ((RANK[role] ?? 0) < RANK.admin) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
}
function requireSuperAdmin(role: string) {
  if ((RANK[role] ?? 0) < RANK.super_admin) throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin pode fazer isto." });
}

const adminOnly = protectedProcedure.use(({ ctx, next }) => {
  requireAdmin(ctx.user.role);
  return next();
});

async function log(userId: number, action: string, entity: string, details: string) {
  try {
    const { logActivity } = await import("./db");
    await logActivity({ userId, action, entity, entityId: null, details: details.slice(0, 1000) } as any);
  } catch { /* o registo nunca parte a ação */ }
}

/** Novo cookie de sessão para ESTE dispositivo, com a versão atual. */
async function reissueSessionCookie(ctx: { req: any; res: any; user: { openId: string; name: string | null } }, sessionVersion: number) {
  const { sdk } = await import("./_core/sdk");
  const { SESSION_MAX_MS } = await import("./_core/oauth");
  const token = await sdk.createSessionToken(ctx.user.openId, {
    name: ctx.user.name || "Utilizador",
    expiresInMs: SESSION_MAX_MS,
    sessionVersion,
  });
  ctx.res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(ctx.req), maxAge: SESSION_MAX_MS });
}

export const settingsRouter = router({
  /** Estado do sistema: última corrida de cada cron, falhas, crons parados. */
  systemStatus: adminOnly.query(async () => {
    const { getCronStatuses } = await import("./cronRuns");
    return { now: Date.now(), crons: await getCronStatuses() };
  }),

  /** IA: gasto do mês por funcionalidade (ai_usage_log), orçamento e modelos em uso. */
  aiUsage: adminOnly.query(async () => {
    const { aiUsageSummary } = await import("./_core/ai/usage");
    const { aiStatus } = await import("./_core/ai/status");
    const st = aiStatus();
    return { ...(await aiUsageSummary()), provider: st.provider, mode: st.mode, models: st.models, warnings: st.warnings };
  }),

  flags: router({
    list: adminOnly.query(async () => {
      const { listAutomationFlags } = await import("./appSettings");
      return listAutomationFlags();
    }),
    /** `value: null` remove a sobreposição (volta à env / omissão). */
    set: adminOnly
      .input(z.object({ name: z.string().max(64), value: z.boolean().nullable() }))
      .mutation(async ({ ctx, input }) => {
        if (!isAutomationFlag(input.name)) throw new TRPCError({ code: "BAD_REQUEST", message: "Interruptor desconhecido." });
        const { setSetting } = await import("./appSettings");
        const r = await setSetting(flagSettingKey(input.name), input.value, ctx.user.id);
        if (r.changed) {
          const label = AUTOMATION_FLAGS.find((f) => f.name === input.name)?.label ?? input.name;
          await log(ctx.user.id, "update", "app_setting", `${label}: ${input.value == null ? "segue a env" : input.value ? "ligado" : "desligado"}`);
        }
        return r;
      }),
  }),

  integrations: router({
    list: adminOnly.query(async () => {
      const { listIntegrationStatuses } = await import("./integrationsStatus");
      return listIntegrationStatuses();
    }),
    test: adminOnly
      .input(z.object({ id: z.string().max(40) }))
      .mutation(async ({ ctx, input }) => {
        const { testIntegration } = await import("./integrationsStatus");
        const r = await testIntegration(input.id);
        await log(ctx.user.id, "test", "integration", `${input.id}: ${r.ok ? "OK" : "falhou"}`);
        return r;
      }),
  }),

  values: router({
    list: adminOnly.query(async () => {
      const { listSettings } = await import("./appSettings");
      return listSettings();
    }),
    /** Validação zod no servidor (shared/appSettings); `value: null` repõe a omissão. */
    set: adminOnly
      .input(z.object({ key: z.enum(SETTING_KEYS as [string, ...string[]]), value: z.unknown() }))
      .mutation(async ({ ctx, input }) => {
        const { setSetting } = await import("./appSettings");
        try {
          const r = await setSetting(input.key, input.value === undefined ? null : input.value, ctx.user.id);
          if (r.changed) await log(ctx.user.id, "update", "app_setting", `${input.key} = ${JSON.stringify(r.value)}`);
          return r;
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) });
        }
      }),
    audit: adminOnly
      .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).optional())
      .query(async ({ input }) => {
        const { listSettingsAudit } = await import("./appSettings");
        return listSettingsAudit(input?.limit ?? 50);
      }),
    /** IVA/TSU em vigor HOJE nos cálculos (Definições; sem nada gravado = constantes do código). */
    codeConstants: adminOnly.query(async () => {
      const { financeRatesAt, lisbonTodayIso } = await import("./finance/rates");
      const { FINANCE_PARAMS } = await import("./finance/rules");
      const today = lisbonTodayIso();
      const r = await financeRatesAt(today);
      return { today, vatRate: r.vatRate, tsuEmployerRate: r.tsuEmployerRate, fallback: { vatRate: FINANCE_PARAMS.vatRate, tsuEmployerRate: FINANCE_PARAMS.tsuEmployerRate } };
    }),
  }),

  security: router({
    /** API keys com validade (super_admin — como a página API Keys). */
    apiKeys: adminOnly.query(async ({ ctx }) => {
      if ((RANK[ctx.user.role] ?? 0) < RANK.super_admin) return { visible: false as const, keys: [] };
      const { getApiKeys } = await import("./db");
      return { visible: true as const, keys: await getApiKeys() };
    }),
    setApiKeyExpiry: adminOnly
      .input(z.object({
        id: z.number().int().positive(),
        /** Dia (AAAA-MM-DD, fim do dia UTC) ou null = sem expiração. */
        expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.").nullable(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireSuperAdmin(ctx.user.role);
        const expiresAt = input.expiresOn ? `${input.expiresOn} 23:59:59` : null;
        const { setApiKeyExpiry } = await import("./db");
        await setApiKeyExpiry(input.id, expiresAt);
        await log(ctx.user.id, "update", "api_key", `Validade da API key #${input.id}: ${input.expiresOn ?? "sem expiração"}`);
        return { success: true };
      }),
    /** Termina as sessões da própria pessoa noutros dispositivos (este fica). */
    endMySessions: protectedProcedure.mutation(async ({ ctx }) => {
      const { bumpSessionVersion } = await import("./appSettings");
      const version = await bumpSessionVersion(ctx.user.id);
      await reissueSessionCookie(ctx as any, version);
      await log(ctx.user.id, "update", "session", "Terminou as suas sessões nos outros dispositivos");
      return { success: true };
    }),
    /** Termina as sessões de TODAS as pessoas (super_admin). Este dispositivo fica. */
    endAllSessions: adminOnly.mutation(async ({ ctx }) => {
      requireSuperAdmin(ctx.user.role);
      const { bumpAllSessionVersions, bumpSessionVersion } = await import("./appSettings");
      const affected = await bumpAllSessionVersions();
      // +1 à própria conta para ter a versão exata a pôr no novo cookie.
      const version = await bumpSessionVersion(ctx.user.id);
      await reissueSessionCookie(ctx as any, version);
      await log(ctx.user.id, "update", "session", `Terminou as sessões de todas as contas (${affected})`);
      return { success: true, affected };
    }),
  }),
});
