/**
 * P3 lote 29d — Despesas do turno (Jorge, 6 out 2026: "na passagem de turno
 * pode-se colocar despesas do turno e elas entram diretamente para a caixa e
 * para as despesas"). O team leader lança cada despesa paga com o dinheiro da
 * caixa (descrição, valor, foto do talão):
 *   - entra nas DESPESAS como paga, em dinheiro, no centro de custos da cidade,
 *     com o talão como fatura — `expenses.cashSource` = "shift:<dia>:<turno>:<cidade>";
 *   - abate ao dinheiro que tem de estar na caixa do dia (Financeiro → Caixa →
 *     Por dia).
 * Nunca se apaga: "Anular" passa a despesa a cancelada (fica no histórico).
 *
 * 12 out 2026 (Jorge: "o team leader envia as despesas por aqui e não pelo
 * Financeiro, com as mesmas funcionalidades: tirar fotografia e a IA ler o
 * talão"): a foto do talão é lida pela MESMA IA das Despesas (`extractInvoice`,
 * funcionalidade `expense_ocr`) e a despesa leva também fornecedor, NIF, n.º do
 * documento, data do talão, categoria (e o IVA nas notas). Tudo opcional: só
 * descrição + valor continua a funcionar como antes.
 */
import { and, eq, isNull, like, ne } from "drizzle-orm";
import { expenses } from "../drizzle/schema";
import { categoryExists, findPossibleDuplicateExpense, getAllCategories, getDb, getProjects, logActivity, recordExpenseEvent } from "./db";
import { matchCityKey } from "../shared/city";
import { can } from "../shared/access";
import { isIsoDay } from "../shared/expensePeriods";
import { normalizeSupplierNif } from "../shared/supplierNif";
import { eurText, shiftReceiptDateProblem, shiftReceiptVatProblem } from "../shared/shiftReceipt";
import { matchKey } from "../shared/textKey";
import { withOverrides } from "./_core/access";
import { canSeeExpense } from "./expenseScope";
import type { InvoiceData } from "./expenseOcr";

export type HandoverCity = "lisbon" | "porto" | "faro";
export type HandoverShift = "morning" | "night";

const CITY_KEY: Record<HandoverCity, "lisboa" | "porto" | "faro"> = { lisbon: "lisboa", porto: "porto", faro: "faro" };
export const SHIFT_LABEL: Record<HandoverShift, string> = { morning: "manhã", night: "noite" };

/** Marca da despesa do turno. PURA. */
export function shiftCashSource(day: string, shift: HandoverShift, city: HandoverCity): string {
  return `shift:${day}:${shift}:${city}`;
}

/** "shift:2026-10-06:night:lisbon" → partes (null se não for do turno). PURA. */
export function parseShiftCashSource(src: string | null | undefined): { day: string; shift: HandoverShift; city: HandoverCity } | null {
  const m = /^shift:(\d{4}-\d{2}-\d{2}):(morning|night):(lisbon|porto|faro)$/.exec(String(src ?? ""));
  return m ? { day: m[1], shift: m[2] as HandoverShift, city: m[3] as HandoverCity } : null;
}

/** O talão tem de ser um ficheiro carregado pelo próprio (expenses.uploadInvoice → invoices/<userId>/…). PURA. */
export function isOwnInvoiceKey(userId: number, key: string | null | undefined): boolean {
  if (!key) return true;
  return key.startsWith(`invoices/${userId}/`) && !key.includes("..");
}

/** Centro de custos da cidade (nó "city" com o nome da cidade). */
export async function cityProjectId(city: HandoverCity): Promise<number | null> {
  const all = (await getProjects()) as Array<{ id: number; name: string; level?: string | null }>;
  const hit = all.find((p) => p.level === "city" && matchCityKey(p.name) === CITY_KEY[city]);
  return hit ? Number(hit.id) : null;
}

export interface ShiftExpense {
  id: number; day: string; shift: HandoverShift; city: HandoverCity;
  description: string; supplier: string | null; amount: number; status: string; hasReceipt: boolean;
  insertedById: number | null; projectId: number | null; createdAt: string | null;
}

const toRow = (r: any): ShiftExpense | null => {
  const k = parseShiftCashSource(r.cashSource);
  if (!k) return null;
  return {
    id: Number(r.id), ...k, description: String(r.description ?? r.supplier ?? ""), supplier: r.supplier ? String(r.supplier) : null, amount: Number(r.amount ?? 0), status: String(r.status ?? ""),
    hasReceipt: !!(r.invoiceImageKey || r.invoiceImageUrl), insertedById: r.insertedById == null ? null : Number(r.insertedById),
    projectId: r.projectId == null ? null : Number(r.projectId), createdAt: r.createdAt ? String(r.createdAt) : null,
  };
};

