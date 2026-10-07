/**
 * Notas de crédito das Despesas (Jorge, 7 out 2026) — leituras na BD. As
 * regras puras estão em shared/creditNotes.ts. A NC é uma linha de `expenses`
 * com valor negativo e `creditNoteOfId` = a fatura.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

/** Creditado (positivo) e n.º de NC ativas por fatura. */
export async function creditsByInvoice(invoiceIds: readonly number[]): Promise<Map<number, { credited: number; count: number }>> {
  const out = new Map<number, { credited: number; count: number }>();
  const ids = [...new Set(invoiceIds.filter((x) => Number.isFinite(x)))];
  if (!ids.length) return out;
  const db = await getDb();
  if (!db) return out;
  const rows = rowsOf(await db.execute(sql`SELECT creditNoteOfId AS invoiceId, -SUM(amount) AS credited, COUNT(*) AS n FROM expenses
    WHERE creditNoteOfId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) AND deletedAt IS NULL AND status <> 'cancelled'
    GROUP BY creditNoteOfId`));
  for (const r of rows) out.set(Number(r.invoiceId), { credited: Math.round(Number(r.credited ?? 0) * 100) / 100, count: Number(r.n ?? 0) });
  return out;
}

/** O que as outras NC ativas da fatura já creditaram (sem a `excludeId`). */
export async function otherCredited(invoiceId: number, excludeId?: number | null): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const r = rowsOf(await db.execute(sql`SELECT -COALESCE(SUM(amount), 0) AS credited FROM expenses
    WHERE creditNoteOfId = ${invoiceId} AND deletedAt IS NULL AND status <> 'cancelled' AND id <> ${excludeId ?? 0}`))[0];
  return Math.round(Number(r?.credited ?? 0) * 100) / 100;
}

/** Identificação curta das faturas (para a linha da NC: "NC da fatura …"). */
export async function invoiceRefs(ids: readonly number[]): Promise<Map<number, { id: number; supplier: string | null; documentNumber: string | null; expenseDate: string | null; amount: string }>> {
  const out = new Map<number, { id: number; supplier: string | null; documentNumber: string | null; expenseDate: string | null; amount: string }>();
  const list = [...new Set(ids.filter((x) => Number.isFinite(x)))];
  if (!list.length) return out;
  const db = await getDb();
  if (!db) return out;
  const rows = rowsOf(await db.execute(sql`SELECT id, supplier, documentNumber, DATE_FORMAT(expenseDate, '%Y-%m-%d') AS expenseDate, amount FROM expenses
    WHERE id IN (${sql.join(list.map((i) => sql`${i}`), sql`, `)})`));
  for (const r of rows) out.set(Number(r.id), { id: Number(r.id), supplier: r.supplier ?? null, documentNumber: r.documentNumber ?? null, expenseDate: r.expenseDate ?? null, amount: String(r.amount) });
  return out;
}

/** Junta à lista: nas faturas, o creditado e o líquido; nas NC, a fatura de origem. */
export async function withCreditNoteInfo<T extends { expense: { id: number; amount: string; creditNoteOfId?: number | null } }>(rows: T[]): Promise<Array<T & { creditNote: { credited: number; count: number; net: number } | null; creditOf: { id: number; supplier: string | null; documentNumber: string | null; expenseDate: string | null; amount: string } | null }>> {
  const invoiceIds = rows.filter((r) => r.expense.creditNoteOfId == null).map((r) => r.expense.id);
  const ncTargets = rows.map((r) => r.expense.creditNoteOfId).filter((x): x is number => x != null);
  const [credits, refs] = await Promise.all([creditsByInvoice(invoiceIds), invoiceRefs(ncTargets)]);
  return rows.map((r) => {
    const c = r.expense.creditNoteOfId == null ? credits.get(r.expense.id) : undefined;
    return {
      ...r,
      creditNote: c ? { ...c, net: Math.round((Number(r.expense.amount) - c.credited) * 100) / 100 } : null,
      creditOf: r.expense.creditNoteOfId != null ? refs.get(r.expense.creditNoteOfId) ?? null : null,
    };
  });
}
