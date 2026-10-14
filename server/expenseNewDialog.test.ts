/**
 * Nova Despesa (Jorge, 14 out 2026): pago ao lançar (só admin+), nomes das
 * categorias + Sinistros, "quem comprou" só team leader e acima, e os 5
 * centros de custos fixos no topo.
 */
import { describe, expect, it } from "vitest";
import { canMarkPaidOnCreate, defaultCreatePaymentMethod, isFuturePaidAt, paymentOnCreate } from "../shared/expenseCreatePayment";
import { fixCategoryName, orderExpenseCategories, planCategoryFixes, SINISTROS_CATEGORY } from "../shared/expenseCategories";
import { expenseBuyerOptions, isExpenseBuyerEligible } from "../shared/expenseBuyers";
import { costCentrePath, costCentreTreeRows, defaultExpandedCostCentres, pinnedCostCentres, searchCostCentres, selectableCostCentres } from "../shared/costCentrePicker";
import { defaultCategoryFlags } from "../shared/financeCategories";

describe("pago ao lançar", () => {
  it("só admin e super admin", () => {
    expect(canMarkPaidOnCreate("admin")).toBe(true);
    expect(canMarkPaidOnCreate("super_admin")).toBe(true);
    for (const r of ["backoffice", "frontoffice", "supervisor", "team_leader", "condutor", "extra", "user", "", null, undefined]) {
      expect(canMarkPaidOnCreate(r as any)).toBe(false);
    }
  });
  it("o método começa vazio para admin+ e em Cartão para os outros (como antes)", () => {
    expect(defaultCreatePaymentMethod("admin")).toBe("");
    expect(defaultCreatePaymentMethod("super_admin")).toBe("");
    expect(defaultCreatePaymentMethod("backoffice")).toBe("card");
    expect(defaultCreatePaymentMethod("team_leader")).toBe("card");
  });
  it("admin com método → paga na data de vencimento, se houver", () => {
    expect(paymentOnCreate({ role: "admin", paymentMethod: "transfer", expenseDate: "2026-10-01 00:00:00", paymentDueDate: "2026-10-10 00:00:00" }))
      .toEqual({ status: "paid", paidAt: "2026-10-10" });
  });
  it("admin com método sem vencimento → paga na data da despesa", () => {
    expect(paymentOnCreate({ role: "super_admin", paymentMethod: "card", expenseDate: "2026-10-01", paymentDueDate: null }))
      .toEqual({ status: "paid", paidAt: "2026-10-01" });
    expect(paymentOnCreate({ role: "super_admin", paymentMethod: "cash", expenseDate: "2026-10-01", paymentDueDate: "" }))
      .toEqual({ status: "paid", paidAt: "2026-10-01" });
  });
  it("admin sem método → pendente (como hoje)", () => {
    for (const m of [null, undefined, "", "none", "bitcoin"]) {
      expect(paymentOnCreate({ role: "admin", paymentMethod: m as any, expenseDate: "2026-10-01" })).toEqual({ status: "pending", paidAt: null });
    }
  });
  it("data futura = depois de hoje em Lisboa", () => {
    const now = new Date("2026-10-14T23:30:00Z"); // já é dia 15 em Lisboa (UTC+1)
    expect(isFuturePaidAt("2026-10-15", now)).toBe(false);
    expect(isFuturePaidAt("2026-10-16", now)).toBe(true);
    expect(isFuturePaidAt("2026-10-01 00:00:00", now)).toBe(false);
    expect(isFuturePaidAt(null, now)).toBe(false);
  });
  it("conta desativada: o papel não conta", () => {
    expect(isExpenseBuyerEligible({ position: "driver", isActive: 1, accountRole: "team_leader", accountActive: 0 })).toBe(false);
    expect(isExpenseBuyerEligible({ position: "supervisor", isActive: 1, accountRole: "condutor", accountActive: 0 })).toBe(true);
  });
  it("outros papéis nunca ficam pagos por esta via, mesmo com método", () => {
    for (const r of ["backoffice", "supervisor", "team_leader", "condutor"]) {
      expect(paymentOnCreate({ role: r, paymentMethod: "card", expenseDate: "2026-10-01", paymentDueDate: "2026-10-05" })).toEqual({ status: "pending", paidAt: null });
    }
  });
});

