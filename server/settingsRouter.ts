/**
 * Página "Definições" (/definicoes): estado do sistema (crons), interruptores
 * das automações, definições editáveis (com auditoria) e segurança (API keys,
 * sessões). Acesso pelo módulo "definicoes" da matriz (admin+, com as exceções
 * por pessoa): ver = view, mudar = edit. Exceto o que é da própria pessoa
 * (terminar as SUAS sessões) e o que é só do super admin (API keys, sessões de
 * todos, as definições de SUPER_ADMIN_SETTING_KEYS e os interruptores
 * marcados superAdminOnly). As integrações vivem no hub /integracoes (19d).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { protectedProcedure, router } from "./_core/trpc";
import { getSessionCookieOptions } from "./_core/cookies";
import { requireAccess } from "./_core/access";
import {
  AUTOMATION_FLAGS, SETTINGS, SETTING_KEYS, automationFlagSuperAdminOnly, flagSettingKey, isAutomationFlag, settingSuperAdminOnly,
} from "../shared/appSettings";

const RANK: Record<string, number> = { super_admin: 7, admin: 6 };
function requireSuperAdmin(role: string) {
  if ((RANK[role] ?? 0) < RANK.super_admin) throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin pode fazer isto." });
}

/** 20b: pela matriz (com as exceções por pessoa), não só pelo papel. */
const adminOnly = protectedProcedure.use(({ ctx, next }) => {
  requireAccess(ctx.user as any, "definicoes", "view");
  return next();
});
const canEdit = (user: unknown) => requireAccess(user as any, "definicoes", "edit");

