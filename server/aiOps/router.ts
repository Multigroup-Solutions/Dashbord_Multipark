/**
 * Router tRPC `aiOps` — leitura das automações internas (briefing, anomalias,
 * pendentes repetidos) e ações das leads (pontuação, rascunho do 1.º
 * contacto). Guardas: `requireAccess` do módulo de cada coisa + âmbito de
 * cidade do pedido (cityScope); nada aqui muda regras de acesso.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess, scopeFor, withOverrides } from "../_core/access";
import { cityScope } from "../cityScope";
import { getDb, logActivity } from "../db";
import { lisbonDayOf } from "../../shared/lisbonDay";
import { HANDOVER_CITIES } from "../../shared/shiftHandover";
import { OPS_CITIES, opsCityOf, type OpsCity } from "./cities";
import { seesAiAlertExplanations } from "../../shared/aiLimits";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];

/** Cidades operacionais que o pedido vê (cityScope). */
export function visibleCities(): OpsCity[] {
  const access = cityScope.getStore();
  if (!access || access.all) return [...OPS_CITIES];
  const names = access.cityNames ?? (access.cityName ? [access.cityName] : []);
  return [...new Set(names.map((n) => opsCityOf(n)).filter((c): c is OpsCity => !!c))];
}

async function visibleLeadIds(ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const db = await getDb();
  if (!db) return [];
  const { assertLeadVisible } = await import("../extraLeads");
  const rows = rowsOf(await db.execute(sql`SELECT id, projectId FROM extra_leads WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`));
  return rows.filter((r) => { try { assertLeadVisible({ projectId: r.projectId == null ? null : Number(r.projectId) }); return true; } catch { return false; } }).map((r) => Number(r.id));
}

/** Quem vê os alertas de cada página (o mesmo para os ler e para os tirar). */
function canSeeAnomalies(user: any, domain: "bookings" | "expenses" | "marketing"): boolean {
  if (domain === "bookings") requireAccess(user, "reservas_operacoes", "view");
  if (domain === "marketing") requireAccess(user, "marketing", "view");
  if (domain === "expenses") {
    requireAccess(user, "despesas", "view", { allowOwn: true });
    // Só quem vê as despesas da cidade (ou nacionais) vê as anomalias.
    const s = scopeFor(withOverrides(user as any), "despesas");
    if (s !== "city" && s !== "national") return false;
  }
  return true;
}

const leadIdsInput = z.object({ leadIds: z.array(z.number().int().positive()).min(1).max(200) });

