/**
 * Geração das despesas recorrentes (fixas do mês) a partir dos modelos.
 *
 * Antes corria ao ABRIR a página (qualquer admin) com um "select depois
 * insert" sem proteção — duas abas ou página+cron lançavam a renda duas vezes.
 * Agora:
 *   - corre no cron diário (/api/cron/daily-ops) e, opcionalmente, à mão pelo
 *     botão "Lançar as deste mês" do diálogo de recorrentes;
 *   - lock nomeado do MySQL (GET_LOCK) serializa gerações concorrentes;
 *   - `recurringPeriod` "YYYY-MM" + UNIQUE (recurringTemplateId, recurringPeriod)
 *     garante uma ocorrência por modelo/mês mesmo que o lock falhe (ER_DUP_ENTRY
 *     é tratado como "já existia").
 */
import { and, eq, sql } from "drizzle-orm";
import { expenses, recurringExpenses } from "../drizzle/schema";
import { getDb, getSuperAdmins } from "./db";
import { recordExpenseEvent } from "./db";

export interface RecurringGenerationResult {
  period: string;
  created: number;
  skipped: number;
  lockAcquired: boolean;
}

export function periodOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * @param actorUserId quem fica como "inserido por". Sem ator (cron) usa o
 *   criador do modelo e, em último caso, o primeiro super_admin.
 */
export async function generateRecurringExpensesForMonth(
  year: number,
  month: number,
  actorUserId?: number | null,
): Promise<RecurringGenerationResult> {
  const db = await getDb();
  const period = periodOf(year, month);
  if (!db) return { period, created: 0, skipped: 0, lockAcquired: false };

  const LOCK = "expenses_recurring_generate";
  const lockRow = (await db.execute(sql`SELECT GET_LOCK(${LOCK}, 10) AS ok`)) as any;
  const lockOk = Number((Array.isArray(lockRow[0]) ? lockRow[0][0] : lockRow[0])?.ok ?? 0) === 1;

  let created = 0;
  let skipped = 0;
  try {
    const templates = await db.select().from(recurringExpenses).where(eq(recurringExpenses.active, 1));
    if (templates.length === 0) return { period, created, skipped, lockAcquired: lockOk };

    let fallbackUser: number | null = actorUserId ?? null;
    if (fallbackUser == null) {
      const admins = await getSuperAdmins();
      fallbackUser = admins[0]?.id ?? null;
    }
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

    for (const t of templates) {
      const existing = await db
        .select({ id: expenses.id })
        .from(expenses)
        .where(and(eq(expenses.recurringTemplateId, t.id), eq(expenses.recurringPeriod, period)))
        .limit(1);
      if (existing.length) { skipped++; continue; }

      const insertedById = actorUserId ?? t.createdById ?? fallbackUser;
      if (insertedById == null) { skipped++; continue; }
      const day = Math.min(t.dayOfMonth, lastDay);
      try {
        const res = await db.insert(expenses).values({
          supplier: t.supplier,
          description: t.description,
          amount: t.amount,
          currency: t.currency,
          paymentMethod: t.paymentMethod,
          expenseDate: `${period}-${String(day).padStart(2, "0")} 00:00:00`,
          status: "pending",
          approvalStatus: "legacy",
          categoryId: t.categoryId,
          projectId: t.projectId,
          insertedById,
          recurringTemplateId: t.id,
          recurringPeriod: period,
          notes: t.notes,
        } as any);
        const newId = Number((res as any)?.[0]?.insertId ?? 0) || null;
        if (newId) {
          await recordExpenseEvent({
            expenseId: newId, type: "created", userId: actorUserId ?? null,
            after: { source: "recurring", templateId: t.id, period, amount: t.amount },
          });
        }
        created++;
      } catch (err: any) {
        if (err?.code === "ER_DUP_ENTRY") { skipped++; continue; }
        throw err;
      }
    }
  } finally {
    if (lockOk) {
      try { await db.execute(sql`SELECT RELEASE_LOCK(${LOCK})`); } catch { /* ignore */ }
    }
  }
  return { period, created, skipped, lockAcquired: lockOk };
}