/** Valor curto para os logs (os valores completos ficam no histórico das Definições). */
function shortValue(v: unknown): string {
  const t = v == null ? "omissão" : typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

function conflict(err: unknown): never {
  throw new TRPCError({ code: "CONFLICT", message: String((err as any)?.message ?? err) });
}

async function log(userId: number, action: string, entity: string, details: string, entityId: number | null = null) {
  try {
    const { logActivity } = await import("./db");
    await logActivity({ userId, action, entity, entityId, details: details.slice(0, 1000) } as any);
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
    // 20b: o mail-sync é esperado de 5 em 5 min sem o push do Gmail e de hora
    // a hora com ele — o "Parado" segue a cadência que está em vigor.
    const { loadDynamicCadence } = await import("./cronScheduler");
    const { MAIL_SYNC_MINUTES, MAIL_SYNC_SAFETY_NET_MINUTES } = await import("./cronSchedule");
    const now = Date.now();
    const dyn = await loadDynamicCadence(now);
    const overrides = new Map([["mail-sync", dyn.mailPushHealthy ? MAIL_SYNC_SAFETY_NET_MINUTES : MAIL_SYNC_MINUTES]]);
    return { now, crons: await getCronStatuses(now, overrides) };
  }),

  /**
   * Agendador único (/api/cron/tick): cadência, última corrida, estado, último
   * erro e próxima vez de cada trabalho. Só leitura; só o super admin.
   */
  scheduler: protectedProcedure.query(async ({ ctx }) => {
    requireSuperAdmin(ctx.user.role);
    const { schedulerStatus } = await import("./cronScheduler");
    return schedulerStatus();
  }),

  /** IA: gasto do mês por funcionalidade (ai_usage_log), orçamento e modelos em uso. */
  aiUsage: adminOnly.query(async () => {
    const { aiUsageSummary } = await import("./_core/ai/usage");
    const { aiStatus } = await import("./_core/ai/status");
    const st = aiStatus();
    return { ...(await aiUsageSummary()), provider: st.provider, mode: st.mode, models: st.models, warnings: st.warnings };
  }),

  /**
   * "Serviços → tarefas": tipos de serviço do catálogo Multipark (ExtraService
   * dos parques nossos) e pessoas de cada cidade para o responsável. A regra
   * grava-se com values.set("services.taskRules").
   */
  serviceTasks: router({
    catalog: adminOnly.query(async () => {
      const { loadServiceTaskCatalog } = await import("./serviceTasks");
      return loadServiceTaskCatalog();
    }),
  }),

  flags: router({
    list: adminOnly.query(async () => {
      const { listAutomationFlags } = await import("./appSettings");
      return listAutomationFlags();
    }),
    /**
     * `value: null` remove a sobreposição (volta à env / omissão).
     * `expectedUpdatedAt` (20b): o que o ecrã leu; se outra pessoa mudou entretanto → CONFLICT.
     */
    set: adminOnly
      .input(z.object({ name: z.string().max(64), value: z.boolean().nullable(), expectedUpdatedAt: z.string().max(19).nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        canEdit(ctx.user);
        if (!isAutomationFlag(input.name)) throw new TRPCError({ code: "BAD_REQUEST", message: "Interruptor desconhecido." });
        // Ex.: MULTIPARK_SOURCE (fonte das reservas), CRM_AUTO_MERGE (20b).
        if (automationFlagSuperAdminOnly(input.name)) requireSuperAdmin(ctx.user.role);
        const { setSetting, SettingConflictError } = await import("./appSettings");
        let r: { changed: boolean; value: unknown };
        try {
          r = await setSetting(flagSettingKey(input.name), input.value, ctx.user.id, { expectedUpdatedAt: input.expectedUpdatedAt });
        } catch (err) {
          if (err instanceof SettingConflictError) conflict(err);
          throw err;
        }
        if (r.changed) {
          const label = AUTOMATION_FLAGS.find((f) => f.name === input.name)?.label ?? input.name;
          await log(ctx.user.id, "update", "app_setting", `${label} (${input.name}): ${input.value == null ? "segue a variável do servidor" : input.value ? "ligado" : "desligado"}`);
        }
        return r;
      }),
  }),

  values: router({
    list: adminOnly.query(async () => {
      const { listSettings } = await import("./appSettings");
      return listSettings();
    }),
    /**
     * Validação zod no servidor (shared/appSettings); `value: null` repõe a omissão.
     * `expectedUpdatedAt` (20b): o `updatedAt` que o ecrã leu (null = sem valor
     * gravado); se outra pessoa gravou entretanto → CONFLICT e nada muda.
     */
    set: adminOnly
      .input(z.object({ key: z.enum(SETTING_KEYS as [string, ...string[]]), value: z.unknown(), expectedUpdatedAt: z.string().max(19).nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        canEdit(ctx.user);
        // Notificações, calendários/contactos/Drive Google, Web & SEO, Google
        // Business e (20b) o remetente dos emails de sistema: só o super admin.
        if (settingSuperAdminOnly(input.key)) requireSuperAdmin(ctx.user.role);
        const { setSetting, SettingConflictError } = await import("./appSettings");
        try {
          const r = await setSetting(input.key, input.value === undefined ? null : input.value, ctx.user.id, { expectedUpdatedAt: input.expectedUpdatedAt });
          if (input.key === "notifications.routing") (await import("./notify")).invalidateNotifyCache();
          if (r.changed) {
            const label = (SETTINGS as Record<string, { label: string }>)[input.key]?.label ?? input.key;
            await log(ctx.user.id, "update", "app_setting", `${label} (${input.key}): ${shortValue(r.value)}`);
          }
          return r;
        } catch (err: any) {
          if (err instanceof SettingConflictError) conflict(err);
          if (err instanceof TRPCError) throw err;
          throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) });
        }
      }),
    audit: adminOnly
      .input(z.object({ limit: z.number().int().min(1).max(200).optional(), key: z.string().max(100).nullable().optional() }).optional())
      .query(async ({ input }) => {
        const { listSettingsAudit } = await import("./appSettings");
        return listSettingsAudit(input?.limit ?? 50, input?.key ?? null);
      }),
    /**
     * Parques da BD da Multipark (ao vivo, todos, sem âmbito de cidade) para
     * escolher os "Parques que a operação não faz". Só leitura.
     */
    multiparkParks: adminOnly.query(async () => {
      const { getMultiparkParkClassification } = await import("./multiparkDb/dayBookings");
      const { isNotOperatedByName, unmatchedNotOperatedNames } = await import("../shared/multiparkParks");
      const r = await getMultiparkParkClassification(undefined);
      if (!r.available) return { available: false as const, reason: r.reason };
      return {
        available: true as const,
        // 28a: `notOperated` = fora pela lista de nomes do Jorge (não se desmarca aqui).
        parks: r.data.parks.map((p) => ({ id: p.id, name: p.name, cityName: p.cityName, status: p.status, groupLabel: p.groupLabel, groupOrder: p.groupOrder, ours: p.ours, notOperated: isNotOperatedByName(p.name) })),
        unmatchedNotOperated: unmatchedNotOperatedNames(r.data.parks.map((p) => p.name)),
      };
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
        /** Dia (AAAA-MM-DD): a chave funciona até ao fim desse dia em Lisboa. null = sem expiração. */
        expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.").nullable(),
      }))
      .mutation(async ({ ctx, input }) => {
        requireSuperAdmin(ctx.user.role);
        // 20a: fim do dia em LISBOA (antes 23:59:59 UTC = 00:59 do dia seguinte no verão).
        const { lisbonEndOfDayUtc, apiKeyLogName } = await import("./apiKeysRouter");
        const expiresAt = input.expiresOn ? lisbonEndOfDayUtc(input.expiresOn) : null;
        const { getApiKeyById, setApiKeyExpiry } = await import("./db");
        const k = await getApiKeyById(input.id);
        if (!k) throw new TRPCError({ code: "NOT_FOUND", message: "API key não encontrada." });
        if (k.revokedAt || !(await setApiKeyExpiry(input.id, expiresAt))) {
          throw new TRPCError({ code: "CONFLICT", message: "Esta API key foi revogada — já não se altera." });
        }
        await log(ctx.user.id, "update", "api_key",
          `Validade da API key ${apiKeyLogName(k)}: ${k.expiresAt ? k.expiresAt.slice(0, 10) : "sem expiração"} → ${input.expiresOn ?? "sem expiração"}`, input.id);
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
