/**
 * 29b — estado deste mês das despesas fixas (para o ecrã) e contagem das
 * faturas em falta. Fica fora de expenseRecurring.ts de propósito: aqui as
 * despesas eliminadas NÃO contam (é o que se mostra), enquanto o lançamento
 * continua a vê-las para nunca voltar a lançar uma eliminada.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { expenses } from "../drizzle/schema";
import { getDb } from "./db";
import { launchDayOf, periodOf } from "./expenseRecurring";

export interface RecurringMonthStatus {
  /** dia (deste mês) em que o modelo lança */
  launchDate: string;
  /** a despesa deste mês, se já foi lançada */
  expense: { id: number; expenseDate: string; status: string; hasInvoice: boolean } | null;
}

/** Modelos → o estado deste mês (Lisboa) de cada um. Nunca lança. */
export async function recurringMonthStatus<T extends { id: number; dayOfMonth: number }>(models: T[]): Promise<Array<T & { thisMonth: RecurringMonthStatus }>> {
  const { lisbonToday } = await import("../shared/expensePeriods");
  const [y, m] = lisbonToday().split("-").map(Number);
  const period = periodOf(y, m);
  const byTemplate = new Map<number, RecurringMonthStatus["expense"]>();
  const db = await getDb();
  if (db && models.length) {
    const { inArray } = await import("drizzle-orm");
    const rows = await db.select({
      id: expenses.id, templateId: expenses.recurringTemplateId, expenseDate: expenses.expenseDate, status: expenses.status,
      key: expenses.invoiceImageKey, url: expenses.invoiceImageUrl,
    }).from(expenses).where(and(eq(expenses.recurringPeriod, period), inArray(expenses.recurringTemplateId, models.map((x) => x.id)), isNull(expenses.deletedAt)));
    for (const r of rows as any[]) {
      byTemplate.set(Number(r.templateId), { id: Number(r.id), expenseDate: String(r.expenseDate ?? "").slice(0, 10), status: String(r.status ?? ""), hasInvoice: !!(r.key || r.url) });
    }
  }
  return models.map((t) => ({
    ...t,
    thisMonth: { launchDate: `${period}-${String(launchDayOf(t.dayOfMonth, y, m)).padStart(2, "0")}`, expense: byTemplate.get(t.id) ?? null },
  }));
}

/** 29b: quantas despesas (do WHERE dado, já "sem fatura") faltam e quantas são fixas. */
export async function countMissingInvoices(where: any): Promise<{ total: number; recurring: number }> {
  const db = await getDb();
  if (!db) return { total: 0, recurring: 0 };
  const rows: any = await db.select({
    total: sql<number>`COUNT(*)`,
    recurring: sql<number>`SUM(CASE WHEN ${expenses.recurringTemplateId} IS NOT NULL THEN 1 ELSE 0 END)`,
  }).from(expenses).where(where);
  const r = (rows as any[])[0] ?? {};
  return { total: Number(r.total ?? 0), recurring: Number(r.recurring ?? 0) };
}
