/**
 * Router tRPC `evaluation` — Avaliação individual sobre o motor único
 * (employee_day_metrics + ajustes manuais + contestações).
 *
 * Guardas — a matriz de acessos (shared/access.ts, módulo `avaliacao`, com
 * as permissões por utilizador), a MESMA que o ecrã usa:
 *  - ranking e detalhe de OUTRA pessoa: ver além do "own" (team leader só a
 *    equipa, "below_city"), dentro do âmbito de cidade;
 *  - "A minha avaliação" (mine, detalhe próprio, contestar): quem tem o módulo,
 *    SÓ os próprios dados — o colaborador vem da sessão, nunca do pedido;
 *  - recalcular, ajustar e resolver contestações: "edit" (supervisor, front e
 *    backoffice, administração); ninguém ajusta nem resolve os seus.
 * (Antes havia aqui uma escada de papéis própria, diferente da do resto da app.)
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { employeeBelowCondition, requireAccess, withOverrides } from "./_core/access";
import { assertEmployeeAccess, cityScope, projectScope } from "./cityScope";
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
import { scopeFor } from "../shared/access";

type Viewer = { id: number; role: string; name?: string | null };
/** Ver OUTRAS pessoas (ranking, detalhe): o módulo além do "own". */
const requireOthers = (user: Viewer) => requireAccess(user, "avaliacao", "view");
/** Os próprios dados ("A minha avaliação", contestar): basta ter o módulo. */
const requireOwn = (user: Viewer) => requireAccess(user, "avaliacao", "view", { allowOwn: true });
/** Recalcular, ajustar, contestações: "edit". */
const requireManage = (user: Viewer) => requireAccess(user, "avaliacao", "edit");

/**
 * Team leader ("below_city"): só a equipa (condutores/extras abaixo dele na
 * cidade) e ele próprio. null = sem restrição além da cidade.
 */
export async function evaluationTeamIds(user: Viewer): Promise<Set<number> | null> {
  if (scopeFor(withOverrides(user), "avaliacao") !== "below_city") return null;
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  const ids = new Set<number>();
  if (db) {
    const [rows] = await db.execute(sql`SELECT e.id FROM employees e
      WHERE ${projectScope(sql`e.projectId`)} AND ${await employeeBelowCondition(user, sql`e.id`)}`) as any;
    for (const r of (rows as any[]) ?? []) ids.add(Number(r.id));
  }
  const me = await myEmployee(user.id);
  if (me) ids.add(me.id);
  return ids;
}