/** Despesas do turno de um dia e cidade (todos os turnos se `shift` omisso), sem eliminadas. */
export async function listShiftExpenses(o: { day: string; city: HandoverCity; shift?: HandoverShift; includeCancelled?: boolean }): Promise<ShiftExpense[]> {
  const db = await getDb();
  if (!db) return [];
  const prefix = o.shift ? shiftCashSource(o.day, o.shift, o.city) : `shift:${o.day}:%:${o.city}`;
  const conds = [o.shift ? eq(expenses.cashSource, prefix) : like(expenses.cashSource, prefix), isNull(expenses.deletedAt)];
  if (!o.includeCancelled) conds.push(ne(expenses.status, "cancelled"));
  const rows = await db.select({
    id: expenses.id, cashSource: expenses.cashSource, description: expenses.description, supplier: expenses.supplier, amount: expenses.amount,
    status: expenses.status, invoiceImageKey: expenses.invoiceImageKey, invoiceImageUrl: expenses.invoiceImageUrl,
    insertedById: expenses.insertedById, projectId: expenses.projectId, createdAt: expenses.createdAt,
  }).from(expenses).where(and(...conds)).orderBy(expenses.id);
  return (rows as any[]).map(toRow).filter((x): x is ShiftExpense => !!x);
}

/** Soma (não canceladas) das despesas do turno. PURA. */
export const shiftExpensesTotal = (rows: readonly Pick<ShiftExpense, "amount" | "status">[]): number =>
  Math.round(rows.filter((r) => r.status !== "cancelled").reduce((s, r) => s + r.amount, 0) * 100) / 100;

/** Dados do talão (todos opcionais) que o cartão manda — escritos à mão ou lidos pela IA. */
export interface ShiftExpenseExtrasInput {
  supplier?: string | null; supplierNif?: string | null; documentNumber?: string | null;
  /** Data do talão (AAAA-MM-DD); vazia = o dia do turno. */
  invoiceDate?: string | null;
  vatAmount?: number | null; categoryId?: number | null; extractedByAi?: boolean;
}
export interface ShiftExpenseExtras {
  supplier: string | null; supplierNif: string | null; documentNumber: string | null;
  /** Dia da despesa nas Despesas (a data do talão, ou o dia do turno). */
  expenseDay: string;
  vatAmount: number | null; categoryId: number | null; extractedByAi: boolean;
}

const cleanText = (v: string | null | undefined, max: number): string | null => {
  const t = String(v ?? "").trim();
  return t && t !== "null" && t !== "undefined" ? t.slice(0, max) : null;
};

/** Dados do talão → o que se grava, ou a mensagem do primeiro problema. PURA. */
export function shiftExpenseExtras(day: string, amount: number, x: ShiftExpenseExtrasInput = {}): { ok: true; value: ShiftExpenseExtras } | { ok: false; message: string } {
  const nif = normalizeSupplierNif(x.supplierNif);
  if (!nif.ok) return nif;
  const dateProblem = shiftReceiptDateProblem(x.invoiceDate, day);
  if (dateProblem) return { ok: false, message: dateProblem };
  const vat = x.vatAmount == null ? null : Math.round(x.vatAmount * 100) / 100;
  const vatProblem = shiftReceiptVatProblem(vat, amount);
  if (vatProblem) return { ok: false, message: vatProblem };
  const invoiceDay = String(x.invoiceDate ?? "").trim();
  return {
    ok: true,
    value: {
      supplier: cleanText(x.supplier, 256), supplierNif: nif.nif, documentNumber: cleanText(x.documentNumber, 64),
      expenseDay: invoiceDay || day, vatAmount: vat, categoryId: x.categoryId ?? null, extractedByAi: x.extractedByAi === true,
    },
  };
}

/** Notas da despesa do turno (o IVA do talão vai aqui: nas Finanças o IVA vem da taxa da categoria). PURA. */
export function shiftExpenseNotes(shift: HandoverShift, vatAmount: number | null): string {
  const base = `Despesa do turno (${SHIFT_LABEL[shift]}) — Passagem de turno, paga com o dinheiro da caixa`;
  return vatAmount == null ? base : `${base} · IVA no talão: ${eurText(vatAmount)}`;
}

