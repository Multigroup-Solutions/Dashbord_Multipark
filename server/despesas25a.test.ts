/**
 * P3 lote 25a — D4 (Jorge, 3 out 2026): eliminar uma despesa = desaparece
 * como se fosse apagada, mas fica guardada (só o super admin a vê, a pedido).
 * Remover um modelo recorrente = desativar.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATION_0465_STATEMENTS } from "./migrations/migration_0465";
import { SCHEMA_MIGRATION_IDS } from "./migrations";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("D4 — eliminar não apaga", () => {
  const r = src("server/expensesRouter.ts");
  const db = src("server/db.ts");
  it("a rota marca deletedAt (sem DELETE nem apagar a fatura); só o super admin elimina e repõe", () => {
    const del = r.slice(r.indexOf("  delete: protectedProcedure"), r.indexOf("  restore: protectedProcedure"));
    expect(del).toContain('requireRole(ctx.user.role, "super_admin");');
    expect(del).toContain("await softDeleteExpense(input.id, ctx.user.id);");
    expect(del).not.toContain("storageDelete");
    expect(del).not.toContain("deleteExpense(");
    const rest = r.slice(r.indexOf("  restore: protectedProcedure"), r.indexOf("  restore: protectedProcedure") + 700);
    expect(rest).toContain('requireRole(ctx.user.role, "super_admin");');
    expect(rest).toContain("await restoreExpense(input.id);");
    expect(db).not.toMatch(/db\.delete\(expenses\)/);
    expect(db).toContain(".set({ deletedAt: sql`CURRENT_TIMESTAMP`, deletedById: userId } as any)");
  });

  it("some de todo o lado: listas/totais/exportação, estatísticas, pendentes, Faturação, anomalias, marketing, fornecedores, duplicados", () => {
    expect(src("server/expenseScope.ts")).toContain("filters.deleted ? isNotNull(expenses.deletedAt) : expenseNotDeleted");
    expect(db).toContain("const live = and(ne(expenses.status, \"cancelled\"), isNull(expenses.deletedAt)) as SQL;");
    expect(db.match(/isNull\(expenses\.deletedAt\)/g)!.length).toBeGreaterThanOrEqual(9);
    expect(src("server/finance/engine.ts").match(/\$\{expenses\.deletedAt\} IS NULL/g)!.length).toBe(2);
    expect(src("server/aiOps/anomalies.ts")).toContain("AND status <> 'cancelled' AND deletedAt IS NULL");
    expect(src("server/integrations/googleAds/marketingStats.ts")).toContain("e.status <> 'cancelled' AND e.deletedAt IS NULL");
    expect(src("server/contactsSearch.ts").match(/e\.deletedAt IS NULL/g)!.length).toBe(2);
    // o lançamento das recorrentes continua a VER a eliminada → não a volta a lançar
    expect(src("server/expenseRecurring.ts")).not.toContain("deletedAt");
  });

  it("as eliminadas só aparecem ao super admin a pedido; editar uma eliminada não dá", () => {
    expect(r).toContain('deleted: input?.deleted === true && user.role === "super_admin",');
    expect(r.match(/getExpenseById\(input\.id, \{ includeDeleted: ctx\.user\.role === "super_admin" \}\)/g)!.length).toBe(3);
    const upd = r.slice(r.indexOf("  update: protectedProcedure"), r.indexOf("  delete: protectedProcedure"));
    expect(upd).toContain("await getExpenseById(input.id);");
    const page = src("client/src/pages/ExpensesPage.tsx");
    expect(page).toContain("deleted: canDelete && showDeleted ? true : undefined,");
    expect(page).toContain('aria-label="Ver as despesas eliminadas"');
    expect(page).toContain('aria-label="Repor despesa"');
    expect(page).toContain("fica guardada (vês e repões em «Eliminadas»)");
  });

  it("remover um modelo recorrente = desativar e sair da lista", () => {
    const rem = r.slice(r.indexOf("    remove: protectedProcedure"), r.indexOf("    remove: protectedProcedure") + 900);
    expect(rem).toContain(".set({ active: 0, removedAt: sql`CURRENT_TIMESTAMP`, removedById: ctx.user.id } as any)");
    expect(rem).not.toMatch(/db\.delete\(/);
    expect(r).toContain("isNullOp(recurringExpenses.removedAt)");
  });

  it("migração 0465: só colunas novas", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0465")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0460"));
    const all = MIGRATION_0465_STATEMENTS.join("\n");
    for (const c of ["`expenses` ADD COLUMN `deletedAt`", "`expenses` ADD COLUMN `deletedById`", "`recurring_expenses` ADD COLUMN `removedAt`"]) expect(all).toContain(c);
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b|\bUPDATE\b/);
  });
});