/** Outra pessoa: dentro da cidade e, para o team leader, da equipa. */
async function assertCanSee(user: Viewer, employeeId: number) {
  await assertEmployeeAccess(employeeId);
  const team = await evaluationTeamIds(user);
  if (team && !team.has(employeeId)) throw new TRPCError({ code: "FORBIDDEN", message: "Só vês a avaliação da tua equipa." });
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

/** Cidades do pedido (Park.city). undefined = todas; [] = nenhuma. */
function scopedCityNames(): string[] | undefined {
  const a = cityScope.getStore();
  if (!a || a.all) return undefined;
  return a.cityNames ?? (a.cityName ? [a.cityName] : []);
}

/** Máximo de dias do resumo vivo (uma leitura agregada na BD da Multipark). */
export const LIVE_MOVEMENTS_MAX_DAYS = 62;

export const evaluationRouter = router({
  /** Ranking do período (soma dos dias) — quem vê outras pessoas, âmbito de cidade (team leader: a equipa). */
  ranking: protectedProcedure.input(rangeSchema).query(async ({ ctx, input }) => {
    requireOthers(ctx.user);
    const days = await loadEvaluatedDays({ startDay: input.from, endDay: input.to, rankingOnly: true });
    const team = await evaluationTeamIds(ctx.user);
    const byEmp = new Map<number, EvaluatedDay[]>();
    for (const d of days) {
      if (team && !team.has(d.employeeId)) continue;
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

  /**
   * Movimentos do período lidos AO VIVO da BD da Multipark, por pessoa (as
   * várias contas de agente de uma ficha somam): fases, reservas, check-ins
   * e check-outs assinados, ocorrências e avaliações dos clientes. Âmbito de
   * cidade pelo parque (Park.city). Nunca lança por falta de BD.
   */
  liveMovements: protectedProcedure.input(rangeSchema).query(async ({ ctx, input }) => {
    requireOthers(ctx.user);
    if (daysInRange(input.from, input.to).length > LIVE_MOVEMENTS_MAX_DAYS) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `No máximo ${LIVE_MOVEMENTS_MAX_DAYS} dias.` });
    }
    const { getAgentMovementSummaries, sumAgentSummaries } = await import("./multiparkDb/movements");
    const r = await getAgentMovementSummaries({ startDay: input.from, endDay: input.to, byDay: false, cities: scopedCityNames() });
    if (!r.available) return { available: false as const, reason: r.reason, code: r.code };
    const { loadEvaluationIdentity } = await import("./evaluationIdentity");
    const { identity } = await loadEvaluationIdentity();
    const groups = new Map<string, { employeeId: number | null; name: string; kind: string; list: typeof r.data }>();
    for (const s of r.data) {
      const who = identity.agent(s.agentUserId, s.agentName);
      if (who.kind === "ignorado") continue;
      const g = groups.get(who.key) ?? { employeeId: who.employeeId, name: who.name, kind: who.kind, list: [] };
      g.list.push(s);
      groups.set(who.key, g);
    }
    // Team leader: só a equipa (agentes sem ficha e parceiros não são da equipa).
    const team = await evaluationTeamIds(ctx.user);
    const rows = Array.from(groups.entries()).map(([key, g]) => ({ key, employeeId: g.employeeId, name: g.name, kind: g.kind, ...sumAgentSummaries(g.list)! }))
      .filter((r) => !team || (r.employeeId != null && team.has(r.employeeId)))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return { available: true as const, rows };
  }),

  /** Detalhe (gaveta): dias e métricas de uma pessoa. O próprio vê sempre os seus. */
  employeeDays: protectedProcedure.input(rangeSchema.and(z.object({ employeeId: z.number().int().positive() })))
    .query(async ({ ctx, input }) => {
      requireOwn(ctx.user);
      const me = await myEmployee(ctx.user.id);
      if (me?.id !== input.employeeId) {
        requireOthers(ctx.user);
        await assertCanSee(ctx.user, input.employeeId);
      }
      return employeeDetail(input.employeeId, input.from, input.to);
    }),

  /** "A minha avaliação": só os dados da ficha de quem tem a sessão. */
  mine: protectedProcedure.input(rangeSchema).query(async ({ ctx, input }) => {
    requireOwn(ctx.user);
    const me = await myEmployee(ctx.user.id);
    if (!me) return { employee: null, days: [], totals: null, disputes: [] };
    const detail = await employeeDetail(me.id, input.from, input.to);
    return { employee: me, ...detail };
  }),

  /**
   * Explicação curta (PT-PT) da pontuação do período, a partir das linhas das
   * regras já calculadas (a IA nunca recalcula). Próprio: "A minha avaliação";
   * outra pessoa: os mesmos guardas do detalhe (employeeDays).
   */
  explanation: protectedProcedure.input(rangeSchema.and(z.object({ employeeId: z.number().int().positive().optional() })))
    .query(async ({ ctx, input }) => {
      requireOwn(ctx.user);
      const me = await myEmployee(ctx.user.id);
      const employeeId = input.employeeId ?? me?.id;
      if (!employeeId) return null;
      const self = me?.id === employeeId;
      if (!self) {
        requireOthers(ctx.user);
        await assertCanSee(ctx.user, employeeId);
      }
      const days = await loadEvaluatedDays({ startDay: input.from, endDay: input.to, employeeIds: [employeeId] });
      if (!days.length) return null;
      const t = totalsOf(days);
      const { getExplanation } = await import("./aiOps/evaluationExplain");
      const r = await getExplanation({ employeeId, from: input.from, to: input.to, lines: t.score.lines, total: t.score.totalPoints, viewerIsSelf: self, userId: ctx.user.id });
      return { ...r, canHide: !self && scopeFor(withOverrides(ctx.user), "avaliacao") !== "own" };
    }),

  /** O team leader (ou acima) esconde/mostra a explicação a um colaborador. Nunca a própria. */
  setExplanationHidden: protectedProcedure.input(rangeSchema.and(z.object({ employeeId: z.number().int().positive(), hidden: z.boolean() })))
    .mutation(async ({ ctx, input }) => {
      requireOthers(ctx.user);
      const me = await myEmployee(ctx.user.id);
      if (me?.id === input.employeeId) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes esconder a explicação da tua própria avaliação." });
      await assertCanSee(ctx.user, input.employeeId);
      const { setExplanationHidden } = await import("./aiOps/evaluationExplain");
      await setExplanationHidden({ employeeId: input.employeeId, from: input.from, to: input.to, hidden: input.hidden, user: { id: ctx.user.id, name: (ctx.user as any).name ?? null } });
      await logActivity({ userId: ctx.user.id, action: input.hidden ? "hide_explanation" : "show_explanation", entity: "evaluation", entityId: input.employeeId, details: `${input.from}..${input.to}` });
      return { success: true };
    }),

  /** Recalcular um período (máx. 93 dias) — quem gere a Avaliação ("edit"). */
  recompute: protectedProcedure.input(rangeSchema).mutation(async ({ ctx, input }) => {
    requireManage(ctx.user);
    const today = currentOperationalDay();
    const to = input.to > today ? today : input.to;
    if (input.from > to) return { days: 0, written: 0, removed: 0, source: "multipark" as const, notice: null, partial: false, until: to, skipped: false };
    const days = daysInRange(input.from, to);
    if (days.length > 93) throw new TRPCError({ code: "BAD_REQUEST", message: "No máximo 93 dias de cada vez." });
    // Cada fatia de 7 dias lê os movimentos AO VIVO da BD da Multipark (uma
    // consulta agregada). Para caber na função (60 s), pára a tempo e diz até
    // onde chegou — o cron diário faz o resto das 4 semanas.
    const deadline = Date.now() + 40_000;
    let written = 0, removed = 0, doneDays = 0;
    let source: "multipark" | "copia" = "multipark";
    let notice: string | null = null;
    for (let i = 0; i < days.length; i += 7) {
      if (i > 0 && Date.now() > deadline) break;
      const end = Math.min(i + 6, days.length - 1);
      const r = await recomputeRange(days[i], days[end]);
      // Sem a BD da Multipark nada se grava (ficam os valores anteriores): parar já.
      if (r.skipped) { source = "copia"; notice = r.notice ?? notice; break; }
      written += r.written;
      removed += r.removed;
      doneDays = end + 1;
    }
    const skipped = source === "copia";
    const partial = doneDays < days.length;
    await logActivity({ userId: ctx.user.id, action: "generate", entity: "employee_day_metrics", details: skipped && doneDays === 0
      ? `Avaliação NÃO recalculada (${input.from} a ${to}): BD da Multipark indisponível, ficam os valores anteriores`
      : `Avaliação recalculada ${input.from} a ${days[Math.max(0, doneDays - 1)]}: ${written} dia(s)${skipped ? " (parou: BD da Multipark indisponível)" : ""}` });
    return { days: doneDays, written, removed, source, notice, partial, until: days[Math.max(0, doneDays - 1)], skipped };
  }),

  /** Ajuste manual (delta sobre uma métrica de um dia) — "edit", com motivo. */
  adjust: protectedProcedure.input(z.object({
    employeeId: z.number().int().positive(),
    day: daySchema,
    metric: metricSchema,
    delta: z.number().finite().refine((n) => n !== 0 && Math.abs(n) <= 100000, "Valor inválido"),
    reason: z.string().trim().min(3, "Indica o motivo").max(500),
  })).mutation(async ({ ctx, input }) => {
    requireManage(ctx.user);
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

  /** Anular um ajuste (fica no histórico) — "edit". */
  voidAdjustment: protectedProcedure.input(z.object({ id: z.number().int().positive(), reason: z.string().trim().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireManage(ctx.user);
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
      requireOwn(ctx.user);
      const me = await myEmployee(ctx.user.id);
      if (!me) throw new TRPCError({ code: "FORBIDDEN", message: "A tua conta não tem ficha de colaborador." });
      if (input.day > currentOperationalDay()) throw new TRPCError({ code: "BAD_REQUEST", message: "Esse dia ainda não aconteceu." });
      const open = await listDisputes({ employeeId: me.id, status: "open", startDay: input.day, endDay: input.day });
      if (open.some((d) => (d.metric ?? null) === (input.metric ?? null))) {
        throw new TRPCError({ code: "CONFLICT", message: "Já tens uma contestação em análise para este dia." });
      }
      const id = await createDispute({ employeeId: me.id, day: input.day, metric: input.metric ?? null, comment: input.comment, userId: ctx.user.id });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "employee_metric_dispute", entityId: id, details: `${input.day}${input.metric ? ` · ${input.metric}` : ""}` });
      // Supervisores DA CIDADE da pessoa (+ quem vê todas) — `evaluation_dispute`.
      const { notify } = await import("./notify");
      await notify({
        kind: "evaluation_dispute", employeeId: me.id,
        title: `Contestação da avaliação: ${me.fullName}`,
        body: `${input.day}${input.metric ? ` · ${input.metric}` : ""}: ${input.comment.slice(0, 200)}`,
        link: "/avaliacao", entity: { type: "evaluation_dispute", id },
      });
      return { id };
    }),

    /** Contestações (gestão) — "edit", âmbito de cidade. */
    list: protectedProcedure.input(z.object({
      status: z.enum(["open", "accepted", "rejected"]).optional(),
      from: daySchema.optional(),
      to: daySchema.optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireManage(ctx.user);
      return listDisputes({ status: input?.status, startDay: input?.from, endDay: input?.to });
    }),

    /** Aceitar (com ajuste opcional) ou recusar — "edit", nunca a própria. */
    resolve: protectedProcedure.input(z.object({
      id: z.number().int().positive(),
      accept: z.boolean(),
      resolution: z.string().trim().min(3, "Indica a decisão").max(2000),
      adjustment: z.object({
        metric: metricSchema,
        delta: z.number().finite().refine((n) => n !== 0 && Math.abs(n) <= 100000, "Valor inválido"),
      }).nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireManage(ctx.user);
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
      // Pessoal: só a pessoa que contestou.
      try {
        if (d.createdByUserId) {
          const { notify } = await import("./notify");
          await notify({
            kind: "my_evaluation", targetUserId: d.createdByUserId,
            title: `Contestação ${input.accept ? "aceite" : "recusada"} (${d.day})`,
            body: input.resolution.slice(0, 300), link: "/avaliacao", entity: { type: "evaluation_dispute", id: d.id },
          });
        }
      } catch { /* o aviso nunca parte a decisão */ }
      return { success: true, adjustmentId };
    }),
  }),
});
