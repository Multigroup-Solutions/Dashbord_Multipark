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
    .input(z.object({ domain: z.enum(["bookings", "expenses", "marketing"]), days: z.number().int().min(1).max(60).optional() }))
    .query(async ({ ctx, input }) => {
      if (input.domain === "bookings") requireAccess(ctx.user, "reservas_operacoes", "view");
      if (input.domain === "marketing") requireAccess(ctx.user, "marketing", "view");
      if (input.domain === "expenses") {
        requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
        // Só quem vê as despesas da cidade (ou nacionais) vê as anomalias.
        const s = scopeFor(withOverrides(ctx.user as any), "despesas");
        if (s !== "city" && s !== "national") return [];
      }
      const { listAnomalies } = await import("./anomalies");
      return listAnomalies(input.domain, { days: input.days, today: lisbonDayOf(Date.now()) });
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
      const week = db ? rowsOf(await db.execute(sql`
        SELECT weekStart, narrative, data FROM ai_weekly_reports WHERE kind = ${`handover:${input.city}`} ORDER BY weekStart DESC LIMIT 1`))[0] : null;
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
    /** Resumo de uma linha (IA, lite, máx. 10 por pedido). */
    summarize: protectedProcedure.input(leadIdsInput).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "leads_extras", "view");
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
