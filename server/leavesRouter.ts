/**
 * `rh.leaves` — férias, baixas e ausências (plano 63, passo 11: mapa de
 * férias). Saiu do rhRouter.ts para um ficheiro próprio.
 *
 *  - list / create / delete: o que já existia (a ficha). `delete` passa a
 *    CANCELAR (nada se apaga); `create` valida as datas e aceita a parte do
 *    dia e a indisponibilidade dos extras.
 *  - status / map / mine / request / pending / decide / cancel / pdf /
 *    launchPeople / myApprovers: o mapa de férias, só com FERIAS_MAPA ligado
 *    (o cancelar e a ficha funcionam sempre).
 *
 * Quem vê o quê é decidido AQUI (shared/leaves.ts → leaveForViewer), nunca só
 * no ecrã.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "./_core/trpc";
import { canAccess } from "./_core/access";
import { assertCanManageEmployee, assertOwnOrScopedEmployee, employeeIdOfRecord } from "./rhGuards";
import { LEAVE_TYPES } from "../shared/leaves";
import {
  approversForEmployee, assertMapOn, cancelLeave, decideLeave, feriasMapaOn, launchLeave, leaveMap, leaveMapForPdf, leavesForEmployee,
  myLeaves, pendingForApprover, requestLeave, resolveLeaveViewer,
} from "./leaves";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida (AAAA-MM-DD).");
const year = z.number().int().min(2020).max(2100);
const cityKey = z.enum(["all", "lisbon", "porto", "faro"]).optional();

async function canManage(user: { id: number; role: string }, employeeId: number): Promise<boolean> {
  try { await assertCanManageEmployee(user, employeeId); return true; } catch { return false; }
}

export const leavesRouter = router({
  // ── A ficha (o que já existia) ─────────────────────────────────────────
  list: protectedProcedure
    .input(z.object({ employeeId: z.number(), year: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      // 41c: férias e baixas — o supervisor da cidade também vê (as baixas só como "ausente", salvo quem vê tudo)
      await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "supervisor");
      return leavesForEmployee(await resolveLeaveViewer(ctx.user), input.employeeId, input.year);
    }),
  create: protectedProcedure
    .input(z.object({
      employeeId: z.number(),
      leaveType: z.enum(LEAVE_TYPES),
      fromDate: isoDay,
      toDate: isoDay,
      /** parte do dia (só ausência justificada, um dia) */
      hours: z.number().optional().nullable(),
      notes: z.string().max(255).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertCanManageEmployee(ctx.user, input.employeeId);
      const r = await launchLeave(ctx.user, input);
      return { success: true, id: r.id };
    }),
  /** Plano 63 (passo 11): já não apaga — CANCELA (quem gere a ficha, como antes). */
  delete: protectedProcedure
    .input(z.object({ id: z.number(), note: z.string().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      const empId = await employeeIdOfRecord("employee_leaves", input.id);
      if (empId == null) throw new TRPCError({ code: "NOT_FOUND", message: "Ausência não encontrada" });
      await assertCanManageEmployee(ctx.user, empId);
      const v = await resolveLeaveViewer(ctx.user);
      await cancelLeave({ userId: ctx.user.id, role: ctx.user.role, employeeId: v.employeeId }, input, true);
      return { success: true };
    }),
  /** Cancelar (nunca apagar): a pessoa o seu pedido; quem aprova, quem gere a ficha ou o super admin as aprovadas. */
  cancel: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), note: z.string().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      const empId = await employeeIdOfRecord("employee_leaves", input.id);
      if (empId == null) throw new TRPCError({ code: "NOT_FOUND", message: "Ausência não encontrada" });
      const v = await resolveLeaveViewer(ctx.user);
      return cancelLeave({ userId: ctx.user.id, role: ctx.user.role, employeeId: v.employeeId }, input, await canManage(ctx.user, empId));
    }),

  // ── Mapa de férias (FERIAS_MAPA) ───────────────────────────────────────
  /** O que o ecrã precisa de saber (também com o interruptor desligado). */
  status: protectedProcedure.query(async ({ ctx }) => {
    const enabled = await feriasMapaOn();
    if (!enabled) return { enabled, mode: "none" as const, employeeId: null, isExtra: false, isPartner: false, canLaunch: false, canPrint: false, pendingCount: 0, daysPerYear: 0, city: null as string | null, fullName: null as string | null };
    const v = await resolveLeaveViewer(ctx.user);
    let pendingCount = 0;
    try { pendingCount = (await pendingForApprover(v)).length; } catch { /* sem contagem */ }
    return {
      enabled, mode: v.mode, employeeId: v.employeeId, isExtra: v.isExtra, isPartner: v.isPartner,
      canLaunch: canAccess(ctx.user, "rh", "manage"), canPrint: v.mode === "full" || v.mode === "supervisor",
      pendingCount, daysPerYear: v.settings.daysPerYear, city: v.city, fullName: v.fullName,
    };
  }),
  map: protectedProcedure
    .input(z.object({ year, cityKey }))
    .query(async ({ ctx, input }) => {
      await assertMapOn();
      const v = await resolveLeaveViewer(ctx.user);
      return leaveMap(v, { year: input.year, cityKey: input.cityKey ?? null, canManageRh: canAccess(ctx.user, "rh", "manage") });
    }),
  mine: protectedProcedure
    .input(z.object({ year }))
    .query(async ({ ctx, input }) => {
      await assertMapOn();
      return myLeaves(await resolveLeaveViewer(ctx.user), input.year);
    }),
  /** Quem vai aprovar as minhas férias (nomes, para o formulário). */
  myApprovers: protectedProcedure.query(async ({ ctx }) => {
    await assertMapOn();
    const v = await resolveLeaveViewer(ctx.user);
    if (!v.employeeId || v.isExtra || v.isPartner || v.role === "super_admin") return { names: [] as string[], auto: v.role === "super_admin" };
    const ap = await approversForEmployee(v.employeeId, v.settings);
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db || !ap.userIds.length) return { names: [] as string[], auto: false };
    const res: any = await db.execute(sql`SELECT id, name, email FROM users WHERE id IN (${sql.join(ap.userIds.map((id) => sql`${id}`), sql`, `)})`);
    const rows = (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];
    return { names: rows.map((r) => String(r.name || r.email || "uma conta sem nome")).sort((a, b) => a.localeCompare(b, "pt")), auto: false };
  }),
  request: protectedProcedure
    .input(z.object({ fromDate: isoDay, toDate: isoDay, notes: z.string().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      await assertMapOn();
      return requestLeave(await resolveLeaveViewer(ctx.user), input);
    }),
  pending: protectedProcedure.query(async ({ ctx }) => {
    await assertMapOn();
    return pendingForApprover(await resolveLeaveViewer(ctx.user));
  }),
  decide: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), approve: z.boolean(), note: z.string().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      await assertMapOn();
      return decideLeave(await resolveLeaveViewer(ctx.user), input);
    }),
  /** Para quem lança ausências: as fichas que pode gerir (o servidor volta a confirmar ao gravar). */
  launchPeople: protectedProcedure.query(async ({ ctx }) => {
    await assertMapOn();
    if (!canAccess(ctx.user, "rh", "manage")) return [];
    const { getDb } = await import("./db");
    const { projectScope } = await import("./cityScope");
    const db = await getDb();
    if (!db) return [];
    const res: any = await db.execute(sql`SELECT e.id, e.fullName, e.position, e.contractType FROM employees e
       WHERE e.isActive = 1 AND COALESCE(e.contractType, '') <> 'partner_company' AND ${projectScope(sql`e.projectId`)} ORDER BY e.fullName LIMIT 2000`);
    const rows = (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];
    return rows.map((r) => ({ id: Number(r.id), fullName: String(r.fullName ?? ""), isExtra: r.position === "extra" || r.contractType === "extra" }));
  }),
  /** O mapa em PDF: só férias aprovadas (nunca baixas). Quem vê tudo e o supervisor (a sua área). */
  pdf: protectedProcedure
    .input(z.object({ year, cityKey }))
    .mutation(async ({ ctx, input }) => {
      await assertMapOn();
      const v = await resolveLeaveViewer(ctx.user);
      if (v.mode !== "full" && v.mode !== "supervisor") throw new TRPCError({ code: "FORBIDDEN", message: "O mapa em PDF é para o RH e os supervisores." });
      const data = await leaveMapForPdf(v, input.year, input.cityKey ?? null);
      const { renderLeaveMapPdf } = await import("./leavesPdf");
      const pdf = await renderLeaveMapPdf(data);
      return { fileName: `mapa_ferias_${input.year}${input.cityKey && input.cityKey !== "all" ? `_${input.cityKey}` : ""}.pdf`, base64: pdf.toString("base64") };
    }),
});