describe("categorias: nomes certos + Sinistros", () => {
  it("corrige acentos em falta, mantendo as maiúsculas", () => {
    expect(fixCategoryName("Combustivel")).toBe("Combustível");
    expect(fixCategoryName("Manutencao")).toBe("Manutenção");
    expect(fixCategoryName("Manutençao")).toBe("Manutenção");
    expect(fixCategoryName("Agua")).toBe("Água");
    expect(fixCategoryName("Material de Escritorio")).toBe("Material de Escritório");
    expect(fixCategoryName("Telecomunicacoes")).toBe("Telecomunicações");
    expect(fixCategoryName("Comissoes bancarias")).toBe("Comissões bancárias");
    expect(fixCategoryName("ALIMENTACAO")).toBe("ALIMENTAÇÃO");
    expect(fixCategoryName("  Servicos   de  limpeza ")).toBe("Serviços de limpeza");
    expect(fixCategoryName("Electricidade")).toBe("Eletricidade");
  });
  it("não mexe no que já está certo nem em siglas", () => {
    for (const n of ["Combustível", "Recursos Humanos", "TI", "RH", "Despesas Operacionais", "Outros", "Bancos", "Terminal", "Seguros", "Impostos", "Rendas"]) {
      expect(fixCategoryName(n)).toBe(n);
    }
  });
  it("renomeia por id; se o nome certo já existe noutra, fica como está (nada se junta nem apaga)", () => {
    const plan = planCategoryFixes([
      { id: 1, name: "Combustivel" }, { id: 2, name: "Agua" }, { id: 3, name: "Água" }, { id: 4, name: "Outros" },
    ]);
    expect(plan.renames).toEqual([{ id: 1, from: "Combustivel", to: "Combustível" }]);
    expect(plan.skipped).toEqual([{ id: 2, from: "Agua", to: "Água" }]);
    expect(plan.addSinistros).toBe(true);
  });
  it("Sinistros só se acrescenta uma vez (e não conta como excluída da margem)", () => {
    expect(planCategoryFixes([{ id: 1, name: "Sinistros" }]).addSinistros).toBe(false);
    expect(planCategoryFixes([{ id: 1, name: "sinistro" }]).addSinistros).toBe(false);
    expect(defaultCategoryFlags(SINISTROS_CATEGORY.name)).toEqual({ excludeFromMargin: false, reverseCharge: false });
  });
  it("a ordem de sempre (alfabética, sem contar acentos) com Sinistros no sítio certo", () => {
    const names = ["Água", "Alimentação", "Bancos", "Combustível", "Eletricidade", "Impostos", "Manutenção", "Marketing", "Material de Escritório",
      "Outros", "Recursos Humanos", "Rendas", "Seguros", "Sinistros", "Tecnologia", "Telecomunicações", "Terminal", "TI", "Transportes"];
    const shuffled = [...names].reverse().map((name, i) => ({ id: i + 1, name }));
    expect(orderExpenseCategories(shuffled).map((c) => c.name)).toEqual(names);
    const ordered = orderExpenseCategories(shuffled).map((c) => c.name);
    expect(ordered.indexOf("Sinistros")).toBe(ordered.indexOf("Seguros") + 1);
  });
});

