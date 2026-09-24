/**
 * Router tRPC `evaluation` — Avaliação individual sobre o motor único
 * (employee_day_metrics + ajustes manuais + contestações).
 *
 * Guardas (as mesmas que já existiam na Avaliação — não mudam):
 *  - ranking e detalhe de OUTRA pessoa: frontoffice+ (como performance.range),
 *    dentro do âmbito de cidade (employeeScope / assertEmployeeAccess);
 *  - "A minha avaliação" (mine, detalhe próprio, contestar): qualquer pessoa
 *    com ficha (extra+), SÓ os próprios dados — o colaborador vem da sessão,
 *    nunca do pedido;
 *  - recalcular, ajustar e resolver contestações: supervisor+ (como
 *    performance.generate/update); ninguém ajusta nem resolve os seus.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { assertEmployeeAccess } from "./cityScope";
import { getEmployeeByUserId, logActivity } from "./db";
import {
  createAdjustment,
  createDispute,
  currentOperationalDay,
  getAdjustment,
  getDispute,
  listDisputes,
  loadEvaluatedDays,
  recomputeRange,
  resolveDispute,
  voidAdjustment,
  type EvaluatedDay,
} from "./evaluationEngine";
import {
  ADJUSTABLE_METRICS,
  METRIC_KEYS,
  perHourMetrics,
  scoreOf,
  sumMetrics,
  type MetricKey,
} from "../shared/evaluationRules";
import { addDays, daysInRange } from "../shared/lisbonDay";

const ROLE_HIERARCHY: Record<string, number> = { super_admin: 7, admin: 6, supervisor: 5, team_leader: 4, backoffice: 3, frontoffice: 2, condutor: 1, extra: 1, user: 0 };
const atLeast = (role: string, min: string) => (ROLE_HIERARCHY[role] ?? -1) >= (ROLE_HIERARCHY[min] ?? 0);
function requireRole(role: string, min: string) {
  if (!atLeast(role, min)) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
}

const isIsoDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const daySchema = z.string().refine(isIsoDay, "Data inválida (AAAA-MM-DD)");
const MAX_DAYS = 400;
const rangeSchema = z.object({ from: daySchema, to: daySchema }).refine((r) => r.from <= r.to, "Intervalo inválido")
  .refine((r) => daysInRange(r.from, r.to).length < MAX_DAYS, "Intervalo demasiado grande");
const metricSchema = z.string().refine((m) => (METRIC_KEYS as string[]).includes(m), "Métrica inválida");

async function myEmployee(userId: number): Promise<{ id: number; fullName: string } | null> {
  const me = await getEmployeeByUserId(userId);
  return me?.employee ? { id: me.employee.id, fullName: me.employee.fullName } : null;
}

/** Soma de dias de UMA pessoa: métricas, pontuação por regra e por hora. */
function totalsOf(days: EvaluatedDay[]) {
  const metrics = sumMetrics(days.map((d) => d.metrics));
  const score = scoreOf(metrics);
  return { metrics, score, perHour: perHourMetrics(metrics, score), days: days.length };
}

/** Detalhe de uma pessoa (dias + totais + contestações). */
async function employeeDetail(employeeId: number, from: string, to: string) {
  // anulados aparecem no histórico, mas não contam (applyAdjustments ignora-os)
  const days = await loadEvaluatedDays({ startDay: from, endDay: to, employeeIds: [employeeId], includeVoided: true });
  const disputes = await listDisputes({ employeeId, startDay: from, endDay: to });
  return { days, totals: totalsOf(days), disputes };
}

