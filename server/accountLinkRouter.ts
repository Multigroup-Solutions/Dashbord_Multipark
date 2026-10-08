/**
 * Router `accountLink` (49c, Jorge, 8 out 2026): o ecrã "Liga a tua conta"
 * (conta Google sem ficha) e a caixa do RH com os pedidos de ligação, os
 * possíveis duplicados, quem "Quer voltar" e os candidatos por aprovar.
 * Regras em server/accountLink.ts e shared/accountLink.ts.
 *
 * `mine`, `startCandidate`, `request` e `confirmCode` são da própria pessoa
 * (caminhos pessoais em server/cityAccess.ts — abrem sem ficha nem cidade).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "./_core/trpc";
import { canAccess, requireAccess } from "./_core/access";
import { assertEmployeeAccess, scopedProjectIds } from "./cityScope";
import { ACCOUNT_LINK_LIMITS, linkRequestSummary } from "../shared/accountLink";
import { deactivationKind, deactivationReasonLabel } from "../shared/deactivationReasons";
import { CITY_KEYS, CITY_LABELS } from "../shared/city";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];
const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function database() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  return d as unknown as { execute: (q: any) => Promise<any> };
}

/** O pedido está nas cidades de quem vê? Ficha encontrada → a cidade dela; candidatura → a cidade escrita; nada → só quem vê todas. */
function requestVisible(r: { matchedProjectId: number | null; requesterProjectId: number | null; appCity: string | null }, scope: number[] | undefined, cityKeys: string[] | undefined, cityTextVisible: (t: string | null, a: any) => boolean): boolean {
  if (scope === undefined) return true;
  const pid = r.matchedProjectId ?? r.requesterProjectId;
  if (pid != null) return scope.includes(pid);
  return !!r.appCity && cityTextVisible(r.appCity, cityKeys);
}