describe("quem comprou: só team leader e acima", () => {
  it("pelo cargo da ficha ou pelo papel da conta", () => {
    expect(isExpenseBuyerEligible({ position: "team_leader", isActive: 1 })).toBe(true);
    expect(isExpenseBuyerEligible({ position: "supervisor", isActive: 1 })).toBe(true);
    expect(isExpenseBuyerEligible({ position: "director", isActive: 1 })).toBe(true);
    expect(isExpenseBuyerEligible({ position: "driver", isActive: 1, accountRole: "team_leader" })).toBe(true);
    expect(isExpenseBuyerEligible({ position: "driver", isActive: 1, accountRole: "admin" })).toBe(true);
  });
  it("extras, condutores e fichas inativas ficam de fora", () => {
    expect(isExpenseBuyerEligible({ position: "extra", isActive: 1, accountRole: "extra" })).toBe(false);
    expect(isExpenseBuyerEligible({ position: "driver", isActive: 1, accountRole: "condutor" })).toBe(false);
    expect(isExpenseBuyerEligible({ position: "senior_driver", isActive: 1 })).toBe(false);
    expect(isExpenseBuyerEligible({ position: "team_leader", isActive: 0 })).toBe(false);
  });
  it("por ordem alfabética (sem contar acentos)", () => {
    const out = expenseBuyerOptions([
      { id: 1, fullName: "Rui Costa", position: "team_leader", isActive: 1 },
      { id: 2, fullName: "Extra 12", position: "extra", isActive: 1 },
      { id: 3, fullName: "Álvaro Lima", position: "supervisor", isActive: 1 },
      { id: 4, fullName: "Bruno Sá", position: "driver", isActive: 1, accountRole: "team_leader" },
      { id: 5, fullName: "Carla", position: "driver", isActive: 1 },
    ]);
    expect(out).toEqual([{ id: 3, fullName: "Álvaro Lima" }, { id: 4, fullName: "Bruno Sá" }, { id: 1, fullName: "Rui Costa" }]);
  });
});

describe("centro de custos: os 5 do dia a dia no topo", () => {
  // Hierarquia real (set 2026): Grupo → Cidade → Marca → Parque; Marketplace é marca em cada cidade
  const P = [
    { id: 48, name: "Multipark", level: "group", parentId: null },
    { id: 49, name: "Lisboa", level: "city", parentId: 48 },
    { id: 50, name: "Porto", level: "city", parentId: 48 },
    { id: 51, name: "Faro", level: "city", parentId: 48 },
    { id: 52, name: "Airpark", level: "brand", parentId: 49 },
    { id: 60, name: "Airpark Lisboa", level: "project", parentId: 52 },
    { id: 84, name: "Marketplace", level: "brand", parentId: 50 },
    { id: 92, name: "Marketplace", level: "brand", parentId: 51 },
    { id: 93, name: "Marketplace", level: "brand", parentId: 49 },
    { id: 99, name: "Antigo", level: "project", parentId: 49, isActive: 0 },
  ];
  it("Multipark, Lisboa, Porto, Faro e Marketplace (um por cidade quando há vários)", () => {
    expect(pinnedCostCentres(P).map((p) => [p.id, p.label])).toEqual([
      [48, "Multipark"], [49, "Lisboa"], [50, "Porto"], [51, "Faro"],
      [93, "Marketplace · Lisboa"], [84, "Marketplace · Porto"], [92, "Marketplace · Faro"],
    ]);
  });
  it("um só Marketplace → só 'Marketplace'; o que o utilizador não vê não aparece", () => {
    const porto = P.filter((n) => [50, 84].includes(n.id));
    expect(pinnedCostCentres(porto).map((p) => p.label)).toEqual(["Porto", "Marketplace"]);
  });
  it("árvore: grupo e cidades abertos por omissão; desativados escondidos salvo o escolhido", () => {
    const nodes = selectableCostCentres(P);
    expect(nodes.some((n) => n.id === 99)).toBe(false);
    expect(selectableCostCentres(P, 99).some((n) => n.id === 99)).toBe(true);
    const rows = costCentreTreeRows(nodes, defaultExpandedCostCentres(nodes));
    expect(rows.map((r) => r.node.id)).toEqual([48, 51, 92, 49, 52, 93, 50, 84]);
    expect(rows.find((r) => r.node.id === 52)).toMatchObject({ depth: 2, hasChildren: true, open: false });
  });
  it("a pesquisa procura na árvore toda (sem acentos), mesmo nos fechados", () => {
    expect(searchCostCentres(P, "airpark lisboa").map((r) => r.node.id)).toEqual([52, 60]);
    expect(searchCostCentres(P, "porto market").map((r) => r.node.id)).toEqual([84]);
    expect(costCentrePath(P[5], P)).toBe("Lisboa › Airpark › Airpark Lisboa");
    expect(searchCostCentres(P, "")).toEqual([]);
  });
});
