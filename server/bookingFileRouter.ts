/**
 * tRPC — Ficha da reserva (/reserva/:id), lida AO VIVO da BD da Multipark
 * (server/multiparkDb/bookingFile.ts). Cada secção é um procedimento à parte
 * para a página abrir depressa; as pesadas (assinaturas, linha do tempo,
 * comunicação) só são pedidas quando se abre a secção.
 *
 * Acesso: módulo "reservas_operacoes" (ver) — o mesmo das páginas de
 * reservas — e âmbito de cidade por Park.city em todas as leituras.
 * "Os nossos casos" lê a NOSSA BD (reclamações e perdidos ligados à reserva),
 * cada lista só para quem vê esse módulo, dentro das suas cidades.
 */
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess, withOverrides } from "./_core/access";
import { cityScope, scopedProjectIds } from "./cityScope";
import { seesBeyondOwn } from "../shared/access";

const idInput = z.object({ id: z.string().trim().min(1).max(64), projectId: z.number().optional() });

/** Cidades do pedido (Park.city). undefined = todas; [] = nenhuma. */
export function scopedCityNames(): string[] | undefined {
  const a = cityScope.getStore();
  if (!a || a.all) return undefined;
  return a.cityNames ?? (a.cityName ? [a.cityName] : []);
}

type Unavailable = { available: false; code: string; reason: string };
function unavailable(r: { code: string; reason: string }): Unavailable {
  return { available: false, code: r.code, reason: r.reason };
}

