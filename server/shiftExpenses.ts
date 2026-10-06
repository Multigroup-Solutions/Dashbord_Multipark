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
 */
import { and, eq, isNull, like, ne } from "drizzle-orm";
import { expenses } from "../drizzle/schema";
import { getDb, getProjects, logActivity, recordExpenseEvent } from "./db";
import { matchCityKey } from "../shared/city";

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
  description: string; amount: number; status: string; hasReceipt: boolean;
  insertedById: number | null; createdAt: string | null;
}

const toRow = (r: any): ShiftExpense | null => {
  const k = parseShiftCashSource(r.cashSource);
  if (!k) return null;
  return {
    id: Number(r.id), ...k, description: String(r.description ?? r.supplier ?? ""), amount: Number(r.amount ?? 0), status: String(r.status ?? ""),
    hasReceipt: !!(r.invoiceImageKey || r.invoiceImageUrl), insertedById: r.insertedById == null ? null : Number(r.insertedById), createdAt: r.createdAt ? String(r.createdAt) : null,
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
    insertedById: expenses.insertedById, createdAt: expenses.createdAt,
  }).from(expenses).where(and(...conds)).orderBy(expenses.id);
  return (rows as any[]).map(toRow).filter((x): x is ShiftExpense => !!x);
}

/** Soma (não canceladas) das despesas do turno. PURA. */
export const shiftExpensesTotal = (rows: readonly Pick<ShiftExpense, "amount" | "status">[]): number =>
  Math.round(rows.filter((r) => r.status !== "cancelled").reduce((s, r) => s + r.amount, 0) * 100) / 100;

/** Lança a despesa do turno nas Despesas (paga, dinheiro, centro da cidade, talão como fatura). */
export async function addShiftExpense(o: {
  day: string; shift: HandoverShift; city: HandoverCity; description: string; amount: number;
  invoiceKey?: string | null; invoiceUrl?: string | null; user: { id: number; name?: string | null };
}): Promise<{ id: number }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  if (!isOwnInvoiceKey(o.user.id, o.invoiceKey)) throw new Error("O talão tem de ser carregado por ti.");
  const projectId = await cityProjectId(o.city);
  const res: any = await db.insert(expenses).values({
    supplier: null,
    description: o.description.slice(0, 500),
    amount: o.amount.toFixed(2),
    currency: "EUR",
    paymentMethod: "cash",
    paidBy: "company",
    expenseDate: `${o.day} 00:00:00`,
    paidAt: `${o.day} 00:00:00`,
    status: "paid",
    approvalStatus: "legacy",
    projectId,
    insertedById: o.user.id,
    invoiceImageKey: o.invoiceKey ?? null,
    invoiceImageUrl: o.invoiceUrl ?? null,
    cashSource: shiftCashSource(o.day, o.shift, o.city),
    notes: `Despesa do turno (${SHIFT_LABEL[o.shift]}) — Passagem de turno, paga com o dinheiro da caixa`,
  } as any);
  const id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
  if (id) {
    await recordExpenseEvent({ expenseId: id, type: "created", userId: o.user.id, after: { source: "shift", day: o.day, shift: o.shift, city: o.city, amount: o.amount } }).catch(() => {});
    await logActivity({ userId: o.user.id, action: "create", entity: "expense", entityId: id, details: `Despesa do turno ${o.day} ${SHIFT_LABEL[o.shift]} ${o.city}: ${o.description} · ${o.amount.toFixed(2)} €` }).catch(() => {});
  }
  return { id };
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