export const aiOpsRouter = router({
  /** Briefing de hoje (ou de ontem, se o de hoje ainda não saiu) das cidades que a pessoa vê. */
  briefing: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "passagem_turno", "view");
    const { latestBriefings, viewerPerms } = await import("./briefing");
    return latestBriefings(visibleCities(), viewerPerms(withOverrides(ctx.user as any)), lisbonDayOf(Date.now()));
  }),

  /** "Alertas" de uma página: anomalias recentes do domínio, no âmbito de cidade. */
  anomalies: protectedProcedure
    .input(z.object({ domain: z.enum(["bookings", "expenses", "marketing"]), days: z.number().int().min(1).max(60).optional(), dismissed: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      if (!canSeeAnomalies(ctx.user, input.domain)) return [];
      const { listAnomalies } = await import("./anomalies");
      const list = await listAnomalies(input.domain, { days: input.days, today: lisbonDayOf(Date.now()), dismissed: input.dismissed });
      // Jorge (8 out 2026): condutores e extras veem o alerta, não a linha da IA.
      // (A explicação é feita 1× por dia no ops-briefing — ver quem a vê não a dispara.)
      return seesAiAlertExplanations(ctx.user.role) ? list : list.map((a) => ({ ...a, explanation: null }));
    }),

  /**
   * 42d (Jorge, 7 out 2026: "estes alertas… dar para retirar"): tirar um alerta
   * da lista, ou repô-lo. Quem o vê pode tirá-lo (para toda a gente); fica
   * guardado com quem e quando, e regista-se no histórico.
   */
  dismissAnomaly: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), domain: z.enum(["bookings", "expenses", "marketing"]), restore: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      if (!canSeeAnomalies(ctx.user, input.domain)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem acesso a estes alertas." });
      const { setAnomalyDismissed } = await import("./anomalies");
      const changed = await setAnomalyDismissed(input.id, input.domain, ctx.user.id, !input.restore);
      if (!changed) throw new TRPCError({ code: "NOT_FOUND", message: input.restore ? "Este alerta já está na lista." : "Este alerta já foi tirado ou não está no teu acesso." });
      await logActivity({ userId: ctx.user.id, action: input.restore ? "anomaly_restored" : "anomaly_dismissed", entity: "ops_anomaly", entityId: input.id, details: input.domain });
      return { ok: true as const };
    }),

  /** Pendentes que se repetem entre passagens (código) + último resumo semanal da cidade. */
  handoverRepeats: protectedProcedure
    .input(z.object({ city: z.enum(HANDOVER_CITIES) }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "passagem_turno", "view");
      if (!visibleCities().includes(input.city)) throw new TRPCError({ code: "FORBIDDEN", message: "Esta cidade não está no teu acesso." });
      const { repeatedItemsFor } = await import("./handoverRepeats");
      const r = await repeatedItemsFor(input.city);
      const db = await getDb();
      const { HANDOVER_WEEK_NARRATIVE_FROM } = await import("./handoverRepeats");
      // 44e: os resumos de antes da regra "só PDAs e notas" falavam das ocorrências — não se mostram.
      const week = db ? rowsOf(await db.execute(sql`
        SELECT weekStart, narrative, data FROM ai_weekly_reports WHERE kind = ${`handover:${input.city}`} AND weekStart >= ${HANDOVER_WEEK_NARRATIVE_FROM} ORDER BY weekStart DESC LIMIT 1`))[0] : null;
      let weekData: any = null;
      try { weekData = week ? JSON.parse(String(week.data)) : null; } catch { weekData = null; }
      return {
        repeated: r.repeated,
        week: week ? { weekStart: String(week.weekStart), narrative: week.narrative ? String(week.narrative) : null, filled: weekData?.filled ?? null, expectedShifts: weekData?.expectedShifts ?? null } : null,
      };
    }),

  // ── Leads de extras ────────────────────────────────────────────────────────
  leads: router({
    /** Pontuação (código, sem IA) das leads pedidas que a pessoa vê. */
    scores: protectedProcedure.input(leadIdsInput).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "leads_extras", "view");
      const ids = await visibleLeadIds(input.leadIds);
      const { scoreLeads } = await import("./leadScoring");
      return scoreLeads(ids);
    }),
    /**
     * Resumo de uma linha (IA, lite, máx. 10 por pedido). Jorge (8 out 2026):
     * tem custo — só quem edita as leads (os recrutadores), não quem só as lê.
     */
    summarize: protectedProcedure.input(leadIdsInput).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "leads_extras", "edit");
      const ids = (await visibleLeadIds(input.leadIds)).slice(0, 10);
      const { scoreLeads } = await import("./leadScoring");
      const { AiCallCap } = await import("./aiCall");
      return scoreLeads(ids, { withSummary: true, cap: new AiCallCap(10), userId: ctx.user.id });
    }),
    /** Rascunho do 1.º contacto — fica pendente de aprovação. */
    draftFirstContact: protectedProcedure.input(z.object({ leadId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "leads_extras", "edit");
      if (!(await visibleLeadIds([input.leadId])).length) throw new TRPCError({ code: "NOT_FOUND", message: "Lead não encontrado" });
      const { draftFirstContact } = await import("./leadScoring");
      const r = await draftFirstContact(input.leadId, ctx.user.id);
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.reason });
      await logActivity({ userId: ctx.user.id, action: "ai_draft", entity: "extra_lead", entityId: input.leadId, details: "rascunho do 1.º contacto (IA) a aguardar aprovação" });
      return r;
    }),
    /** Aprovar (com o texto final) ou rejeitar o rascunho. */
    reviewFirstContact: protectedProcedure
      .input(z.object({ leadId: z.number().int().positive(), approve: z.boolean(), message: z.string().trim().min(1).max(1000).optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "leads_extras", "edit");
        if (!(await visibleLeadIds([input.leadId])).length) throw new TRPCError({ code: "NOT_FOUND", message: "Lead não encontrado" });
        const { reviewFirstContact } = await import("./leadScoring");
        try {
          const r = await reviewFirstContact(input.leadId, { approve: input.approve, message: input.message ?? null }, { id: ctx.user.id });
          await logActivity({ userId: ctx.user.id, action: input.approve ? "ai_draft_approved" : "ai_draft_rejected", entity: "extra_lead", entityId: input.leadId, details: r.sent ? "enviado por WhatsApp" : r.reason ?? "" });
          return r;
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Não foi possível rever o rascunho." });
        }
      }),
  }),
});
