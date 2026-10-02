/**
 * Projetos → Custos (P2.3 — 2 out 2026): custo REALIZADO de cada nó da árvore
 * vs. o orçamento, com as MESMAS regras da Faturação.
 *
 * Antes havia um cálculo próprio (db.getProjectCosts): salário de HOJE para
 * qualquer período, "Ano inteiro" com 12 meses de despesas e 1 de salários,
 * quem já saiu a contar, a mesma pessoa a contar em dois projetos e todas as
 * horas do ponto (suspeitas incluídas). Agora os custos vêm do motor das
 * Finanças (`details.costsByProject`): despesas sem IVA, pessoal (histórico
 * salarial, 13.º/14.º, variável do RH, TSU), extras pelo ponto aprovado e
 * comissões de parceiros. Cada nó com os descendentes = a Faturação filtrada
 * nesse nó.
 *
 * O orçamento (`projects.budget`) é ANUAL (decisão do Jorge, 2 out 2026): com
 * um mês escolhido compara-se com 1/12.
 */
import { inArray } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { getDb, getProjects } from "../db";
import { scopedProjectIds } from "../cityScope";
import { lisbonToday } from "../../shared/expensePeriods";
import { computeFinance, type ProjectCost } from "./engine";

const pad = (n: number) => String(n).padStart(2, "0");

/** Período de calendário do filtro (ano, ou mês desse ano). PURA. */
export function projectCostsPeriod(year: number, month?: number | null): { from: string; to: string } {
  if (month) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
  }
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** Orçamento do período: o budget é ANUAL; um mês conta 1/12. PURA. */
export function budgetForPeriod(annual: number, month?: number | null): number {
  return month ? annual / 12 : annual;
}

export interface ProjectCostRow {
  id: number; name: string; level: string; parentId: number | null; color: string | null; isActive: boolean;
  managerName: string;
  /** orçamento anual (como está no nó) e o do período escolhido */
  budgetAnnual: number; budget: number;
  expenses: number; expensesGross: number;
  salaries: number; employerTax: number; extras: number;
  /** salários + TSU + extras */
  personnel: number;
  commissions: number;
  totalCost: number;
}

const ZERO: ProjectCost = { projectId: null, expensesNet: 0, expenses: 0, salaries: 0, employerTax: 0, extras: 0, salesCommissions: 0, operationalCommissions: 0, total: 0 };

/** Linha da página a partir do custo do motor (sem nó = "Por atribuir"). PURA. */
export function costFields(c: ProjectCost): Pick<ProjectCostRow, "expenses" | "expensesGross" | "salaries" | "employerTax" | "extras" | "personnel" | "commissions" | "totalCost"> {
  return {
    expenses: c.expensesNet, expensesGross: c.expenses,
    salaries: c.salaries, employerTax: c.employerTax, extras: c.extras,
    personnel: c.salaries + c.employerTax + c.extras,
    commissions: c.salesCommissions + c.operationalCommissions,
    totalCost: c.total,
  };
}

export async function projectCostsReport(input: { year?: number; month?: number | null; today?: string }) {
  const today = input.today ?? lisbonToday();
  const year = input.year ?? Number(today.slice(0, 4));
  const month = input.month ?? null;
  const { from, to } = projectCostsPeriod(year, month);
  // Sem centro: o alcance de cidade do pedido (o motor aplica-o sozinho).
  const finance = await computeFinance({ from, to, today, granularity: "month" });
  const costById = new Map(finance.details.costsByProject.map((c) => [c.projectId, c]));

  const scoped = scopedProjectIds();
  const nodes = (await getProjects()).filter((n) => !scoped || scoped.includes(n.id));
  const managerIds = Array.from(new Set(nodes.map((n) => n.managerId).filter((v): v is number => v != null)));
  const names = new Map<number, string>();
  const db = await getDb();
  if (db && managerIds.length) {
    for (const u of await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, managerIds))) {
      names.set(u.id, u.name || u.email || "—");
    }
  }

  const rows: ProjectCostRow[] = nodes.map((n) => {
    const budgetAnnual = Number(n.budget ?? 0) || 0;
    return {
      id: n.id, name: n.name, level: n.level, parentId: n.parentId ?? null, color: n.color ?? null, isActive: n.isActive !== 0,
      managerName: n.managerId != null ? names.get(n.managerId) ?? "—" : "—",
      budgetAnnual, budget: budgetForPeriod(budgetAnnual, month),
      ...costFields(costById.get(n.id) ?? ZERO),
    };
  });

  // Sem centro — ou com um centro que já não está na árvore — vai para "Por
  // atribuir": a tabela soma sempre o total da Faturação.
  const known = new Set(rows.map((r) => r.id));
  const unallocated = { ...ZERO };
  for (const c of finance.details.costsByProject) {
    if (c.projectId != null && known.has(c.projectId)) continue;
    for (const k of ["expensesNet", "expenses", "salaries", "employerTax", "extras", "salesCommissions", "operationalCommissions", "total"] as const) unallocated[k] += c[k];
  }

  return {
    period: { year, month, from, to, asOf: today, isCurrent: finance.quality.isCurrentPeriod },
    rows,
    /** custos sem centro (despesas, pessoas e extras sem centro de custos) */
    unallocated: costFields(unallocated),
    /** totais do período = os da Faturação (mesmo alcance) */
    totals: {
      expenses: finance.costs.expensesNet,
      personnel: finance.costs.salaries + finance.costs.employerTax + finance.costs.extrasDia,
      commissions: finance.costs.salesCommissions + finance.costs.operationalCommissions,
      totalCost: finance.costs.totalNet,
    },
  };
}
