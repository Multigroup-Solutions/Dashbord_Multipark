/**
 * Geração das despesas recorrentes (fixas do mês) a partir dos modelos.
 *
 * Antes corria ao ABRIR a página (qualquer admin) com um "select depois
 * insert" sem proteção — duas abas ou página+cron lançavam a renda duas vezes.
 * Agora:
 *   - corre no cron diário (/api/cron/daily-ops); 29b (Jorge, 6 out 2026:
 *     "lança automática mas deve aparecer como uma despesa e pedir para anexar
 *     a fatura"): cada modelo lança NO SEU DIA (upToDay = hoje), o mês
 *     anterior apanha o que tenha ficado por lançar, e um modelo novo (ou
 *     reativado) lança logo a deste mês se o dia já passou;
 *   - lock nomeado do MySQL (GET_LOCK) serializa gerações concorrentes;
 *   - `recurringPeriod` "YYYY-MM" + UNIQUE (recurringTemplateId, recurringPeriod)
 *     garante uma ocorrência por modelo/mês mesmo que o lock falhe (ER_DUP_ENTRY
 *     é tratado como "já existia").
 */
import { projectScope } from './cityScope';
import { and, eq, isNull, sql } from "drizzle-orm";
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

export interface RecurringGenerationOptions {
  /** só os modelos cujo dia (limitado ao último do mês) já chegou: dia ≤ upToDay */
  upToDay?: number;
  /** só estes modelos (ex.: o que acabou de ser criado) */
  templateIds?: number[];
  /** só modelos criados antes disto ("YYYY-MM-DD HH:MM:SS") — o mês anterior não lança modelos novos */
  createdBefore?: string;
}

/** Dia em que o modelo lança no mês (1–28, nunca depois do último dia). PURA. */
export function launchDayOf(dayOfMonth: number, year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.max(1, Math.min(Number(dayOfMonth) || 1, lastDay));
}

/** O modelo entra nesta geração? PURA. */
export function templateDue(t: { id: number; dayOfMonth: number; createdAt?: string | null }, year: number, month: number, o: RecurringGenerationOptions = {}): boolean {
  if (o.templateIds && !o.templateIds.includes(t.id)) return false;
  if (o.upToDay != null && launchDayOf(t.dayOfMonth, year, month) > o.upToDay) return false;
  if (o.createdBefore && t.createdAt && String(t.createdAt) >= o.createdBefore) return false;
  return true;
}

/**
 * @param actorUserId quem fica como "inserido por". Sem ator (cron) usa o
 *   criador do modelo e, em último caso, o primeiro super_admin.
 */
export async function generateRecurringExpensesForMonth(
  year: number,
  month: number,
  actorUserId?: number | null,
  opts: RecurringGenerationOptions = {},
): Promise<RecurringGenerationResult> {
  const db = await getDb();
  const period = periodOf(year, month);
  if (!db) return { period, created: 0, skipped: 0, lockAcquired: false };

  // ⚠️ GET_LOCK é por LIGAÇÃO: com pool, o RELEASE podia ir noutra ligação e
  // o lock ficar preso. Por isso tudo corre numa transação (uma ligação).
  const LOCK = "expenses_recurring_generate";
  return db.transaction(async (tx) => {
  const lockRow = (await tx.execute(sql`SELECT GET_LOCK(${LOCK}, 10) AS ok`)) as any;
  const lockOk = Number((Array.isArray(lockRow[0]) ? lockRow[0][0] : lockRow[0])?.ok ?? 0) === 1;

  let created = 0;
  let skipped = 0;
  try {
    const all = await tx.select().from(recurringExpenses).where(and(eq(recurringExpenses.active, 1), isNull(recurringExpenses.removedAt), projectScope(recurringExpenses.projectId)));
    const templates = all.filter((t: any) => templateDue(t, year, month, opts));
    if (templates.length === 0) return { period, created, skipped, lockAcquired: lockOk };

    let fallbackUser: number | null = actorUserId ?? null;
    if (fallbackUser == null) {
      const admins = await getSuperAdmins();
      fallbackUser = admins[0]?.id ?? null;
    }
    for (const t of templates) {
      const existing = await tx
        .select({ id: expenses.id })
        .from(expenses)
        .where(and(eq(expenses.recurringTemplateId, t.id), eq(expenses.recurringPeriod, period)))
        .limit(1);
      if (existing.length) { skipped++; continue; }

      const insertedById = actorUserId ?? t.createdById ?? fallbackUser;
      if (insertedById == null) { skipped++; continue; }
      const day = launchDayOf(t.dayOfMonth, year, month);
      try {
        const res = await tx.insert(expenses).values({
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
        if (err?.code === "ER_DUP_ENTRY" || err?.cause?.code === "ER_DUP_ENTRY") { skipped++; continue; }
        throw err;
      }
    }
  } finally {
    if (lockOk) {
      try { await tx.execute(sql`SELECT RELEASE_LOCK(${LOCK})`); } catch { /* ignore */ }
    }
  }
  return { period, created, skipped, lockAcquired: lockOk };
  });
}

/**
 * 29b: o modelo acabado de criar (ou reativado / com outro dia) lança a deste
 * mês JÁ se o dia já passou — não espera pelo cron de amanhã nem pelo mês que
 * vem. Nunca lança duas vezes (mesma proteção do cron). Devolve quantas lançou.
 */
export async function launchThisMonthNow(templateId: number, actorUserId: number | null): Promise<number> {
  const { lisbonToday } = await import("../shared/expensePeriods");
  const [y, m, d] = lisbonToday().split("-").map(Number);
  try {
    const r = await generateRecurringExpensesForMonth(y, m, actorUserId, { templateIds: [templateId], upToDay: d });
    return r.created;
  } catch (e: any) {
    console.warn("[recorrentes] lançar já:", String(e?.message ?? e).slice(0, 160));
    return 0;
  }
}