export const bookingFileRouter = router({
  /** Resolve id / n.º e devolve o essencial (cabeçalho, cliente, viatura, lugar). */
  main: protectedProcedure
    .input(z.object({ ref: z.string().trim().min(1).max(128), projectId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reservas_operacoes", "view");
      const { resolveBookingRef, getBookingFileMain, normalizeRef } = await import("./multiparkDb/bookingFile");
      const cities = scopedCityNames();
      const ref = normalizeRef(input.ref);
      const res = await resolveBookingRef(ref, cities);
      if (!res.available) return unavailable(res);
      const r = res.data;
      if (r.kind === "not_found") return { available: true as const, kind: "not_found" as const };
      if (r.kind === "ambiguous") return { available: true as const, kind: "ambiguous" as const, candidates: r.candidates };
      const file = await getBookingFileMain(r.id, cities);
      if (!file.available) return unavailable(file);
      if (!file.data.data.core) {
        return { available: true as const, kind: "not_found" as const };
      }
      return { available: true as const, kind: "found" as const, id: r.id, ...file.data.data, core: file.data.data.core, missing: file.data.missing };
    }),

  evidence: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "reservas_operacoes", "view");
    const { getBookingFileEvidence } = await import("./multiparkDb/bookingFile");
    const r = await getBookingFileEvidence(input.id, scopedCityNames());
    return r.available ? { available: true as const, ...r.data.data, missing: r.data.missing } : unavailable(r);
  }),

  /** Assinaturas (PNG guardadas na BD) — só quando se abre "Provas". */
  signatures: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "reservas_operacoes", "view");
    const { getBookingFileSignatures } = await import("./multiparkDb/bookingFile");
    const r = await getBookingFileSignatures(input.id, scopedCityNames());
    return r.available ? { available: true as const, ...r.data } : unavailable(r);
  }),

  accounts: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "reservas_operacoes", "view");
    const { getBookingFileAccounts } = await import("./multiparkDb/bookingFile");
    const r = await getBookingFileAccounts(input.id, scopedCityNames());
    return r.available ? { available: true as const, ...r.data.data, missing: r.data.missing } : unavailable(r);
  }),

  extras: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "reservas_operacoes", "view");
    const { getBookingFileExtras } = await import("./multiparkDb/bookingFile");
    const r = await getBookingFileExtras(input.id, scopedCityNames());
    return r.available ? { available: true as const, ...r.data.data, missing: r.data.missing } : unavailable(r);
  }),

  timeline: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "reservas_operacoes", "view");
    const { getBookingFileTimeline } = await import("./multiparkDb/bookingFile");
    const r = await getBookingFileTimeline(input.id, scopedCityNames());
    return r.available ? { available: true as const, ...r.data } : unavailable(r);
  }),

  communication: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "reservas_operacoes", "view");
    const { getBookingFileCommunication } = await import("./multiparkDb/bookingFile");
    const r = await getBookingFileCommunication(input.id, scopedCityNames());
    return r.available ? { available: true as const, ...r.data.data, missing: r.data.missing } : unavailable(r);
  }),

  feedback: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "reservas_operacoes", "view");
    const { getBookingFileFeedback } = await import("./multiparkDb/bookingFile");
    const r = await getBookingFileFeedback(input.id, scopedCityNames());
    if (!r.available) return unavailable(r);
    // D19 alargado (Jorge, 3 out 2026): ocorrências só a partir de team leader —
    // quem não as vê fica sem a lista (e sabe porquê).
    const occurrencesHidden = !seesBeyondOwn(withOverrides(ctx.user), "ocorrencias");
    return { available: true as const, ...r.data.data, ...(occurrencesHidden ? { occurrences: [] } : {}), occurrencesHidden, missing: r.data.missing };
  }),

  /**
   * "Os nossos casos": reclamações e perdidos da NOSSA BD ligados a esta
   * reserva (pelo id da Multipark, pelo n.º ou pelo n.º que a nossa cópia
   * guarda), e se o CRM (/clientes) conhece o email do cliente.
   */
  ourCases: protectedProcedure
    .input(z.object({
      id: z.string().trim().min(1).max(64),
      code: z.string().trim().max(64).nullable().optional(),
      email: z.string().trim().max(320).nullable().optional(),
      projectId: z.number().optional(),
    }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "reservas_operacoes", "view");
      const user = withOverrides(ctx.user);
      const { getDb } = await import("./db");
      const { complaints, lostFoundItems } = await import("../drizzle/schema");
      const { and, desc, eq, inArray, sql } = await import("drizzle-orm");
      const db = await getDb();
      const empty = { complaints: [] as Array<{ id: number; title: string; status: string; createdAt: string; ref: string | null }>, lostFound: [] as Array<{ id: number; title: string; status: string; createdAt: string; ref: string | null }>, crmEmail: null as string | null, canComplaints: false, canLost: false };
      if (!db) return empty;

      const refs = new Set<string>([input.id]);
      if (input.code) refs.add(input.code);
      const refList = [...refs].filter(Boolean).slice(0, 5);
      const ids = scopedProjectIds();
      const inCities = (col: any) => (ids === undefined ? sql`1 = 1` : ids.length ? inArray(col, ids) : sql`1 = 0`);

      const canComplaints = seesBeyondOwn(user, "reclamacoes");
      const canLost = seesBeyondOwn(user, "perdidos");
      const out = { ...empty, canComplaints, canLost };
      if (canComplaints) {
        const rows = await db.select({ id: complaints.id, title: complaints.title, status: complaints.complaintStatus, createdAt: complaints.createdAt, ref: complaints.reservationRef })
          .from(complaints).where(and(inArray(complaints.reservationRef, refList), inCities(complaints.projectId)))
          .orderBy(desc(complaints.createdAt)).limit(20);
        out.complaints = rows.map((r) => ({ ...r, status: String(r.status) }));
      }
      if (canLost) {
        const rows = await db.select({ id: lostFoundItems.id, title: lostFoundItems.description, status: lostFoundItems.status, createdAt: lostFoundItems.createdAt, ref: lostFoundItems.bookingRef })
          .from(lostFoundItems).where(and(inArray(lostFoundItems.bookingRef, refList), inCities(lostFoundItems.projectId)))
          .orderBy(desc(lostFoundItems.createdAt)).limit(20);
        out.lostFound = rows.map((r) => ({ ...r, title: String(r.title ?? "").slice(0, 140), status: String(r.status) }));
      }
      const email = input.email?.trim().toLowerCase();
      if (email && email.includes("@") && seesBeyondOwn(user, "clientes")) {
        // Há ficha do CRM com este email (nas cidades de quem pede)?
        const { crmClientByEmail } = await import("./crm/lookup");
        if (await crmClientByEmail(db, email)) out.crmEmail = email;
      }
      return out;
    }),
});