export const accountLinkRouter = router({
  /** O ecrã "Liga a tua conta": tenho ficha? há um pedido meu pendente? o código está ligado? */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const { getEmployeeByUserId } = await import("./db");
    const me = await getEmployeeByUserId(ctx.user.id);
    const { realLinkDeps } = await import("./accountLink");
    const codeOn = await realLinkDeps().flagOn().catch(() => false);
    const d = await database();
    const [p] = rowsOf(await d.execute(sql`SELECT id, claimedEmail, claimedPhone, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i') AS createdAt,
        (createdAt >= NOW() - INTERVAL ${ACCOUNT_LINK_LIMITS.codeMinutes} MINUTE) AS recent
      FROM account_link_requests WHERE userId = ${ctx.user.id} AND kind = 'link' AND status = 'pending' ORDER BY id DESC LIMIT 1`).catch(() => [[]]));
    return {
      email: ctx.user.email ?? null,
      hasEmployee: !!me,
      codeOn,
      pending: p ? { id: Number(p.id), claimed: p.claimedEmail ?? p.claimedPhone ?? null, createdAt: p.createdAt ?? null, codeWindow: codeOn && Number(p.recent) === 1 } : null,
    };
  }),

  /** "Sou novo — quero candidatar-me". */
  startCandidate: protectedProcedure
    .input(z.object({ city: z.enum(CITY_KEYS).nullable().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const { startCandidate, realCandidateDeps } = await import("./accountLink");
      const city = input?.city ? CITY_LABELS[input.city] : null;
      return startCandidate(realCandidateDeps(), { id: ctx.user.id, email: ctx.user.email ?? null, name: (ctx.user as any).name ?? null }, { city });
    }),

  /** "Já me candidatei / já trabalhei convosco com outro email": o email OU o telefone. */
  request: protectedProcedure
    .input(z.object({ claim: z.string().trim().min(3).max(320) }))
    .mutation(async ({ ctx, input }) => {
      const { getEmployeeByUserId } = await import("./db");
      if (await getEmployeeByUserId(ctx.user.id)) throw new TRPCError({ code: "BAD_REQUEST", message: "A tua conta já está ligada a uma ficha." });
      const { createLinkRequest, realLinkDeps } = await import("./accountLink");
      return createLinkRequest(realLinkDeps(), { id: ctx.user.id, email: ctx.user.email ?? null }, input.claim);
    }),

  /** O código que chegou por email. */
  confirmCode: protectedProcedure
    .input(z.object({ requestId: z.number().int().positive(), code: z.string().trim().min(1).max(12) }))
    .mutation(async ({ ctx, input }) => {
      const { confirmLinkCode, realLinkDeps } = await import("./accountLink");
      return confirmLinkCode(realLinkDeps(), { id: ctx.user.id, email: ctx.user.email ?? null }, input.requestId, input.code);
    }),

  /**
   * Para o RH (Leads de Extras → Candidaturas): pedidos de ligação e possíveis
   * duplicados por decidir, quem "Quer voltar" e os candidatos por aprovar —
   * só os das cidades de quem vê (sem cidade: quem vê todas).
   */
  inbox: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "leads_extras", "view");
    const d = await database();
    const scope = scopedProjectIds();
    const { cityTextVisible, currentCityKeys } = await import("./extrasCityFilter");
    const keys = currentCityKeys();
    const reqs = rowsOf(await d.execute(sql`SELECT r.id, r.kind, r.userId, r.googleEmail, r.claimedEmail, r.claimedPhone, r.employeeId, r.matchedEmployeeId, r.matchedApplicationId,
        r.note, r.attempts, (r.codeHash IS NOT NULL AND r.codeExpiresAt > UTC_TIMESTAMP()) AS codeOut, DATE_FORMAT(r.createdAt, '%Y-%m-%d %H:%i') AS createdAt,
        u.name AS userName, me.fullName AS matchedName, me.projectId AS matchedProjectId, me.isActive AS matchedActive, me.deactivationReason AS matchedReason, me.position AS matchedPosition,
        ce.fullName AS requesterName, ce.projectId AS requesterProjectId, a.fullName AS appName, a.city AS appCity
      FROM account_link_requests r
      LEFT JOIN users u ON u.id = r.userId
      LEFT JOIN employees me ON me.id = r.matchedEmployeeId
      LEFT JOIN employees ce ON ce.id = r.employeeId
      LEFT JOIN driver_applications a ON a.id = r.matchedApplicationId
      WHERE r.status = 'pending' ORDER BY r.id DESC LIMIT 300`).catch(() => [[]]));
    const requests = reqs
      .filter((r) => requestVisible({ matchedProjectId: r.matchedProjectId == null ? null : Number(r.matchedProjectId), requesterProjectId: r.requesterProjectId == null ? null : Number(r.requesterProjectId), appCity: r.appCity ?? null }, scope, keys as any, cityTextVisible as any))
      .map((r) => ({
        id: Number(r.id), kind: String(r.kind) as "link" | "duplicate", userId: Number(r.userId), userName: r.userName ?? null, googleEmail: r.googleEmail ?? null,
        claimed: r.claimedEmail ?? r.claimedPhone ?? null, summary: linkRequestSummary(r), note: r.note ?? null, createdAt: r.createdAt ?? null, codeOut: Number(r.codeOut) === 1,
        employeeId: r.employeeId == null ? null : Number(r.employeeId), requesterName: r.requesterName ?? null,
        matchedEmployeeId: r.matchedEmployeeId == null ? null : Number(r.matchedEmployeeId), matchedName: r.matchedName ?? null,
        matchedState: r.matchedEmployeeId == null ? null : Number(r.matchedActive) === 1 ? "ativo" : deactivationKind(r.matchedReason),
        matchedReason: r.matchedEmployeeId != null && Number(r.matchedActive) !== 1 ? deactivationReasonLabel(r.matchedReason) || "sem motivo" : null,
        matchedApplicationId: r.matchedApplicationId == null ? null : Number(r.matchedApplicationId), appName: r.appName ?? null, appCity: r.appCity ?? null,
      }));
    const inScope = (pid: unknown) => scope === undefined || (pid != null && scope.includes(Number(pid)));
    const comebacks = rowsOf(await d.execute(sql`SELECT e.id, e.fullName, e.position, e.projectId, p.name AS projectName, e.deactivationReason, e.deactivationReasonOther,
        DATE_FORMAT(e.comebackRequestedAt, '%Y-%m-%d %H:%i') AS comebackRequestedAt
      FROM employees e LEFT JOIN projects p ON p.id = e.projectId
      WHERE e.isActive = 0 AND e.comebackRequestedAt IS NOT NULL ORDER BY e.comebackRequestedAt DESC LIMIT 200`).catch(() => [[]]))
      .filter((r) => inScope(r.projectId))
      .map((r) => ({ id: Number(r.id), fullName: String(r.fullName ?? ""), position: r.position ?? null, projectName: r.projectName ?? null,
        reason: deactivationReasonLabel(r.deactivationReason, r.deactivationReasonOther) || null, comebackRequestedAt: r.comebackRequestedAt ?? null }));
    const candidates = rowsOf(await d.execute(sql`SELECT e.id, e.fullName, e.email, e.phone, e.projectId, DATE_FORMAT(e.createdAt, '%Y-%m-%d %H:%i') AS createdAt
      FROM employees e WHERE e.isActive = 0 AND e.deactivationReason = 'candidato' ORDER BY e.id DESC LIMIT 200`).catch(() => [[]]))
      .filter((r) => inScope(r.projectId))
      .map((r) => ({ id: Number(r.id), fullName: String(r.fullName ?? ""), email: r.email ?? null, phone: r.phone ?? null, createdAt: r.createdAt ?? null }));
    return { requests, comebacks, candidates, canDecide: canAccess(ctx.user, "rh", "manage"), canReactivate: canAccess(ctx.user, "rh", "manage") };
  }),

  /** Pedidos pendentes de UMA ficha (cartão "Entra com a Google como" da ficha). */
  forEmployee: protectedProcedure
    .input(z.object({ employeeId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh", "view");
      await assertEmployeeAccess(input.employeeId);
      const d = await database();
      const rows = rowsOf(await d.execute(sql`SELECT id, kind, googleEmail, claimedEmail, claimedPhone, matchedEmployeeId, employeeId, note, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i') AS createdAt
        FROM account_link_requests WHERE status = 'pending' AND (matchedEmployeeId = ${input.employeeId} OR employeeId = ${input.employeeId}) ORDER BY id DESC LIMIT 20`).catch(() => [[]]));
      return {
        canDecide: canAccess(ctx.user, "rh", "manage"),
        requests: rows.map((r) => ({ id: Number(r.id), kind: String(r.kind), summary: linkRequestSummary(r), note: r.note ?? null, createdAt: r.createdAt ?? null,
          otherEmployeeId: r.kind === "duplicate" ? (Number(r.employeeId) === input.employeeId ? (r.matchedEmployeeId == null ? null : Number(r.matchedEmployeeId)) : Number(r.employeeId)) : null })),
      };
    }),

  /**
   * O RH decide: "link" (liga a conta à ficha encontrada — ou à indicada —
   * com as regras das Ligações), "reject" (recusa / "não é a mesma pessoa")
   * ou "done" (possível duplicado já tratado, p.ex. fichas juntas).
   */
  decide: protectedProcedure
    .input(z.object({ requestId: z.number().int().positive(), action: z.enum(["link", "reject", "done"]), employeeId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh", "manage");
      const d = await database();
      const [r] = rowsOf(await d.execute(sql`SELECT * FROM account_link_requests WHERE id = ${input.requestId} LIMIT 1`));
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
      if (String(r.status) !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "Este pedido já foi tratado." });
      // Âmbito: a ficha do pedido tem de estar nas tuas cidades (sem ficha → quem gere todas).
      const scopeTarget = input.employeeId ?? (r.matchedEmployeeId == null ? null : Number(r.matchedEmployeeId)) ?? (r.employeeId == null ? null : Number(r.employeeId));
      if (scopeTarget != null) await assertEmployeeAccess(scopeTarget);
      else (await import("./rhGuards")).requireNationalRhManage(ctx.user);
      const { logActivity } = await import("./db");
      const close = async (status: "confirmed" | "rejected", matched?: number | null) => {
        await d.execute(sql`UPDATE account_link_requests SET status = ${status}, codeHash = NULL, codeExpiresAt = NULL, resolvedById = ${ctx.user.id}, resolvedAt = ${nowSql()}
          ${matched != null ? sql`, matchedEmployeeId = ${matched}` : sql``} WHERE id = ${input.requestId} AND status = 'pending'`);
      };
      const summary = linkRequestSummary(r);
      if (input.action === "reject") {
        await close("rejected");
        await logActivity({ userId: ctx.user.id, action: "account_link_reject", entity: "account_link_requests", entityId: input.requestId, details: `${summary} — recusado` });
        return { ok: true, employeeId: null };
      }
      if (input.action === "done") {
        if (String(r.kind) !== "duplicate") throw new TRPCError({ code: "BAD_REQUEST", message: "Usa Ligar ou Recusar." });
        await close("confirmed");
        await logActivity({ userId: ctx.user.id, action: "account_link_done", entity: "account_link_requests", entityId: input.requestId, details: `${summary} — tratado` });
        return { ok: true, employeeId: null };
      }
      if (String(r.kind) !== "link") throw new TRPCError({ code: "BAD_REQUEST", message: "Um possível duplicado não se liga aqui: junta as fichas em RH → Ligações → Juntar fichas (ou marca como tratado)." });
      const user = { id: Number(r.userId), email: r.googleEmail ?? null };
      const { linkClaimedAccount, linkFromApplication } = await import("./accountLink");
      let employeeId: number;
      try {
        if (input.employeeId ?? r.matchedEmployeeId) {
          employeeId = (await linkClaimedAccount(Number(input.employeeId ?? r.matchedEmployeeId), user, { actor: ctx.user, how: `pedido #${input.requestId}, decidido no RH` })).employeeId;
        } else if (r.matchedApplicationId) {
          // a ficha de candidato nasce sem cidade → quem gere todas as cidades
          (await import("./rhGuards")).requireNationalRhManage(ctx.user);
          employeeId = await linkFromApplication(Number(r.matchedApplicationId), user, { actor: ctx.user, how: `pedido #${input.requestId}, decidido no RH` });
        } else {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Este pedido não encontrou nenhuma ficha: escreve o n.º da ficha a ligar." });
        }
      } catch (err: any) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) });
      }
      await close("confirmed", employeeId);
      await logActivity({ userId: ctx.user.id, action: "account_link", entity: "account_link_requests", entityId: input.requestId, details: `${summary} — ligado à ficha #${employeeId}` });
      return { ok: true, employeeId };
    }),
});
