/**
 * Orçamentos mensais de marketing (0093, Jorge 24 set 2026) e o seu ritmo.
 *
 * Um objetivo = (mês, nó cidade OU marca, fornecedor opcional, valor).
 * Gasto até à data = gasto da fonte única (getAdMetrics) do dia 1 até ONTEM
 * nesse nó (com filhos; nacional repartido pela sua parte), do fornecedor
 * escolhido ou de todos. Esperado = valor × dias completos ÷ dias do mês
 * (shared/marketingRules.budgetPacing). Âmbito de cidade do utilizador.
 */
import { and, eq } from "drizzle-orm";
import { getDb, getProjects, resolveProjectIds } from "./db";
import { marketingBudgets } from "../drizzle/schema";
import { scopedProjectIds } from "./cityScope";
import { budgetPacing, type BudgetPacing } from "../shared/marketingRules";
import { addDays } from "../shared/lisbonDay";

export const BUDGET_PROVIDERS = ["all", "google_ads", "meta"] as const;
export type BudgetProvider = (typeof BUDGET_PROVIDERS)[number];
const PROVIDER_LABEL: Record<string, string> = { all: "", google_ads: " · Google Ads", meta: " · Meta" };

export interface BudgetWithPacing {
  id: number; month: string; projectId: number; provider: string; amount: number; notes: string | null;
  label: string; spentToDate: number; spentMonth: number; pacing: BudgetPacing;
}

function lisbonToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export function monthBounds(month: string): { from: string; to: string; days: number } {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, "0")}`, days };
}

export async function listBudgetsWithPacing(opts: { month: string; projectId?: number; today?: string }): Promise<BudgetWithPacing[]> {
  if (!/^\d{4}-\d{2}$/.test(opts.month)) throw new Error("Mês inválido (AAAA-MM)");
  const db = await getDb();
  if (!db) return [];
  const today = opts.today ?? lisbonToday();
  const { from, to, days } = monthBounds(opts.month);
  const allowed = scopedProjectIds();
  const filterIds = opts.projectId ? new Set(await resolveProjectIds(opts.projectId)) : null;
  const rows = await db.select().from(marketingBudgets).where(eq(marketingBudgets.month, opts.month));
  const projects = await getProjects();
  const byId = new Map(projects.map((p: any) => [p.id, p]));
  const label = (id: number) => {
    const p: any = byId.get(Math.abs(id));
    if (!p) return `#${id}`;
    if (id < 0) return `${p.name} (todas as cidades)`;
    const parent: any = p.parentId != null ? byId.get(p.parentId) : null;
    return p.level === "brand" && parent ? `${p.name} ${parent.name}` : p.name;
  };
  // Dia do mês para o ritmo: mês corrente → hoje; mês passado → fechado; futuro → nada decorrido
  const dayOfMonth = today < from ? 1 : today > to ? days + 1 : Number(today.slice(8, 10));
  const spendTo = today > to ? to : addDays(today, -1);
  const { getAdMetrics } = await import("./integrations/googleAds/adMetrics");
  const cache = new Map<string, Awaited<ReturnType<typeof getAdMetrics>> | null>();
  const out: BudgetWithPacing[] = [];
  for (const b of rows) {
    let ids = await resolveProjectIds(b.projectId);
    if (allowed) ids = ids.filter((id) => allowed.includes(id));
    if (!ids.length) continue;
    if (filterIds && !ids.some((id) => filterIds.has(id)) && !filterIds.has(b.projectId)) continue;
    const key = ids.slice().sort((a, c) => a - c).join(",");
    if (!cache.has(key)) cache.set(key, spendTo >= from ? await getAdMetrics({ from, to: spendTo, projectIds: ids }) : null);
    const m = cache.get(key);
    const spent = !m ? 0 : b.provider === "google_ads" ? m.byProvider.google_ads : b.provider === "meta" ? m.byProvider.meta : m.totals.cost;
    const amount = Number(b.amount);
    out.push({
      id: b.id, month: b.month, projectId: b.projectId, provider: b.provider, amount, notes: b.notes ?? null,
      label: `${label(b.projectId)}${PROVIDER_LABEL[b.provider] ?? ""}`,
      spentToDate: spent, spentMonth: spent,
      pacing: budgetPacing({ amount, spentToDate: spent, dayOfMonth, daysInMonth: days }),
    });
  }
  return out.sort((a, c) => a.label.localeCompare(c.label));
}

export async function upsertBudget(input: { month: string; projectId: number; provider: BudgetProvider; amount: number; notes?: string | null; userId: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  await db.insert(marketingBudgets).values({
    month: input.month, projectId: input.projectId, provider: input.provider, amount: input.amount.toFixed(2), notes: input.notes ?? null, createdById: input.userId,
  }).onDuplicateKeyUpdate({ set: { amount: input.amount.toFixed(2), notes: input.notes ?? null } });
}

export async function removeBudget(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  await db.delete(marketingBudgets).where(eq(marketingBudgets.id, id));
}

/** Copia os objetivos de um mês para o seguinte (só os que ainda não existem). */
export async function copyBudgets(fromMonth: string, toMonth: string, userId: number): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const src = await db.select().from(marketingBudgets).where(eq(marketingBudgets.month, fromMonth));
  const allowed = scopedProjectIds();
  let n = 0;
  for (const b of src) {
    if (allowed && !allowed.includes(b.projectId)) continue;
    const ex = await db.select({ id: marketingBudgets.id }).from(marketingBudgets)
      .where(and(eq(marketingBudgets.month, toMonth), eq(marketingBudgets.projectId, b.projectId), eq(marketingBudgets.provider, b.provider))).limit(1);
    if (ex.length) continue;
    await db.insert(marketingBudgets).values({ month: toMonth, projectId: b.projectId, provider: b.provider, amount: b.amount, notes: b.notes, createdById: userId });
    n++;
  }
  return n;
}
