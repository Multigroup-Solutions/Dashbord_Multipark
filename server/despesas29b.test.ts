/**
 * P3 lote 29b — Despesas fixas (Jorge, 6 out 2026): "nas despesas fixas do
 * mês, nas correntes, ele deve meter lá automática mas deve aparecer como uma
 * despesa e pedir para se anexar a fatura, para depois ir para a contabilista"
 * e "não sei muito bem o que é isto aqui no modelo, não está a funcionar".
 * Causas: o mês inteiro lançava no dia 1 às 04:30, um modelo novo só aparecia
 * no dia seguinte (sem botão) e a lista abre na semana atual.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { launchDayOf, templateDue } from "./expenseRecurring";
import { expenseConditions } from "./expenseScope";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("29b — cada modelo lança no SEU dia", () => {
  it("dia do modelo limitado ao último dia do mês", () => {
    expect(launchDayOf(8, 2026, 10)).toBe(8);
    expect(launchDayOf(28, 2026, 2)).toBe(28);
    expect(launchDayOf(0, 2026, 10)).toBe(1);
  });

  it("só entram os modelos cujo dia já chegou (upToDay), os pedidos e os que já existiam", () => {
    const renda = { id: 1, dayOfMonth: 8, createdAt: "2026-09-01 10:00:00" };
    expect(templateDue(renda, 2026, 10, { upToDay: 6 })).toBe(false); // 6 out: a renda do dia 8 ainda não
    expect(templateDue(renda, 2026, 10, { upToDay: 8 })).toBe(true);
    expect(templateDue(renda, 2026, 10, { upToDay: 20 })).toBe(true); // cron parado uns dias: apanha
    expect(templateDue(renda, 2026, 10, {})).toBe(true); // mês inteiro (manual)
    expect(templateDue(renda, 2026, 10, { templateIds: [2] })).toBe(false);
    // mês anterior: um modelo criado este mês não lança no mês passado
    const novo = { id: 3, dayOfMonth: 1, createdAt: "2026-10-06 09:00:00" };
    expect(templateDue(novo, 2026, 9, { createdBefore: "2026-10-01 00:00:00" })).toBe(false);
    expect(templateDue(renda, 2026, 9, { createdBefore: "2026-10-01 00:00:00" })).toBe(true);
  });

  it("o cron lança o dia de hoje e apanha o mês anterior; sem o mês inteiro no dia 1", () => {
    const cron = src("server/cronJobs.ts");
    expect(cron).toContain("generateRecurringExpensesForMonth(y, m, null, { upToDay: d })");
    expect(cron).toContain("generateRecurringExpensesForMonth(py, pm, null, { createdBefore:");
    expect(cron).not.toContain("generateRecurringExpensesForMonth(y, m, null);");
    const gen = src("server/expenseRecurring.ts");
    expect(gen).toContain("all.filter((t: any) => templateDue(t, year, month, opts))");
    expect(gen).toContain("isNull(recurringExpenses.removedAt)");
  });

  it("modelo novo / reativado / com outro dia lança logo a deste mês (se o dia já passou)", () => {
    const r = src("server/expensesRouter.ts");
    expect(r).toContain("const launched = newId ? await launchThisMonthNow(newId, ctx.user.id) : 0;");
    expect(r).toContain("if (active === true || rest.dayOfMonth !== undefined) {");
    expect(src("server/expenseRecurring.ts")).toContain("{ templateIds: [templateId], upToDay: d }");
  });
});

describe("29b — 'Falta a fatura'", () => {
  it("filtro 'Sem fatura': sem key nem URL, e não canceladas", () => {
    const base = expenseConditions({}, { kind: "all" } as any).length;
    expect(expenseConditions({ missingInvoice: true }, { kind: "all" } as any)).toHaveLength(base + 1);
    expect(src("server/expenseScope.ts")).toContain("COALESCE(${expenses.invoiceImageKey}, '') = '' AND COALESCE(${expenses.invoiceImageUrl}, '') = '' AND ${expenses.status} <> 'cancelled'");
    // o ecrã não conta as eliminadas; o lançamento continua a vê-las (não relança)
    expect(src("server/expenseRecurringStatus.ts")).toContain("isNull(expenses.deletedAt)");
    expect(src("server/expenseRecurring.ts")).not.toContain("deletedAt");
  });

  it("lista, aviso no topo, botão para anexar e o diálogo com o estado do mês", () => {
    const page = src("client/src/pages/ExpensesPage.tsx");
    expect(page).toContain("missingInvoice: missingInvoice || undefined,");
    // notas de crédito (7 out 2026): a NC diz "Falta a nota de crédito"; a fatura continua "Falta a fatura · fixa"
    expect(page).toContain("`Falta a fatura${expense.recurringTemplateId ? \" · fixa\" : \"\"}`");
    expect(page).toContain('aria-label="Anexar o documento"');
    expect(page).toContain("trpc.expenses.missingInvoiceSummary.useQuery");
    const dlg = src("client/src/components/ExpenseRecurringCompare.tsx");
    expect(dlg).toContain("falta a fatura");
    expect(dlg).toContain('aria-label="Editar modelo recorrente"');
    expect(dlg).toContain("lança a {dayPt(r.thisMonth.launchDate)}");
  });

  it("o Excel leva a folha 'Sem fatura' (para a contabilista) e o aviso é só de quem gere", () => {
    const r = src("server/expensesRouter.ts");
    expect(r).toContain(`XLSX.utils.book_append_sheet(wb, wsMissing, "Sem fatura")`);
    const i = r.indexOf("missingInvoiceSummary:");
    expect(r.slice(i, i + 300)).toContain(`requireAccess(ctx.user, "despesas", "manage")`);
    expect(src("docs/ajuda/despesas.md")).toContain("**Falta a fatura**");
  });
});
