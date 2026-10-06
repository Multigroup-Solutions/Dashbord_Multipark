/**
 * P3 lote 29c — Financeiro → Caixa (Jorge, 6 out 2026): "na faturação isto não
 * está bem com o que eu quero; aqui de lado tem de estar: uma coisa é
 * faturação, outra coisa é caixa". A Caixa sai dos separadores da Faturação
 * para o seu item no menu, com módulo próprio ("caixa"); quem já tinha a
 * Faturação continua a ver a Caixa.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MATRIX, MODULES } from "../shared/access";
import { canCash, cashCheckAllowed, cashModuleFor } from "./cashCheck/access";
import { moduleForPath } from "./_core/accessContext";
import { can } from "../shared/access";
import { caixaTabFrom } from "../shared/caixaTabs";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("29c — módulo Caixa", () => {
  it("existe na matriz (só super admin por omissão, como a Faturação) e no grupo Financeiro", () => {
    expect(MODULES.find((m) => m.id === "caixa")).toMatchObject({ group: "Financeiro" });
    expect(MATRIX.caixa.super_admin).toMatchObject({ access: "national", actions: ["view", "edit", "export", "manage"] });
    expect(MATRIX.caixa.admin.access).toBe("none");
  });

  it("dá-se sozinha (sem a Faturação) e quem tem a Faturação continua com a Caixa", () => {
    const onlyCaixa = { id: 5, role: "backoffice", accessOverrides: { caixa: { access: "national", actions: ["view", "edit"] } } };
    expect(canCash(onlyCaixa as any, "view")).toBe(true);
    expect(canCash(onlyCaixa as any, "edit")).toBe(true);
    expect(canCash(onlyCaixa as any, "manage")).toBe(false);
    expect(cashModuleFor(onlyCaixa as any, "edit")).toBe("caixa");
    const boss = { id: 1, role: "super_admin" };
    expect(canCash(boss as any, "manage")).toBe(true);
    expect(cashCheckAllowed(boss as any)).toBe(true);
    const nobody = { id: 9, role: "backoffice" };
    expect(canCash(nobody as any, "view")).toBe(false);
    expect(cashModuleFor(nobody as any, "view")).toBe("faturacao"); // e o requireAccess recusa
  });

  it("as rotas da Caixa passam pela porta nova; o alcance de cidade segue o módulo caixa", () => {
    expect(moduleForPath("cashCheck.cases")).toBe("caixa");
    expect(moduleForPath("invoices.cash")).toBe("caixa");
    expect(moduleForPath("invoices.billing")).toBe("faturacao");
    const r = src("server/cashCheckRouter.ts");
    expect(r).toContain(`requireAccess(user, cashModuleFor(user, "view"), "view");`);
    expect(r).not.toContain(`requireAccess(ctx.user, "faturacao", "edit")`);
    expect(src("server/routers.ts")).toContain(`await requireFinanceTotals(ctx.user, cashModuleFor(ctx.user, "view"), "view");`);
  });

  it("os avisos da Caixa vão para quem tem a Caixa e abrem /caixa", () => {
    expect(src("shared/notificationRouting.ts").match(/module: "caixa", action: "view"/g)).toHaveLength(2);
    const sweep = src("server/cashSweep.ts");
    expect(sweep).toContain("/caixa?tab=correcao&case=");
    expect(sweep).not.toContain("/faturacao?tab=cash-check");
  });
});

describe("29c — menu e páginas", () => {
  it("Financeiro → Caixa no menu (logo a seguir à Faturação), visível com a Caixa ou a Faturação", () => {
    const layout = src("client/src/components/DashboardLayout.tsx");
    expect(layout).toContain(`{ icon: FileText, label: "Faturação", path: "/faturacao", module: "faturacao" },
      // 29c:`);
    expect(layout).toContain(`{ icon: Wallet, label: "Caixa", path: "/caixa", anyOf: ["caixa", "faturacao"] },`);
    // canSeeItem com anyOf = can(view) em qualquer dos dois
    expect(can({ role: "backoffice", accessOverrides: { caixa: { access: "national", actions: ["view"] } } } as any, "caixa", "view")).toBe(true);
    expect(can("super_admin", "caixa", "view")).toBe(true);
    expect(can("backoffice", "caixa", "view") || can("backoffice", "faturacao", "view")).toBe(false);
  });

  it("a Faturação deixa os separadores da caixa e manda os links antigos para /caixa", () => {
    const inv = src("client/src/pages/InvoicesPage.tsx");
    expect(inv).not.toContain('<TabsTrigger value="cash-check">');
    expect(inv).not.toContain("CashCountPanel");
    expect(inv).toContain("navigate(`/caixa?tab=");
    expect(caixaTabFrom("?tab=cash-check&case=4")).toBe("correcao");
    expect(caixaTabFrom("?tab=correcao")).toBe("correcao");
    expect(caixaTabFrom("")).toBe("dia"); // 29d: abre na caixa do dia
    const page = src("client/src/pages/CaixaPage.tsx");
    for (const p of ["CashCasesPanel", "CashCountPanel", "CashExternalPanel", "InitialPricesPanel", "CashCorrectionPanel"]) expect(page).toContain(`<${p} projectId={projectId} />`);
    expect(src("client/src/App.tsx")).toContain(`<Route path="/caixa">`);
    expect(src("docs/ajuda/caixa.md")).toContain("rotas: /caixa");
  });
});
