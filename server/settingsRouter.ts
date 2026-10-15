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
import { GOOGLE_ON_PDAS_FLAG, googleOnPdasChangeError } from "../shared/pdaSession";
import { TRIAGE_CORPUS_KEYS } from "../shared/mailTriage";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
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

/** Só admin e super admin (além da matriz) — o uso da IA por pessoa/entidade. */
function requireAdminRole(role: string) {
  if ((RANK[role] ?? 0) < RANK.admin) throw new TRPCError({ code: "FORBIDDEN", message: "Só os administradores veem o uso da IA." });
}

/** Filtro por funcionalidade (ids do registo: minúsculas, algarismos e _). */
const aiFeatureFilter = z.string().trim().regex(/^[a-z0-9_]{1,40}$/, "Funcionalidade inválida.").nullish();

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

/** Novo cookie de sessão para ESTE dispositivo, com a versão atual (num PDA continua presa ao PDA — plano 56 A2). */
async function reissueSessionCookie(ctx: { req: any; res: any; user: { openId: string; name: string | null } }, sessionVersion: number) {
  const { reissueSessionCookie: reissue } = await import("./pdaSession");
  await reissue(ctx.req, ctx.res, ctx.user, sessionVersion);
}

export const settingsRouter = router({
  /** Estado do sistema: última corrida de cada cron, falhas, crons parados. */
  systemStatus: adminOnly.query(async () => {
    const { getCronStatuses, getRetiredCronNames } = await import("./cronRuns");
    // 20b: o mail-sync é esperado de 5 em 5 min sem o push do Gmail e de hora
    // a hora com ele — o "Parado" segue a cadência que está em vigor.
    const { loadDynamicCadence } = await import("./cronScheduler");
    const { MAIL_SYNC_MINUTES, MAIL_SYNC_SAFETY_NET_MINUTES } = await import("./cronSchedule");
    const now = Date.now();
    const dyn = await loadDynamicCadence(now);
    const overrides = new Map([["mail-sync", dyn.mailPushHealthy ? MAIL_SYNC_SAFETY_NET_MINUTES : MAIL_SYNC_MINUTES]]);
    const [crons, retired] = await Promise.all([getCronStatuses(now, overrides), getRetiredCronNames(now)]);
    return { now, crons, retired };
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

  /**
   * 14 out 2026 — "Testar a triagem" (só o super admin): um lote do corpus
   * rotulado pelo MESMO pedido e decisão de produção, com o modelo real. Não
   * escreve nada nos casos (só o custo da IA). O ecrã pede os lotes um a um.
   */
  mailTriageEval: protectedProcedure
    .input(z.object({ offset: z.number().int().min(0).max(1000), limit: z.number().int().min(1).max(20), corpus: z.enum(TRIAGE_CORPUS_KEYS).default("principal") }))
    .mutation(async ({ ctx, input }) => {
      requireSuperAdmin(ctx.user.role);
      // Teto de custo: cada lote são até 20 leituras da IA. Por hora e por dia
      // (na BD, vale para todas as instâncias) — umas 2 corridas completas por
      // hora e 6 por dia dos dois corpora.
      const { checkRateLimit } = await import("./_core/ai/rateLimit");
      const { MAIL_TRIAGE_EVAL_LIMITS } = await import("./mailTriageEval");
      const rl = await checkRateLimit(`triage-eval:user:${ctx.user.id}`, MAIL_TRIAGE_EVAL_LIMITS);
      if (!rl.allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Já testaste muitas vezes (limite de custo da IA). Tenta daqui a ${Math.ceil(rl.retryAfterSec / 60)} min.` });
      }
      const { evalTriageSlice } = await import("./mailTriageEval");
      return evalTriageSlice({ offset: input.offset, limit: input.limit, concurrency: 4, corpus: input.corpus });
    }),
  /** As contas finais (rótulos do servidor) e a linha "[triagem-eval]" nos logs. */
  mailTriageEvalReport: protectedProcedure
    .input(z.object({
      rows: z.array(z.object({ id: z.string().min(1).max(40), predicted: z.string().max(40).nullable() })).max(500),
      ms: z.number().int().min(0).max(3_600_000).nullish(),
      model: z.string().max(120).nullish(),
      corpus: z.enum(TRIAGE_CORPUS_KEYS).default("principal"),
    }))
    .mutation(async ({ ctx, input }) => {
      requireSuperAdmin(ctx.user.role);
      const { triageEvalReport, TRIAGE_CORPUS_LABELS } = await import("./mailTriageEval");
      const r = triageEvalReport(input);
      await log(ctx.user.id, "test", "mail_triage", `Testar a triagem (${TRIAGE_CORPUS_LABELS[input.corpus]}): reclamações ${r.recallComplaints ?? "—"}, perdidos ${r.recallLostFound ?? "—"} (${r.correct}/${r.total})`);
      return r;
    }),

  /** IA: gasto do mês por funcionalidade (ai_usage_log), orçamento e modelos em uso. */
  aiUsage: adminOnly.query(async () => {
    const { aiUsageSummary } = await import("./_core/ai/usage");
    const { aiStatus } = await import("./_core/ai/status");
    const st = aiStatus();
    return { ...(await aiUsageSummary()), provider: st.provider, mode: st.mode, models: st.models, warnings: st.warnings };
  }),

  /**
   * Plano MPV (F0a): uso da IA por dia × funcionalidade (chamadas, erros,
   * bloqueadas — incl. "só UE" —, tokens, custo, primeira/última). Só leitura,
   * só admin/super admin. Confirma, p. ex., quando correram as do RH.
   */
  aiUsageDaily: adminOnly
    .input(z.object({ days: z.number().int().min(1).max(62).default(14), feature: aiFeatureFilter }).optional())
    .query(async ({ ctx, input }) => {
      requireAdminRole(ctx.user.role);
      const { aiUsageDaily } = await import("./_core/ai/usage");
      return aiUsageDaily(input?.days ?? 14, input?.feature ?? null);
    }),

  /** Leituras repetidas da IA (mesma funcionalidade + entidade + id, > 1 vez): top 100. Só leitura, só admin/super admin. */
  aiUsageRepeats: adminOnly
    .input(z.object({ days: z.number().int().min(1).max(31).default(7), feature: aiFeatureFilter }).optional())
    .query(async ({ ctx, input }) => {
      requireAdminRole(ctx.user.role);
      const { aiUsageRepeats } = await import("./_core/ai/usage");
      return aiUsageRepeats(input?.days ?? 7, input?.feature ?? null);
    }),

  /**
   * Plano MPV (F8, §8.3): o cartão "Multis piloto" — por versão, nível e
   * pessoa: perguntas, €/pergunta, p95, % erros, % MAX_TOKENS, % rondas
   * finais forçadas, % 👎, % "não sei", % chamadas recusadas e caches vivas.
   * Só leitura (registo de uso, respostas, 👎, chamadas das ferramentas), só admin/super admin.
   */
  aiPilotStats: adminOnly
    .input(z.object({ days: z.number().int().min(1).max(31).default(7) }).optional())
    .query(async ({ ctx, input }) => {
      requireAdminRole(ctx.user.role);
      const { getPilotStats } = await import("./assistant/pilotStats");
      return getPilotStats(input?.days ?? 7);
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
      const { aiWhere } = await import("./_core/ai/status");
      const { EU_VERTEX_ONLY_FEATURES, euVertexNote, flagRequiresEuVertex } = await import("../shared/aiLimits");
      const { AI_FEATURES } = await import("../shared/aiFeatures");
      // Jorge (8 out 2026): ao lado dos interruptores dos documentos/CV do RH,
      // "Só corre com a IA em Vertex AI na UE (hoje: …)".
      const featureOf = (flag: string) => EU_VERTEX_ONLY_FEATURES.find((f) => AI_FEATURES[f].flag === flag);
      return (await listAutomationFlags()).map((f) => {
        const feature = flagRequiresEuVertex(f.name) ? featureOf(f.name) : undefined;
        return feature ? { ...f, euVertex: euVertexNote(aiWhere(process.env, feature)) } : { ...f, euVertex: null };
      });
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
        // Plano 56 (A2): sem "Entrar com email e código" os PDAs só têm a Google — não se tira.
        if (input.name === GOOGLE_ON_PDAS_FLAG) {
          const { codeLoginEnabled } = await import("./loginCode");
          const err = googleOnPdasChangeError(input.value, await codeLoginEnabled());
          if (err) throw new TRPCError({ code: "PRECONDITION_FAILED", message: err });
        }
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
    /**
     * 38a: pessoas do RH para os alertas sem PDA/Zello. O telefone vem da
     * ficha; aqui só se mostra o fim do número (••• 678) e se recebe ou não.
     */
    presencePeople: adminOnly.query(async () => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
      const res: any = await db.execute(sql`SELECT id, fullName, position, isActive, noAutoWhatsapp,
          COALESCE(NULLIF(phone, ''), NULLIF(personalPhone, '')) AS phone
        FROM employees ORDER BY isActive DESC, fullName LIMIT 5000`);
      const rows: any[] = Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : res?.rows ?? [];
      return rows.map((r) => {
        const digits = String(r.phone ?? "").replace(/\D/g, "");
        return {
          id: Number(r.id), name: String(r.fullName ?? ""), position: r.position ? String(r.position) : null,
          active: Number(r.isActive) === 1, noAutoWhatsapp: Number(r.noAutoWhatsapp) === 1,
          phoneTail: digits.length >= 3 ? digits.slice(-3) : null,
        };
      });
    }),
    /**
     * Plano 62 (Q6): as garagens da Multipark com o centro do link do mapa — a
     * base das Zonas da operação (as Definições guardam só as exceções). Só leitura.
     */
    multiparkGarages: adminOnly.query(async () => {
      const [{ safeMultiparkRead }, { multiparkDbQuery }, { readGarageCoords }] = await Promise.all([
        import("./multiparkDb/read"), import("./multiparkDb/client"), import("./multiparkDb/parkZonesSuggest"),
      ]);
      const r = await safeMultiparkRead("multiparkGarages", () => readGarageCoords(multiparkDbQuery));
      return r.available ? { available: true as const, garages: r.data } : { available: false as const, reason: r.reason };
    }),
    /**
     * Plano 62 (P5): "Sugerir" nas Zonas da operação — recurso para as garagens
     * sem coordenadas na Multipark: link do mapa, mediana das posições da app nos
     * movimentos das últimas 4 semanas, ou o parque. Só leitura; nada se grava.
     */
    parkZonesSuggest: adminOnly.query(async ({ ctx }) => {
      requireSuperAdmin(ctx.user.role);
      const [{ safeMultiparkRead }, { multiparkDbQuery }, { readZoneSuggestions }] = await Promise.all([
        import("./multiparkDb/read"), import("./multiparkDb/client"), import("./multiparkDb/parkZonesSuggest"),
      ]);
      const r = await safeMultiparkRead("parkZonesSuggest", () => readZoneSuggestions(multiparkDbQuery, Date.now()));
      return r.available ? { available: true as const, cities: r.data } : { available: false as const, reason: r.reason };
    }),
    /**
     * Plano 62 (P3b): "Sugerir T1/T2" nos Aeroportos (terminal no ponto) — a
     * mediana das posições das assinaturas (CHECK_OUT/CHECK_IN) das últimas 4
     * semanas, por cidade e classe da entrega, só dos parques que operamos.
     * Só leitura; nada se grava (o super admin carrega em Usar e em Guardar).
     */
    terminalZonesSuggest: adminOnly.query(async ({ ctx }) => {
      requireSuperAdmin(ctx.user.role);
      const [{ safeMultiparkRead }, { multiparkDbQuery }, { readTerminalZoneSuggestions, TERMINAL_SUGGEST_DAYS }, { getSetting }] = await Promise.all([
        import("./multiparkDb/read"), import("./multiparkDb/client"), import("./multiparkDb/terminalZonesSuggest"), import("./appSettings"),
      ]);
      const excludedParks = ((await getSetting("operations.excludedParks")) ?? SETTINGS["operations.excludedParks"].defaultValue) as string[];
      const airports = ((await getSetting("ponto.terminalAirports")) ?? SETTINGS["ponto.terminalAirports"].defaultValue) as Record<"lisbon" | "porto" | "faro", { lat: number; lng: number; radiusM: number }>;
      const r = await safeMultiparkRead("terminalZonesSuggest", () => readTerminalZoneSuggestions(multiparkDbQuery, Date.now(), { excludedParks, airports }));
      return r.available ? { available: true as const, days: TERMINAL_SUGGEST_DAYS, cities: r.data } : { available: false as const, reason: r.reason };
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
      // (auditoria A2) as sessões desta pessoa noutros PDAs acabam também (avisos incluídos).
      const { endPdaSessionsAfterSessionBump } = await import("./pdaSession");
      await endPdaSessionsAfterSessionBump([ctx.user.id], ctx.req, ctx.user.id);
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
      // (auditoria A2) e as sessões de todos os PDAs (menos a deste aparelho, se for um PDA).
      const { endPdaSessionsAfterSessionBump } = await import("./pdaSession");
      await endPdaSessionsAfterSessionBump("all", ctx.req, ctx.user.id);
      await log(ctx.user.id, "update", "session", `Terminou as sessões de todas as contas (${affected})`);
      return { success: true, affected };
    }),
  }),
});
