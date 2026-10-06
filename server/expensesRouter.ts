/**
 * Router `expenses` (Despesas) — saiu do routers.ts a 1 out 2026 (P2, só
 * mudança de sítio). Âmbito e regras: server/expenseScope.ts.
 */
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { projectScope, assertEmployeeAccess } from './cityScope';
import { z } from "zod";
import * as XLSX from "xlsx";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess, userIdsAtOrBelowInCity } from "./_core/access";
import { storagePut } from "./storage";
import { resolveExpenseVisibility, expenseConditions, whereAll, canSeeExpense, canSeeAggregates, type ExpenseListFilters, type ExpenseVisibility } from "./expenseScope";
import { parseExpenseAmount } from "../shared/expenseAmount";
import { dayToMysql, lisbonToday } from "../shared/expensePeriods";
import { validConsumptionPeriod } from "../shared/adInvoices";
import { expenseTotals } from "../shared/expenseTotals";
import { getAllCategories, listExpenses, summarizeExpenses, recordExpenseEvent, getExpenseEvents, findPossibleDuplicateExpense, projectExists, categoryExists, resolveProjectIds, getExpenseById, createExpense, updateExpense, softDeleteExpense, restoreExpense, getExpenseStats, getUpcomingPayments, getOverdueExpenses, markOverdueExpenses, logActivity, getEmployeeById, getEmployeeByUserId } from "./db";
import { requireRole, isPermissionDenied, requireFinanceTotals } from "./routerGuards";

// ─── DESPESAS: âmbito único (ver server/expenseScope.ts) ─────────────────────
async function expenseVisibilityFor(user: { id: number; role: string }): Promise<ExpenseVisibility> {
  return resolveExpenseVisibility(user, {
    denied: isPermissionDenied,
    employeeProjectId: async (uid) => {
      const emp = await getEmployeeByUserId(uid);
      return emp?.employee?.projectId ?? null;
    },
    resolveProjectIds,
    teamUserIds: userIdsAtOrBelowInCity,
  });
}

interface ExpenseListInput {
  deleted?: boolean;
  startDate?: string; endDate?: string; projectId?: number; categoryId?: number;
  userId?: number; status?: string; search?: string;
  /** 29b: só as que ainda não têm a fatura anexada */
  missingInvoice?: boolean;
}

/** Filtros do pedido + visibilidade do utilizador → WHERE (lista, Excel, totais). */
async function expenseWhereFor(user: { id: number; role: string }, input?: ExpenseListInput) {
  const vis = await expenseVisibilityFor(user);
  const filters: ExpenseListFilters = {
    startDate: input?.startDate || undefined,
    endDate: input?.endDate || undefined,
    categoryId: input?.categoryId || undefined,
    userId: input?.userId || undefined,
    status: input?.status || undefined,
    search: input?.search?.trim() || undefined,
    missingInvoice: input?.missingInvoice === true || undefined,
    // D4: as eliminadas só aparecem ao super admin, quando as pede.
    deleted: input?.deleted === true && user.role === "super_admin",
  };
  // Cidade inclui marcas e projetos descendentes; marca global (id negativo)
  // inclui essa marca em todas as cidades. Nunca "igualdade ao id".
  if (input?.projectId) filters.projectIds = await resolveProjectIds(input.projectId);
  try {
    return { vis, where: whereAll(expenseConditions(filters, vis)) };
  } catch (e: any) {
    throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
  }
}

const EXPENSE_LIST_INPUT = z.object({
  /** D4: só as eliminadas (super admin). */
  deleted: z.boolean().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  projectId: z.number().optional(),
  categoryId: z.number().optional(),
  userId: z.number().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  /** 29b: só as que ainda não têm a fatura anexada */
  missingInvoice: z.boolean().optional(),
}).optional();

/** 29f: período de consumo — os dois ou nenhum; de ≤ até; no máximo 1 ano. */
function consumptionPeriodOrBadRequest(from: string | null | undefined, to: string | null | undefined): { consumptionFrom: string | null; consumptionTo: string | null } {
  const f = cleanText(from) ?? null, t = cleanText(to) ?? null;
  if (!f && !t) return { consumptionFrom: null, consumptionTo: null };
  if (!validConsumptionPeriod(f, t)) throw new TRPCError({ code: "BAD_REQUEST", message: "Período de consumo inválido — indica o primeiro e o último dia (até 1 ano)." });
  return { consumptionFrom: f, consumptionTo: t };
}

/** Campos cuja alteração muda o valor financeiro (invalidam uma aprovação). */
/** O comprador de uma despesa tem de existir e ser das cidades de quem lança. */
async function assertExpenseBuyer(buyerId: number | null | undefined): Promise<void> {
  if (buyerId == null) return;
  if (!(await getEmployeeById(buyerId))) throw new TRPCError({ code: "BAD_REQUEST", message: "Comprador não encontrado." });
  await assertEmployeeAccess(buyerId);
}

const EXPENSE_FINANCIAL_FIELDS = ["amount", "currency", "expenseDate", "projectId", "categoryId", "supplier", "supplierNif", "documentNumber", "paidBy", "buyerId"] as const;

function cleanText(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === "" || t === "null" || t === "undefined" ? null : t;
}