/** Lança a despesa do turno nas Despesas (paga, dinheiro, centro da cidade, talão como fatura). */
export async function addShiftExpense(o: {
  day: string; shift: HandoverShift; city: HandoverCity; description: string; amount: number;
  invoiceKey?: string | null; invoiceUrl?: string | null; user: { id: number; name?: string | null };
} & ShiftExpenseExtrasInput): Promise<{ id: number }> {
  const checked = shiftExpenseExtras(o.day, o.amount, o);
  if (!checked.ok) throw new Error(checked.message);
  const ex = checked.value;
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  if (!isOwnInvoiceKey(o.user.id, o.invoiceKey)) throw new Error("O talão tem de ser carregado por ti.");
  if (ex.categoryId != null && !(await categoryExists(ex.categoryId))) throw new Error("Categoria inexistente.");
  const projectId = await cityProjectId(o.city);
  const res: any = await db.insert(expenses).values({
    supplier: ex.supplier,
    supplierNif: ex.supplierNif,
    documentNumber: ex.documentNumber,
    description: o.description.slice(0, 500),
    amount: o.amount.toFixed(2),
    currency: "EUR",
    paymentMethod: "cash",
    paidBy: "company",
    // A data do talão (como nas Despesas); o pagamento é do dia do turno (saiu da caixa nesse turno).
    expenseDate: `${ex.expenseDay} 00:00:00`,
    paidAt: `${o.day} 00:00:00`,
    status: "paid",
    approvalStatus: "legacy",
    projectId,
    categoryId: ex.categoryId,
    insertedById: o.user.id,
    invoiceImageKey: o.invoiceKey ?? null,
    invoiceImageUrl: o.invoiceUrl ?? null,
    extractedByAi: ex.extractedByAi ? 1 : 0,
    cashSource: shiftCashSource(o.day, o.shift, o.city),
    notes: shiftExpenseNotes(o.shift, ex.vatAmount),
  } as any);
  const id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
  if (id) {
    await recordExpenseEvent({
      expenseId: id, type: "created", userId: o.user.id,
      after: {
        source: "shift", day: o.day, shift: o.shift, city: o.city, amount: o.amount,
        supplier: ex.supplier, documentNumber: ex.documentNumber, categoryId: ex.categoryId, expenseDate: ex.expenseDay, extractedByAi: ex.extractedByAi,
      },
    }).catch(() => {});
    await logActivity({ userId: o.user.id, action: "create", entity: "expense", entityId: id, details: `Despesa do turno ${o.day} ${SHIFT_LABEL[o.shift]} ${o.city}: ${o.description}${ex.supplier ? ` (${ex.supplier})` : ""} · ${o.amount.toFixed(2)} €` }).catch(() => {});
  }
  return { id };
}

// ─── Talão lido pela IA (a MESMA das Despesas) ──────────────────────────────

export interface ShiftReceiptReading {
  supplier: string | null;
  supplierNif: string | null;
  /** null = a IA não leu NIF; false = leu um NIF que não passa no controlo (o cartão avisa). */
  nifValid: boolean | null;
  documentNumber: string | null;
  invoiceDate: string | null;
  amount: number | null;
  vatAmount: number | null;
  description: string | null;
  /** Categoria sugerida pela IA, já ligada à lista das Despesas (null se não houver correspondência). */
  category: { id: number; name: string } | null;
  /** Fatura EMITIDA por uma empresa do grupo — não é uma despesa (o cartão avisa). */
  selfInvoice: boolean;
}

const positiveOrNull = (v: string | null, allowZero = false): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) ? Math.round(n * 100) / 100 : null;
};

/** Saída da IA → o que o cartão preenche. PURA. */
export function receiptReadingFrom(x: InvoiceData, categories: ReadonlyArray<{ id: number; name: string | null }>): ShiftReceiptReading {
  const nif = x.nif ? normalizeSupplierNif(x.nif) : null;
  const key = matchKey(x.suggestedCategory);
  const cat = key ? categories.find((c) => matchKey(c.name) === key) : undefined;
  return {
    supplier: x.supplier ? x.supplier.slice(0, 256) : null,
    supplierNif: nif ? (nif.ok ? nif.nif : String(x.nif).replace(/\s+/g, "")) : null,
    nifValid: nif ? nif.ok : null,
    documentNumber: x.invoiceNumber ? x.invoiceNumber.slice(0, 64) : null,
    invoiceDate: isIsoDay(x.expenseDate) ? x.expenseDate : null,
    amount: positiveOrNull(x.amount),
    vatAmount: positiveOrNull(x.vatAmount, true),
    description: x.description ? x.description.slice(0, 255) : null,
    category: cat ? { id: Number(cat.id), name: String(cat.name) } : null,
    selfInvoice: x.selfInvoice === true,
  };
}