export const evaluationRouter = router({
  /** Ranking do período (soma dos dias) — frontoffice+, âmbito de cidade. */
  ranking: protectedProcedure.input(rangeSchema).query(async ({ ctx, input }) => {
    requireRole(ctx.user.role, "frontoffice");
    const days = await loadEvaluatedDays({ startDay: input.from, endDay: input.to, rankingOnly: true });
    const byEmp = new Map<number, EvaluatedDay[]>();
    for (const d of days) {
      const list = byEmp.get(d.employeeId) ?? [];
      list.push(d);
      byEmp.set(d.employeeId, list);
    }
    const openDisputes = await listDisputes({ status: "open", startDay: input.from, endDay: input.to, limit: 1000 });
    const openBy = new Map<number, number>();
    for (const o of openDisputes) openBy.set(o.employeeId, (openBy.get(o.employeeId) ?? 0) + 1);
    return Array.from(byEmp.entries()).map(([employeeId, list]) => {
      const t = totalsOf(list);
      return {
        employeeId,
        employeeName: list[0].employeeName,
        position: list[0].position,
        days: t.days,
        metrics: t.metrics,
        score: t.score,
        perHour: t.perHour,
        adjustments: list.reduce((s, d) => s + d.adjustments.length, 0),
        openDisputes: openBy.get(employeeId) ?? 0,
      };
    }).sort((a, b) => b.score.totalPoints - a.score.totalPoints || a.employeeName.localeCompare(b.employeeName));
  }),

  /** Detalhe (gaveta): dias e métricas de uma pessoa. O próprio vê sempre os seus. */
  employeeDays: protectedProcedure.input(rangeSchema.and(z.object({ employeeId: z.number().int().positive() })))
    .query(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "extra");
      const me = await myEmployee(ctx.user.id);
      if (me?.id !== input.employeeId) {
        requireRole(ctx.user.role, "frontoffice");
        await assertEmployeeAccess(input.employeeId);
      }
      return employeeDetail(input.employeeId, input.from, input.to);
    }),

  /** "A minha avaliação": só os dados da ficha de quem tem a sessão. */
  mine: protectedProcedure.input(rangeSchema).query(async ({ ctx, input }) => {
    requireRole(ctx.user.role, "extra");
    const me = await myEmployee(ctx.user.id);
    if (!me) return { employee: null, days: [], totals: null, disputes: [] };
    const detail = await employeeDetail(me.id, input.from, input.to);
    return { employee: me, ...detail };
  }),

  /** Recalcular um período (máx. 93 dias) — supervisor+ (como "Gerar Avaliação"). */
  recompute: protectedProcedure.input(rangeSchema).mutation(async ({ ctx, input }) => {
    requireRole(ctx.user.role, "supervisor");
    const today = currentOperationalDay();
    const to = input.to > today ? today : input.to;
    if (input.from > to) return { days: 0, written: 0, removed: 0 };
    const days = daysInRange(input.from, to);
    if (days.length > 93) throw new TRPCError({ code: "BAD_REQUEST", message: "No máximo 93 dias de cada vez." });
    let written = 0, removed = 0;
    for (let i = 0; i < days.length; i += 7) {
      const r = await recomputeRange(days[i], days[Math.min(i + 6, days.length - 1)]);
      written += r.written;
      removed += r.removed;
    }
    await logActivity({ userId: ctx.user.id, action: "generate", entity: "employee_day_metrics", details: `Avaliação recalculada ${input.from} a ${to}: ${written} dia(s)` });
    return { days: days.length, written, removed };
  }),

  /** Ajuste manual (delta sobre uma métrica de um dia) — supervisor+, com motivo. */
  adjust: protectedProcedure.input(z.object({
    employeeId: z.number().int().positive(),
    day: daySchema,
    metric: metricSchema,
    delta: z.number().finite().refine((n) => n !== 0 && Math.abs(n) <= 100000, "Valor inválido"),
    reason: z.string().trim().min(3, "Indica o motivo").max(500),
  })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.user.role, "supervisor");
    if (!(ADJUSTABLE_METRICS as string[]).includes(input.metric)) throw new TRPCError({ code: "BAD_REQUEST", message: "Esta métrica não se ajusta à mão." });
    await assertEmployeeAccess(input.employeeId);
    const me = await myEmployee(ctx.user.id);
    if (me?.id === input.employeeId) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes ajustar a tua própria avaliação." });
    if (input.day > addDays(currentOperationalDay(), 1)) throw new TRPCError({ code: "BAD_REQUEST", message: "Dia no futuro." });
    const id = await createAdjustment({
      employeeId: input.employeeId, day: input.day, metric: input.metric as MetricKey, delta: input.delta,
      reason: input.reason, authorId: ctx.user.id, authorName: ctx.user.name ?? null,
    });
    await logActivity({ userId: ctx.user.id, action: "create", entity: "employee_metric_adjustment", entityId: id, details: `${input.metric} ${input.delta > 0 ? "+" : ""}${input.delta} (${input.day}) — ${input.reason}` });
    return { id };
  }),

  /** Anular um ajuste (fica no histórico) — supervisor+. */
  voidAdjustment: protectedProcedure.input(z.object({ id: z.number().int().positive(), reason: z.string().trim().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "supervisor");
      const adj = await getAdjustment(input.id);
      if (!adj) throw new TRPCError({ code: "NOT_FOUND", message: "Ajuste não encontrado." });
      await assertEmployeeAccess(adj.employeeId);
      const me = await myEmployee(ctx.user.id);
      if (me?.id === adj.employeeId) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes alterar a tua própria avaliação." });
      await voidAdjustment(input.id, ctx.user.id, input.reason ?? null);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "employee_metric_adjustment", entityId: input.id, details: "Ajuste anulado" });
      return { success: true };
    }),

  disputes: router({
    /** O colaborador contesta um dia (e, opcionalmente, uma métrica) da SUA avaliação. */
    create: protectedProcedure.input(z.object({
      day: daySchema,
      metric: metricSchema.nullable().optional(),
      comment: z.string().trim().min(5, "Explica o que está errado").max(2000),
    })).mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "extra");
      const me = await myEmployee(ctx.user.id);
      if (!me) throw new TRPCError({ code: "FORBIDDEN", message: "A tua conta não tem ficha de colaborador." });
      if (input.day > currentOperationalDay()) throw new TRPCError({ code: "BAD_REQUEST", message: "Esse dia ainda não aconteceu." });
      const open = await listDisputes({ employeeId: me.id, status: "open", startDay: input.day, endDay: input.day });
      if (open.some((d) => (d.metric ?? null) === (input.metric ?? null))) {
        throw new TRPCError({ code: "CONFLICT", message: "Já tens uma contestação em análise para este dia." });
      }
      const id = await createDispute({ employeeId: me.id, day: input.day, metric: input.metric ?? null, comment: input.comment, userId: ctx.user.id });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "employee_metric_dispute", entityId: id, details: `${input.day}${input.metric ? ` · ${input.metric}` : ""}` });
      return { id };
    }),

    /** Contestações (gestão) — supervisor+, âmbito de cidade. */
    list: protectedProcedure.input(z.object({
      status: z.enum(["open", "accepted", "rejected"]).optional(),
      from: daySchema.optional(),
      to: daySchema.optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "supervisor");
      return listDisputes({ status: input?.status, startDay: input?.from, endDay: input?.to });
    }),

    /** Aceitar (com ajuste opcional) ou recusar — supervisor+, nunca a própria. */
    resolve: protectedProcedure.input(z.object({
      id: z.number().int().positive(),
      accept: z.boolean(),
      resolution: z.string().trim().min(3, "Indica a decisão").max(2000),
      adjustment: z.object({
        metric: metricSchema,
        delta: z.number().finite().refine((n) => n !== 0 && Math.abs(n) <= 100000, "Valor inválido"),
      }).nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "supervisor");
      const d = await getDispute(input.id);
      if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "Contestação não encontrada." });
      await assertEmployeeAccess(d.employeeId);
      const me = await myEmployee(ctx.user.id);
      if (me?.id === d.employeeId) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes decidir a tua própria contestação." });
      if (d.status !== "open") throw new TRPCError({ code: "CONFLICT", message: "Esta contestação já foi decidida." });
      let adjustmentId: number | null = null;
      if (input.accept && input.adjustment) {
        if (!(ADJUSTABLE_METRICS as string[]).includes(input.adjustment.metric)) throw new TRPCError({ code: "BAD_REQUEST", message: "Esta métrica não se ajusta à mão." });
        adjustmentId = await createAdjustment({
          employeeId: d.employeeId, day: d.day, metric: input.adjustment.metric, delta: input.adjustment.delta,
          reason: `Contestação #${d.id}: ${input.resolution}`, authorId: ctx.user.id, authorName: ctx.user.name ?? null, disputeId: d.id,
        });
      }
      const ok = await resolveDispute({
        id: d.id, status: input.accept ? "accepted" : "rejected", resolution: input.resolution,
        byId: ctx.user.id, byName: ctx.user.name ?? null, adjustmentId,
      });
      if (!ok) {
        if (adjustmentId != null) await voidAdjustment(adjustmentId, ctx.user.id, "Contestação já decidida por outra pessoa");
        throw new TRPCError({ code: "CONFLICT", message: "Esta contestação já foi decidida." });
      }
      await logActivity({ userId: ctx.user.id, action: "update", entity: "employee_metric_dispute", entityId: d.id, details: input.accept ? "Aceite" : "Recusada" });
      return { success: true, adjustmentId };
    }),
  }),
});