/**
 * O comprovativo de uma despesa tem de ser um ficheiro carregado pelo próprio
 * (uploadInvoice grava em invoices/<userId>/…). Sem isto, quem conhecesse a
 * key de outro ficheiro obtinha uma URL assinada dele via documentUrl.
 */
function assertOwnInvoiceKey(userId: number, key: string | null | undefined, url: string | null | undefined) {
  if (!key && !url) return;
  if (!key || !key.startsWith(`invoices/${userId}/`) || key.includes("..")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Comprovativo inválido — volta a carregar o ficheiro" });
  }
}

function dayOrBadRequest(day: string, label: string): string {
  try { return dayToMysql(day); } catch { throw new TRPCError({ code: "BAD_REQUEST", message: `${label} inválida (usa AAAA-MM-DD)` }); }
}

export const expensesRouter = router({
  // Matriz do Jorge (2026-08-04) + plano de controlo financeiro (set 2026):
  // backoffice/team_leader inserem e acompanham as PRÓPRIAS; supervisor vê
  // as suas + o seu centro de custos (com descendentes); admin+ vê tudo,
  // salvo deny individual de totais. A MESMA regra vale para detalhe,
  // totais, comparação, Excel e documentos (expenseWhereFor/canSeeExpense).
  // O que o utilizador pode ver: o ecrã mostra totais/comparar/exportar só
  // quando o servidor os devolve (antes o cliente adivinhava pelo role).
  access: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
    const vis = await expenseVisibilityFor(ctx.user);
    return { scope: vis.kind, canSeeTotals: canSeeAggregates(vis) };
  }),

  list: protectedProcedure
    .input(EXPENSE_LIST_INPUT)
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
      const { vis, where } = await expenseWhereFor(ctx.user, input);
      if (vis.kind === "none") return [];
      return listExpenses(where);
    }),

  byId: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
      const row = await getExpenseById(input.id, { includeDeleted: ctx.user.role === "super_admin" });
      if (!row) return row;
      const vis = await expenseVisibilityFor(ctx.user);
      if (!canSeeExpense(vis, { insertedById: row.expense.insertedById, projectId: row.expense.projectId ?? null })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return row;
    }),

  // URL de leitura do comprovativo (assinada no S3, 10 min). O cliente já
  // não abre a URL pública gravada: pede aqui, e a permissão é a do detalhe.
  documentUrl: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
      const row = await getExpenseById(input.id, { includeDeleted: ctx.user.role === "super_admin" });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      const vis = await expenseVisibilityFor(ctx.user);
      if (!canSeeExpense(vis, { insertedById: row.expense.insertedById, projectId: row.expense.projectId ?? null })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const key = row.expense.invoiceImageKey;
      const url = row.expense.invoiceImageUrl;
      if (!key && !url) return { url: null as string | null, isPdf: false, signed: false, expiresIn: 0 };
      const { storagePresignGet } = await import("./storage");
      // A key é preferida (assinável no S3), mas as despesas anteriores ao S3
      // guardam a key crua da era Blob — que no S3 não existe. A URL vai como
      // fallback para esses ficheiros continuarem a abrir.
      const r = await storagePresignGet((key || url) as string, { fallbackUrl: url });
      const isPdf = /\.pdf(\?|$)/i.test(key || url || "");
      return { url: r.url || null, isPdf, signed: r.signed, expiresIn: r.expiresIn };
    }),

  // Histórico de alterações (quem, quando, antes/depois).
  events: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
      const row = await getExpenseById(input.id, { includeDeleted: ctx.user.role === "super_admin" });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      const vis = await expenseVisibilityFor(ctx.user);
      if (!canSeeExpense(vis, { insertedById: row.expense.insertedById, projectId: row.expense.projectId ?? null })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const evs = await getExpenseEvents(input.id);
      const parse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s); } catch { return s; } };
      return evs.map((e) => ({
        id: e.event.id, type: e.event.type, at: e.event.createdAt, note: e.event.note,
        user: e.user?.id ? { id: e.user.id, name: e.user.name } : null,
        before: parse(e.event.before), after: parse(e.event.after),
      }));
    }),

  // Possível duplicado ANTES de gravar: mesmo nº de documento do mesmo
  // fornecedor, ou o mesmo ficheiro. Não bloqueia — avisa.
  checkDuplicate: protectedProcedure
    .input(z.object({
      excludeId: z.number().optional(),
      supplier: z.string().optional(), supplierNif: z.string().optional(),
      documentNumber: z.string().optional(), invoiceImageKey: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "despesas", "edit", { allowOwn: true });
      const dup = await findPossibleDuplicateExpense(input);
      if (!dup) return null;
      const vis = await expenseVisibilityFor(ctx.user);
      // Quem não pode ver a despesa só fica a saber que já existe
      if (!canSeeExpense(vis, { insertedById: (dup as any).insertedById, projectId: (dup as any).projectId ?? null })) {
        return { id: 0, supplier: null, amount: null, expenseDate: null, documentNumber: dup.documentNumber, status: null };
      }
      return { id: dup.id, supplier: dup.supplier, amount: dup.amount, expenseDate: dup.expenseDate, documentNumber: dup.documentNumber, status: dup.status };
    }),

  create: protectedProcedure
    .input(
      z.object({
        supplier: z.string().optional(),
        description: z.string().optional(),
        amount: z.string(),
        currency: z.string().default("EUR"),
        paymentMethod: z.enum(["cash", "card", "transfer", "check", "other"]).optional(),
        expenseDate: z.string(),
        paymentDueDate: z.string().nullable().optional(),
        categoryId: z.number().optional(),
        // projectId obrigatório: cada despesa tem de ir para um centro
        // de custos (grupo / cidade / marca / projeto). O rollup
        // hierárquico do ProjectCostsDashboard agrega para cima.
        projectId: z.number(),
        buyerId: z.number().optional(),
        invoiceImageUrl: z.string().optional(),
        invoiceImageKey: z.string().optional(),
        extractedByAi: z.boolean().default(false),
        notes: z.string().optional(),
        supplierNif: z.string().optional(),
        documentNumber: z.string().optional(),
        paidBy: z.enum(["company", "employee"]).optional(),
        // 29f: período de consumo (faturas do Google/Meta) — substitui o gasto dos anúncios nesses dias
        consumptionFrom: z.string().nullable().optional(),
        consumptionTo: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Matriz do Jorge: input de despesas a partir de backoffice.
      requireAccess(ctx.user, "despesas", "edit", { allowOwn: true });
      assertOwnInvoiceKey(ctx.user.id, input.invoiceImageKey, input.invoiceImageUrl);
      const amountNorm = parseExpenseAmount(input.amount);
      if (!amountNorm) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Valor inválido — usa um número positivo com até 2 casas (ex.: 45,90)" });
      }
      const expenseDate = dayOrBadRequest(input.expenseDate, "Data da despesa");
      const due = cleanText(input.paymentDueDate);
      const paymentDueDate = due ? dayOrBadRequest(due, "Data de vencimento") : null;
      if (!(await projectExists(input.projectId))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Centro de custos inexistente" });
      }
      if (input.categoryId && !(await categoryExists(input.categoryId))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Categoria inexistente" });
      }
      await assertExpenseBuyer(input.buyerId);
      // Quem suportou: se há comprador (colaborador) e não foi dito, assume-se
      // que foi ele (dá origem a reembolso na fase de pagamentos).
      const paidBy = input.paidBy ?? (input.buyerId ? "employee" : "company");
      const created = await createExpense({
        supplier: cleanText(input.supplier) ?? null,
        description: cleanText(input.description) ?? null,
        amount: amountNorm,
        // Os totais somam tudo como EUR: não se aceita outra moeda
        currency: "EUR",
        paymentMethod: input.paymentMethod ?? null,
        expenseDate,
        paymentDueDate,
        categoryId: input.categoryId ?? null,
        projectId: input.projectId,
        buyerId: input.buyerId ?? null,
        insertedById: ctx.user.id,
        invoiceImageUrl: input.invoiceImageUrl ?? null,
        invoiceImageKey: input.invoiceImageKey ?? null,
        extractedByAi: input.extractedByAi ? 1 : 0,
        notes: cleanText(input.notes) ?? null,
        supplierNif: cleanText(input.supplierNif) ?? null,
        documentNumber: cleanText(input.documentNumber) ?? null,
        paidBy,
        status: "pending",
        approvalStatus: "legacy",
        ...consumptionPeriodOrBadRequest(input.consumptionFrom, input.consumptionTo),
      } as any);
      const newId = Number((created as any)?.[0]?.insertId ?? 0) || null;
      if (newId) {
        await recordExpenseEvent({
          expenseId: newId, type: "created", userId: ctx.user.id,
          after: { amount: amountNorm, expenseDate: input.expenseDate, projectId: input.projectId, categoryId: input.categoryId ?? null, supplier: cleanText(input.supplier) ?? null, documentNumber: cleanText(input.documentNumber) ?? null, extractedByAi: input.extractedByAi },
        });
      }

      await logActivity({
        userId: ctx.user.id,
        action: "create",
        entity: "expense",
        entityId: newId ?? undefined,
        details: `Despesa criada: ${input.supplier ?? "Sem fornecedor"} - ${amountNorm}€`,
      });

      // Aviso `expense_due` (supervisor da cidade da despesa + admin/super_admin).
      if (paymentDueDate) {
        const { notify } = await import("./notify");
        await notify({
          kind: "expense_due", projectId: input.projectId ?? null,
          title: "Nova despesa com data de pagamento",
          // Valor e dia como ficaram gravados (antes o texto cru do formulário, ex. "45,9")
          body: `Despesa de ${amountNorm}€ (${cleanText(input.supplier) ?? "Sem fornecedor"}) com vencimento em ${paymentDueDate.slice(0, 10).split("-").reverse().join("/")}.`,
          link: "/despesas", entity: newId ? { type: "expense", id: newId } : null,
        });
      }

      return { success: true, id: newId };
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        // Campos opcionais aceitam null = "limpar" (antes não dava para
        // apagar um vencimento ou uma categoria ao editar).
        supplier: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        amount: z.string().optional(),
        paymentMethod: z.enum(["cash", "card", "transfer", "check", "other"]).optional(),
        expenseDate: z.string().optional(),
        paymentDueDate: z.string().nullable().optional(),
        categoryId: z.number().nullable().optional(),
        projectId: z.number().optional(),
        buyerId: z.number().nullable().optional(),
        status: z.enum(["pending", "paid", "overdue", "cancelled"]).optional(),
        paidAt: z.string().nullable().optional(),        // AAAA-MM-DD
        notes: z.string().nullable().optional(),
        invoiceImageUrl: z.string().nullable().optional(),
        invoiceImageKey: z.string().nullable().optional(),
        supplierNif: z.string().nullable().optional(),
        documentNumber: z.string().nullable().optional(),
        paidBy: z.enum(["company", "employee"]).nullable().optional(),
        // 29f: período de consumo (faturas do Google/Meta); null = limpar
        consumptionFrom: z.string().nullable().optional(),
        consumptionTo: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Matriz do Jorge: editar despesas (valores, datas, estados) é
      // admin+; DESMARCAR um pagamento (paid → outro estado) é só
      // super_admin.
      requireAccess(ctx.user, "despesas", "manage");
      const current = await getExpenseById(input.id);
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Despesa não encontrada" });
      const cur = current.expense;
      const { id } = input;

      if (input.status && input.status !== "paid" && cur.status === "paid" && ctx.user.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin pode retirar um pagamento já registado" });
      }

      const patch: Record<string, any> = {};
      for (const k of ["supplier", "description", "notes", "supplierNif", "documentNumber"] as const) {
        const v = cleanText(input[k]);
        if (v !== undefined) patch[k] = v;
      }
      if (input.paymentMethod !== undefined) patch.paymentMethod = input.paymentMethod;
      if (input.consumptionFrom !== undefined || input.consumptionTo !== undefined) Object.assign(patch, consumptionPeriodOrBadRequest(input.consumptionFrom, input.consumptionTo));
      if (input.buyerId !== undefined) { await assertExpenseBuyer(input.buyerId); patch.buyerId = input.buyerId; }
      if (input.paidBy !== undefined) patch.paidBy = input.paidBy;
      if (input.categoryId !== undefined) {
        if (input.categoryId != null && !(await categoryExists(input.categoryId))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Categoria inexistente" });
        }
        patch.categoryId = input.categoryId;
      }
      if (input.projectId !== undefined) {
        if (!(await projectExists(input.projectId))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Centro de custos inexistente" });
        }
        patch.projectId = input.projectId;
      }
      if (input.expenseDate !== undefined) patch.expenseDate = dayOrBadRequest(input.expenseDate, "Data da despesa");
      if (input.paymentDueDate !== undefined) {
        const due = cleanText(input.paymentDueDate);
        patch.paymentDueDate = due ? dayOrBadRequest(due, "Data de vencimento") : null;
      }
      if (input.amount !== undefined) {
        const a = parseExpenseAmount(input.amount);
        if (!a) throw new TRPCError({ code: "BAD_REQUEST", message: "Valor inválido — usa um número positivo com até 2 casas (ex.: 45,90)" });
        patch.amount = a;
      }

      // Data de pagamento: PRESERVADA. Só se define quando a despesa PASSA a
      // paga (ou quando é indicada explicitamente); editar a descrição de
      // uma despesa já paga não mexe em paidAt (bug anterior: "agora" sempre).
      const explicitPaidAt = input.paidAt === undefined ? undefined : (cleanText(input.paidAt) ? dayOrBadRequest(cleanText(input.paidAt)!, "Data de pagamento") : null);
      if (input.status !== undefined) {
        patch.status = input.status;
        if (input.status === "paid") {
          if (cur.status !== "paid") patch.paidAt = explicitPaidAt ?? dayToMysql(lisbonToday());
          else if (explicitPaidAt) patch.paidAt = explicitPaidAt;
        } else {
          patch.paidAt = null;
        }
      } else if (explicitPaidAt && cur.status === "paid") {
        patch.paidAt = explicitPaidAt;
      }
      // Em atraso com o vencimento adiado para hoje ou depois → volta a pendente
      if (input.status === undefined && cur.status === "overdue" && typeof patch.paymentDueDate === "string" && patch.paymentDueDate >= dayToMysql(lisbonToday())) {
        patch.status = "pending";
      }

      // Documento: grava primeiro, apaga o antigo DEPOIS (se o UPDATE falhar
      // o original continua acessível).
      let oldDocToDelete: string | null = null;
      if (input.invoiceImageKey !== undefined || input.invoiceImageUrl !== undefined) {
        const sameDoc = (input.invoiceImageKey ?? null) === (cur.invoiceImageKey ?? null) && (input.invoiceImageUrl ?? null) === (cur.invoiceImageUrl ?? null);
        if (!sameDoc) assertOwnInvoiceKey(ctx.user.id, input.invoiceImageKey, input.invoiceImageUrl);
        const newKey = input.invoiceImageKey ?? null;
        const newUrl = input.invoiceImageUrl ?? null;
        patch.invoiceImageKey = newKey;
        patch.invoiceImageUrl = newUrl;
        const oldRef = cur.invoiceImageKey || cur.invoiceImageUrl || null;
        const newRef = newKey || newUrl || null;
        if (oldRef && oldRef !== newRef) oldDocToDelete = oldRef;
      }

      // Alteração financeira depois de aprovada → volta a "submetida"
      // (regra do circuito; hoje tudo é 'legacy' e isto não dispara).
      const changed: Record<string, { before: unknown; after: unknown }> = {};
      for (const [k, v] of Object.entries(patch)) {
        const before = (cur as any)[k] ?? null;
        const after = v ?? null;
        if (String(before) !== String(after)) changed[k] = { before, after };
      }
      const financialChange = EXPENSE_FINANCIAL_FIELDS.some((f) => f in changed);
      if (financialChange && cur.approvalStatus === "approved") {
        patch.approvalStatus = "submitted";
        patch.approvedAt = null;
        patch.approvedById = null;
      }

      if (Object.keys(changed).length === 0) return { success: true, changed: 0 };

      await updateExpense(id, patch);

      if (oldDocToDelete) {
        try {
          const { storageDelete } = await import("./storage");
          await storageDelete(oldDocToDelete);
        } catch { /* best-effort: órfão no storage é preferível a link morto */ }
      }

      const type = "status" in changed ? (patch.status === "paid" ? "paid" : "status") : oldDocToDelete || "invoiceImageKey" in changed ? "document" : "updated";
      await recordExpenseEvent({
        expenseId: id, type, userId: ctx.user.id,
        before: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.before])),
        after: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.after])),
        note: financialChange && cur.approvalStatus === "approved" ? "Alteração financeira: aprovação anulada" : null,
      });
      await logActivity({
        userId: ctx.user.id,
        action: "update",
        entity: "expense",
        entityId: id,
        details: `Despesa #${id} atualizada (${Object.keys(changed).join(", ")})`,
      });
      return { success: true, changed: Object.keys(changed).length };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      // Matriz do Jorge: eliminar é SÓ super_admin.
      requireRole(ctx.user.role, "super_admin");
      // D4 (Jorge, 3 out 2026): desaparece como se fosse apagada — sai das
      // listas, totais e da Faturação — mas fica guardada com a fatura (o
      // super admin vê-a em "Eliminadas" e pode repor). Nunca DELETE.
      const current = await getExpenseById(input.id);
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Despesa não encontrada" });
      try {
        await recordExpenseEvent({
          expenseId: input.id, type: "deleted", userId: ctx.user.id,
          before: { amount: current.expense.amount, supplier: current.expense.supplier, expenseDate: current.expense.expenseDate, status: current.expense.status },
        });
      } catch { /* best-effort */ }
      await softDeleteExpense(input.id, ctx.user.id);
      await logActivity({
        userId: ctx.user.id,
        action: "delete",
        entity: "expense",
        entityId: input.id,
        details: `Despesa #${input.id} eliminada (fica guardada; o super admin pode repor)`,
      });
      return { success: true };
    }),

  /** D4: repor uma despesa eliminada (super admin). */
  restore: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "super_admin");
      const current = await getExpenseById(input.id, { includeDeleted: true });
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Despesa não encontrada" });
      await restoreExpense(input.id);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "expense", entityId: input.id, details: `Despesa #${input.id} reposta (estava eliminada)` });
      return { success: true };
    }),

  // ── UPLOAD INVOICE ───────────────────────────────────────────────────────
  uploadInvoice: protectedProcedure
    .input(
      z.object({
        fileName: z.string(),
        fileBase64: z.string(),
        mimeType: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "despesas", "edit", { allowOwn: true });
      const buffer = Buffer.from(input.fileBase64, "base64");
      const suffix = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const safeName = input.fileName.replace(/[^\w.\-]+/g, "_").slice(0, 120);
      const key = `invoices/${ctx.user.id}/${suffix}-${safeName}`;
      const { url } = await storagePut(key, buffer, input.mimeType);
      return { url, key };
    }),

  // ── EXTRACT WITH LLM ─────────────────────────────────────────────────────
  extractFromImage: protectedProcedure
    .input(z.object({ imageBase64: z.string(), mimeType: z.string().default("image/jpeg") }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "despesas", "edit", { allowOwn: true });
      // Lista de categorias para a IA sugerir uma (mapeada por nome no cliente).
      let categoryNames: string[] = [];
      try {
        const cats = await getAllCategories();
        categoryNames = (cats as any[]).map((c) => c.name).filter(Boolean);
      } catch { /* opcional */ }

      const { extractInvoice } = await import("./expenseOcr");
      const { aiTrpcError } = await import("./_core/ai/trpcError");
      try {
        return await extractInvoice({ base64: input.imageBase64, mimeType: input.mimeType, categoryNames, userId: ctx.user.id });
      } catch (err) {
        throw aiTrpcError(err);
      }
    }),

  // ── DASHBOARD STATS ──────────────────────────────────────────────────────
  stats: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    // Totais da empresa inteira — só admin+ (matriz do Jorge), e respeita o
    // deny de finance.view_totals por utilizador. Com o filtro do painel.
    await requireFinanceTotals(ctx.user, "financeiro", "view");
    return getExpenseStats({ projectId: input?.projectId });
  }),

  // ── UPCOMING PAYMENTS ────────────────────────────────────────────────────
  upcomingPayments: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    // Pagamentos de TODOS: respeita a restrição finance.view_totals (e o filtro do painel)
    await requireFinanceTotals(ctx.user, "financeiro", "view");
    return getUpcomingPayments(7, { projectId: input?.projectId });
  }),

  // ── EXPORT EXCEL ─────────────────────────────────────────────────────────
  exportExcel: protectedProcedure
    .input(EXPENSE_LIST_INPUT)
    .mutation(async ({ ctx, input }) => {
      // MESMOS filtros e MESMA visibilidade da lista (antes: sem requireRole,
      // fim do intervalo às 00:00 — perdia o último dia — e supervisor
      // exportava a empresa toda).
      requireAccess(ctx.user, "despesas", "export");
      const { vis, where } = await expenseWhereFor(ctx.user, input);
      if (!canSeeAggregates(vis)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para exportar totais financeiros." });
      }
      const rows = await listExpenses(where);
      const totals = expenseTotals(rows.map((r) => ({ amount: r.expense.amount, status: r.expense.status })));

      const STATUS_MAP: Record<string, string> = {
        pending: "Pendente",
        paid: "Pago",
        overdue: "Em Atraso",
        cancelled: "Cancelado",
      };
      const METHOD_MAP: Record<string, string> = {
        cash: "Numerário",
        card: "Cartão",
        transfer: "Transferência",
        check: "Cheque",
        other: "Outro",
      };

      const day = (s: string | null | undefined) => (s ? String(s).slice(0, 10).split("-").reverse().join("/") : "");
      const data = rows.map((r) => ({
        "ID": r.expense.id,
        "Data": day(r.expense.expenseDate),
        "Fornecedor": r.expense.supplier ?? "",
        "NIF": r.expense.supplierNif ?? "",
        "Nº Documento": r.expense.documentNumber ?? "",
        "Descrição": r.expense.description ?? "",
        "Valor (€)": parseFloat(String(r.expense.amount ?? 0)),
        "Moeda": r.expense.currency ?? "EUR",
        "Método Pagamento": METHOD_MAP[r.expense.paymentMethod ?? ""] ?? r.expense.paymentMethod ?? "",
        "Pago por": r.expense.paidBy === "employee" ? "Colaborador" : r.expense.paidBy === "company" ? "Empresa" : "",
        "Estado": STATUS_MAP[r.expense.status ?? ""] ?? r.expense.status ?? "",
        "Categoria": r.category?.name ?? "",
        "Departamento": r.category?.department ?? "",
        "Centro de custos": r.project?.name ?? "",
        "Comprador": r.buyer?.fullName ?? "",
        "Registado por": r.insertedBy?.name ?? "",
        "Data Vencimento": day(r.expense.paymentDueDate),
        "Data Pagamento": day(r.expense.paidAt),
        "Comprovativo": r.expense.invoiceImageKey || r.expense.invoiceImageUrl ? "Sim" : "Não",
        "Extraído por IA": r.expense.extractedByAi ? "Sim" : "Não",
        "Notas": r.expense.notes ?? "",
      }));

      const ws = XLSX.utils.json_to_sheet(data);

      // Auto-width columns
      const colWidths = Object.keys(data[0] ?? {}).map((key) => ({
        wch: Math.max(key.length, ...data.map((r) => String((r as any)[key] ?? "").length)) + 2,
      }));
      ws["!cols"] = colWidths;

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Despesas");

      // Resumo: mesma regra dos KPIs (canceladas fora do total, listadas à parte)
      const summaryData = [
        { "Resumo": "Total de Registos (sem canceladas)", "Valor": totals.count },
        { "Resumo": "Total (€) sem canceladas", "Valor": totals.total },
        { "Resumo": "Pendente (€)", "Valor": totals.pending },
        { "Resumo": "Pago (€)", "Valor": totals.paid },
        { "Resumo": "Em atraso (€)", "Valor": totals.overdue },
        { "Resumo": "Canceladas", "Valor": `${totals.cancelledCount} (${totals.cancelled.toFixed(2)} €)` },
        { "Resumo": "Período", "Valor": `${input?.startDate ?? "início"} a ${input?.endDate ?? "hoje"}` },
        { "Resumo": "Exportado em", "Valor": new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" }) },
        { "Resumo": "Exportado por", "Valor": ctx.user.name ?? ctx.user.email ?? "" },
      ];
      const wsSummary = XLSX.utils.json_to_sheet(summaryData);
      wsSummary["!cols"] = [{ wch: 20 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, wsSummary, "Resumo");

      // 29b: para a contabilista — as que ainda não têm a fatura (canceladas fora)
      const missing = data.filter((r, i) => r["Comprovativo"] === "Não" && rows[i].expense.status !== "cancelled")
        .map((r) => ({ "ID": r["ID"], "Data": r["Data"], "Fornecedor": r["Fornecedor"], "Descrição": r["Descrição"], "Valor (€)": r["Valor (€)"], "Centro de custos": r["Centro de custos"] }));
      if (missing.length) {
        const wsMissing = XLSX.utils.json_to_sheet(missing);
        XLSX.utils.book_append_sheet(wb, wsMissing, "Sem fatura");
      }

      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      const base64 = Buffer.from(buffer).toString("base64");

      // Dia de Lisboa (o toISOString dava o dia anterior entre a meia-noite e a 1h no verão)
      return { base64, filename: `despesas-${lisbonToday()}.xlsx`, count: data.length };
    }),

  // ── CHECK OVERDUE ────────────────────────────────────────────────────────
  checkOverdue: protectedProcedure.mutation(async ({ ctx }) => {
    requireRole(ctx.user.role, "super_admin");
    // A lista tem de ser lida ANTES do mark (getOverdueExpenses procura
    // status='pending' — depois do mark já estão 'overdue' e devolvia
    // sempre 0, pelo que o alerta nunca era enviado).
    const overdue = await getOverdueExpenses();
    await markOverdueExpenses();

    if (overdue.length > 0) {
      // Um aviso por projeto (cidade) da despesa — `expense_overdue`.
      const { notify } = await import("./notify");
      const byProject = new Map<string, typeof overdue>();
      for (const o of overdue) {
        const k = String((o.expense as any).projectId ?? "-");
        byProject.set(k, [...(byProject.get(k) ?? []), o]);
      }
      for (const list of Array.from(byProject.values())) {
        await notify({
          kind: "expense_overdue", projectId: (list[0].expense as any).projectId ?? null,
          title: `${list.length} despesa(s) em atraso`,
          body: list
            .map(
              (o) =>
                `• ${o.expense.supplier ?? "Sem fornecedor"}: ${o.expense.amount}€ (venceu em ${o.expense.paymentDueDate ? new Date(o.expense.paymentDueDate).toLocaleDateString("pt-PT") : "—"})`
            )
            .join("\n"),
          link: "/despesas",
        });
      }
    }

    return { updated: overdue.length };
  }),

  // Resumo de despesas de um período (comparar períodos). Mesmos filtros e
  // visibilidade da lista (antes: qualquer frontoffice via os totais da
  // empresa e o centro de custos não incluía descendentes).
  summary: protectedProcedure
    .input(z.object({ from: z.string(), to: z.string(), projectId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
      const { vis, where } = await expenseWhereFor(ctx.user, { startDate: input.from, endDate: input.to, projectId: input.projectId });
      if (!canSeeAggregates(vis)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para ver totais financeiros." });
      }
      return summarizeExpenses(where);
    }),

  // 29f: anúncios (Google Ads / Meta) do período, por projeto — o que entra como despesa de
  // marketing na Faturação: gasto das plataformas até chegar a fatura; no período de consumo, a fatura.
  adCosts: protectedProcedure.input(z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), projectId: z.number().optional() })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "despesas", "view", { allowOwn: true });
    const { vis } = await expenseWhereFor(ctx.user, input);
    if (!canSeeAggregates(vis)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para ver totais financeiros." });
    if (input.startDate > input.endDate) throw new TRPCError({ code: "BAD_REQUEST", message: "Período inválido" });
    const { getDb, getProjects } = await import("./db");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível" });
    const projectIds = input.projectId ? await resolveProjectIds(input.projectId) : null;
    const { loadAdCosts } = await import("./finance/adCosts");
    const ad = await loadAdCosts(db, { from: input.startDate, to: input.endDate, projectIds });
    const names = new Map(((await getProjects()) as any[]).map((p) => [p.id, p]));
    const label = (id: number | null) => {
      if (id == null) return "Por atribuir";
      const p: any = names.get(id); if (!p) return `#${id}`;
      const parent: any = p.parentId != null ? names.get(p.parentId) : null;
      return p.level === "brand" && parent ? `${p.name} ${parent.name}` : p.name;
    };
    const by = new Map<string, { projectId: number | null; label: string; provider: string; platform: number; invoice: number }>();
    for (const r of ad.rows) {
      const k = `${r.projectId ?? ""}|${r.provider}`;
      const e = by.get(k) ?? { projectId: r.projectId, label: label(r.projectId), provider: r.provider, platform: 0, invoice: 0 };
      if (r.source === "fatura") e.invoice += r.cost; else e.platform += r.cost;
      by.set(k, e);
    }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      totals: { platform: r2(ad.totals.platform), invoice: r2(ad.totals.invoice) },
      rows: [...by.values()].map((x) => ({ ...x, platform: r2(x.platform), invoice: r2(x.invoice) })).sort((a, b) => (b.platform + b.invoice) - (a.platform + a.invoice)),
      invoicesWithoutPeriod: ad.invoicesWithoutPeriod,
    };
  }),

  // 29b: faturas em falta no mês (Lisboa) — o aviso "Falta a fatura" no topo da lista
  missingInvoiceSummary: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "despesas", "manage");
    const month = lisbonToday().slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const range = { startDate: `${month}-01`, endDate: `${month}-${String(last).padStart(2, "0")}` };
    const { where } = await expenseWhereFor(ctx.user, { ...range, projectId: input?.projectId, missingInvoice: true });
    const { countMissingInvoices } = await import("./expenseRecurringStatus");
    return { month, ...range, ...(await countMissingInvoices(where)) };
  }),

  // ── Despesas recorrentes (modelos) ──
  recurring: router({
    list: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx }) => {
      // Fornecedores e valores fixos: só quem gere as despesas
      requireAccess(ctx.user, "despesas", "manage");
      const { getDb } = await import("./db");
      const { recurringExpenses } = await import("../drizzle/schema");
      const { desc } = await import("drizzle-orm");
      const db = await getDb(); if (!db) return [];
      const { and: andOp, isNull: isNullOp } = await import("drizzle-orm");
      // D4: os removidos ficam guardados mas saem da lista.
      const models = await db.select().from(recurringExpenses).where(andOp(projectScope(recurringExpenses.projectId), isNullOp(recurringExpenses.removedAt))).orderBy(desc(recurringExpenses.active));
      // 29b: o estado deste mês de cada modelo (lançada? com fatura?) e o dia em que lança
      const { recurringMonthStatus } = await import("./expenseRecurringStatus");
      return recurringMonthStatus(models as any[]);
    }),
    create: protectedProcedure
      .input(z.object({ description: z.string().optional(), supplier: z.string().optional(), amount: z.number(), paymentMethod: z.enum(["cash", "card", "transfer", "check", "other"]).optional(), categoryId: z.number().optional(), projectId: z.number(), dayOfMonth: z.number().min(1).max(28).optional(), notes: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "manage");
        // Mesmas regras de uma despesa normal: valor positivo com 2 casas e centro de custos existente
        const amountNorm = parseExpenseAmount(String(input.amount));
        if (!amountNorm) throw new TRPCError({ code: "BAD_REQUEST", message: "Valor inválido — usa um número positivo com até 2 casas" });
        if (!(await projectExists(input.projectId))) throw new TRPCError({ code: "BAD_REQUEST", message: "Centro de custos inexistente" });
        const { getDb } = await import("./db");
        const { recurringExpenses } = await import("../drizzle/schema");
        const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
        const res: any = await db.insert(recurringExpenses).values({ description: input.description ?? null, supplier: input.supplier ?? null, amount: amountNorm, paymentMethod: input.paymentMethod ?? "transfer", categoryId: input.categoryId ?? null, projectId: input.projectId, dayOfMonth: input.dayOfMonth ?? 1, notes: input.notes ?? null, createdById: ctx.user.id } as any);
        const newId = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0) || null;
        await logActivity({ userId: ctx.user.id, action: "create", entity: "recurring_expense", entityId: newId ?? undefined, details: `Despesa fixa criada: ${input.description || input.supplier || "—"} · ${amountNorm} € · dia ${input.dayOfMonth ?? 1}` });
        // 29b: se o dia deste mês já passou, a despesa deste mês lança já (não espera pelo mês que vem)
        const { launchThisMonthNow } = await import("./expenseRecurring");
        const launched = newId ? await launchThisMonthNow(newId, ctx.user.id) : 0;
        return { success: true, id: newId, launched: launched > 0 };
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), description: z.string().optional(), supplier: z.string().optional(), amount: z.number().optional(), paymentMethod: z.enum(["cash", "card", "transfer", "check", "other"]).optional(), categoryId: z.number().nullable().optional(), projectId: z.number().optional(), dayOfMonth: z.number().min(1).max(28).optional(), active: z.boolean().optional(), notes: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "manage");
        const { getDb } = await import("./db");
        const { recurringExpenses } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
        const { id, amount, active, ...rest } = input;
        const patch: any = { ...rest };
        if (amount !== undefined) {
          const a = parseExpenseAmount(String(amount));
          if (!a) throw new TRPCError({ code: "BAD_REQUEST", message: "Valor inválido — usa um número positivo com até 2 casas" });
          patch.amount = a;
        }
        if (rest.projectId !== undefined && !(await projectExists(rest.projectId))) throw new TRPCError({ code: "BAD_REQUEST", message: "Centro de custos inexistente" });
        if (active !== undefined) patch.active = active ? 1 : 0;
        await db.update(recurringExpenses).set(patch).where(eq(recurringExpenses.id, id));
        await logActivity({ userId: ctx.user.id, action: "update", entity: "recurring_expense", entityId: id, details: `Despesa fixa #${id} alterada: ${Object.keys(patch).join(", ")}` });
        // 29b: reativado ou com outro dia → se o dia deste mês já passou e ainda não foi lançada, lança já
        let launched = 0;
        if (active === true || rest.dayOfMonth !== undefined) {
          const { launchThisMonthNow } = await import("./expenseRecurring");
          launched = await launchThisMonthNow(id, ctx.user.id);
        }
        return { success: true, launched: launched > 0 };
      }),
    remove: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "despesas", "manage");
      const { getDb } = await import("./db");
      const { recurringExpenses } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      // D4 (Jorge, 3 out 2026): remover = desativar e sair da lista. Fica guardado
      // e as despesas já lançadas continuam ligadas ao modelo. Nunca DELETE.
      await db.update(recurringExpenses).set({ active: 0, removedAt: sql`CURRENT_TIMESTAMP`, removedById: ctx.user.id } as any).where(eq(recurringExpenses.id, input.id));
      await logActivity({ userId: ctx.user.id, action: "update", entity: "recurring_expense", entityId: input.id, details: `Modelo recorrente #${input.id} removido (desativado; fica guardado)` });
      return { success: true };
    }),
    // Lança as despesas dos modelos ativos para o mês. Idempotente e seguro
    // em concorrência (lock + UNIQUE modelo/mês — server/expenseRecurring.ts).
    // Corre no cron diário; aqui é só o disparo manual pelo admin.
    generateMonth: protectedProcedure
      .input(z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), projectId: z.number().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "despesas", "manage");
        const { generateRecurringExpensesForMonth } = await import("./expenseRecurring");
        const r = await generateRecurringExpensesForMonth(input.year, input.month, ctx.user.id);
        return { created: r.created, skipped: r.skipped, period: r.period };
      }),
  }),
});