/** Lê o talão com a IA das Despesas (com a lista de categorias, como lá). Lança AiError. */
export async function readShiftReceipt(o: { base64: string; mimeType: string; userId: number }): Promise<ShiftReceiptReading> {
  let categories: Array<{ id: number; name: string | null }> = [];
  try { categories = (await getAllCategories()) as any[]; } catch { /* opcional, como nas Despesas */ }
  const { extractInvoice } = await import("./expenseOcr");
  const data = await extractInvoice({ base64: o.base64, mimeType: o.mimeType, categoryNames: categories.map((c) => String(c.name ?? "")).filter(Boolean), userId: o.userId });
  return receiptReadingFrom(data, categories);
}

type ViewerUser = { id: number; role: string; accessOverrides?: any };

/** Quem pode abrir cada despesa nas Despesas — a MESMA regra do detalhe (expenses.byId). */
export async function openableInExpenses(rows: ReadonlyArray<{ insertedById: number | null; projectId: number | null }>, user: ViewerUser): Promise<boolean[]> {
  if (!rows.length) return [];
  if (!can(withOverrides(user), "despesas", "view")) return rows.map(() => false);
  const { expenseVisibilityFor } = await import("./expensesRouter");
  const vis = await expenseVisibilityFor(user);
  return rows.map((r) => r.insertedById != null && canSeeExpense(vis, { insertedById: Number(r.insertedById), projectId: r.projectId ?? null }));
}

/** Aviso de duplicado (como nas Despesas): mesmo n.º de documento do mesmo fornecedor. Não bloqueia;
 *  quem não pode ver a despesa só fica a saber que já existe (id null). */
export async function shiftReceiptDuplicate(r: Pick<ShiftReceiptReading, "supplier" | "supplierNif" | "documentNumber">, user: ViewerUser): Promise<{ id: number | null; documentNumber: string | null } | null> {
  if (!r.documentNumber || !(r.supplier || r.supplierNif)) return null;
  const dup: any = await findPossibleDuplicateExpense({ supplier: r.supplier, supplierNif: r.supplierNif, documentNumber: r.documentNumber });
  if (!dup) return null;
  const [open] = await openableInExpenses([{ insertedById: dup.insertedById ?? null, projectId: dup.projectId ?? null }], user);
  return { id: open ? Number(dup.id) : null, documentNumber: dup.documentNumber ?? null };
}

/** "Anular" uma despesa do turno = cancelada (nunca apagada). Só quem a lançou ou quem gere a passagem de turno. */
export async function cancelShiftExpense(o: { id: number; user: { id: number }; canManage: boolean }): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "FORBIDDEN"; message: string }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const [row] = await db.select({ id: expenses.id, cashSource: expenses.cashSource, insertedById: expenses.insertedById, status: expenses.status })
    .from(expenses).where(and(eq(expenses.id, o.id), isNull(expenses.deletedAt))).limit(1) as any[];
  if (!row || !parseShiftCashSource(row.cashSource)) return { ok: false, code: "NOT_FOUND", message: "Despesa do turno não encontrada." };
  if (!o.canManage && Number(row.insertedById) !== o.user.id) return { ok: false, code: "FORBIDDEN", message: "Só quem lançou a despesa (ou quem gere a passagem de turno) a pode anular." };
  if (row.status === "cancelled") return { ok: true };
  await db.update(expenses).set({ status: "cancelled" } as any).where(eq(expenses.id, o.id));
  await recordExpenseEvent({ expenseId: o.id, type: "updated", userId: o.user.id, before: { status: row.status }, after: { status: "cancelled", source: "shift" } }).catch(() => {});
  await logActivity({ userId: o.user.id, action: "update", entity: "expense", entityId: o.id, details: `Despesa do turno #${o.id} anulada (fica cancelada no histórico)` }).catch(() => {});
  return { ok: true };
}

/** Total das despesas do turno de um dia por cidade (para a caixa do dia). */
export async function shiftExpensesByCity(day: string): Promise<Map<HandoverCity, { total: number; count: number }>> {
  const db = await getDb();
  const out = new Map<HandoverCity, { total: number; count: number }>();
  if (!db) return out;
  const rows = await db.select({ cashSource: expenses.cashSource, amount: expenses.amount })
    .from(expenses).where(and(like(expenses.cashSource, `shift:${day}:%`), isNull(expenses.deletedAt), ne(expenses.status, "cancelled"))) as any[];
  for (const r of rows) {
    const k = parseShiftCashSource(r.cashSource);
    if (!k) continue;
    const c = out.get(k.city) ?? { total: 0, count: 0 };
    c.total = Math.round((c.total + Number(r.amount ?? 0)) * 100) / 100; c.count++;
    out.set(k.city, c);
  }
  return out;
}
