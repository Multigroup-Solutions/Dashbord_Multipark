import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { annualExportSheets, assertCanExportFinance, billingExportSheets, sheetsToFile } from "./export";
import { can, ROLES } from "../../shared/access";
import { defaultCategoryFlags } from "../../shared/financeCategories";
import { MIGRATION_0110_STATEMENTS, IDEMPOTENT_ERROR_CODES_0110 } from "../migrations/migration_0110";

describe("exportação — porta (ação export da Faturação)", () => {
  it("só quem tem faturacao:x exporta; admin (sem Faturação) é recusado", () => {
    expect(() => assertCanExportFinance({ id: 1, role: "super_admin" })).not.toThrow();
    for (const role of ["admin", "backoffice", "supervisor", "user"]) {
      expect(() => assertCanExportFinance({ id: 1, role })).toThrow();
    }
    expect(() => assertCanExportFinance(null)).toThrow();
    expect(ROLES.filter((r) => can(r, "faturacao", "export"))).toEqual(["super_admin"]);
  });
  it("Anual: só super_admin (admin deixou de o ter)", () => {
    expect(ROLES.filter((r) => can(r, "anual", "view"))).toEqual(["super_admin"]);
  });
});

const billing = {
  summary: {
    collected: 100, collectedCount: 1, produced: 1230, producedNoVat: 1000, producedCount: 2,
    expensesPaid: 123, expensesPaidNoVat: 100, salariesCost: 300, employerTax: 70, extrasDiaCost: 10,
    salesCommissions: 5, operationalCommissions: 0, totalCostsNoVat: 485, marginNet: 515, marginPct: 51.5,
    expensesPending: 0, vatRate: 0.23, tsuEmployerRate: 0.2375,
    projection: { applies: true, revenueNet: 2000, costsNet: 900, margin: 1100 },
    quality: { excludedExpenses: { total: 3000, count: 2, categories: [{ name: "Recursos Humanos", total: 3000 }] }, bookingsWithoutProject: { count: 1, total: 50 }, inactiveWithoutContractEnd: [{ employeeId: 1, fullName: "Ana", assumedEnd: "2026-08-10" }] },
  },
  timeseries: [{ bucket: "2026-08-01", produced: 1230, producedNet: 1000, collected: 100, expensesNet: 100, salaries: 370, partners: 5, extrasCost: 10, totalCost: 485, margin: 515, revenueForecast: 0, costForecast: 0, marginForecast: 515 }],
  deliveries: [{ projectName: "Porto; A", count: 2, extrasRevenue: 0, totalRevenue: 1230 }],
  salesCommissions: [{ partnerName: "Ag", projectName: "Porto", bookingsCount: 1, revenueGross: 123, revenueNet: 100, commissionBase: "net", commissionRate: 5, commission: 5 }],
};

describe("exportação — conteúdo", () => {
  it("Faturação: cartões, série e detalhe com os mesmos números do ecrã", () => {
    const sheets = billingExportSheets(billing, { from: "2026-08-01", to: "2026-08-31" });
    const resumo = sheets.find((s) => s.name === "Resumo")!.rows;
    expect(resumo).toContainEqual(["Margem (s/ IVA)", 515]);
    expect(resumo).toContainEqual(["Fecho previsto — margem", 1100]);
    expect(sheets.find((s) => s.name === "Série")!.rows[1][0]).toBe("2026-08-01");
    expect(sheets.find((s) => s.name === "Comissões venda")!.rows[1]).toContain("s/ IVA");
    const q = sheets.find((s) => s.name === "Qualidade")!.rows;
    expect(q[1]).toEqual(["Despesas excluídas da margem", 3000, "Recursos Humanos: 3000"]);
    expect(q.find((r) => r[0] === "Inativos sem fim de contrato")![2]).toContain("Ana");
  });
  it("CSV com ';', vírgula decimal, aspas quando preciso e BOM; XLSX legível", () => {
    const sheets = billingExportSheets(billing, { from: "2026-08-01", to: "2026-08-31" });
    const csv = Buffer.from(sheetsToFile(sheets, "csv", "f").base64, "base64").toString("utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("Margem %;51,5");
    expect(csv).toContain('"Porto; A";2;0;1230');
    const x = sheetsToFile(sheets, "xlsx", "f");
    expect(x.filename).toBe("f.xlsx");
    const wb = XLSX.read(Buffer.from(x.base64, "base64"), { type: "buffer" });
    expect(wb.SheetNames).toContain("Resumo");
  });
  it("Anual: meses futuros sem lucro realizado (só fecho previsto)", () => {
    const months = [
      { month: 7, status: "past", revenueWithVat: 123, revenueNoVat: 100, totalCosts: 50, profit: 50, forecastProfit: 50 },
      { month: 9, status: "current", revenueWithVat: 0, revenueNoVat: 0, totalCosts: 20, profit: -20, forecastProfit: 30 },
      { month: 12, status: "future", revenueWithVat: 0, revenueNoVat: 0, totalCosts: 0, profit: 0, forecastProfit: -10 },
    ];
    const rows = annualExportSheets(months, { year: 2026 })[0].rows;
    const dez = rows.find((r) => r[0] === "Dezembro")!;
    expect(dez[1]).toBe("Previsto");
    expect(dez[14]).toBeNull();
    expect(dez[15]).toBe(-10);
    expect(rows[rows.length - 1][14]).toBe(30);   // total do lucro só com meses realizados/em curso
  });
});

describe("categorias: flags por omissão (sem maiúsculas nem acentos)", () => {
  it("RH, salários, TSU/Segurança Social e extras ficam fora da margem", () => {
    for (const n of ["Salários", "SALARIOS", "Recursos Humanos", "RH", "TSU", "Segurança Social", "Extras"]) {
      expect(defaultCategoryFlags(n).excludeFromMargin).toBe(true);
    }
    for (const n of ["Rendas", "TI", "TRHotel", "Combustível"]) expect(defaultCategoryFlags(n).excludeFromMargin).toBe(false);
  });
  it("Marketing / Publicidade (Google/Meta) em autoliquidação", () => {
    for (const n of ["Marketing", "Publicidade", "Google Ads", "Meta Ads", "Anúncios"]) expect(defaultCategoryFlags(n).reverseCharge).toBe(true);
    expect(defaultCategoryFlags("Rendas").reverseCharge).toBe(false);
  });
  it("migração 0110: idempotente e os UPDATE só tocam em linhas por decidir (NULL)", () => {
    expect(IDEMPOTENT_ERROR_CODES_0110.has("ER_DUP_FIELDNAME")).toBe(true);
    for (const st of MIGRATION_0110_STATEMENTS.filter((x) => x.trim().startsWith("UPDATE"))) {
      expect(st).toMatch(/WHERE `(excludeFromMargin|reverseCharge)` IS NULL/);
    }
    expect(MIGRATION_0110_STATEMENTS.join("\n")).toContain("`commissionBase` VARCHAR(8) NOT NULL DEFAULT 'net'");
  });
});
