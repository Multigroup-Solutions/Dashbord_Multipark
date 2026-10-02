import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ANNUAL_FIRST_YEAR, normalizeMonthRange, yearOptions } from "../shared/annualFilters";

// Aceitação do Anual (P2.3, 2 out 2026). Os números já vêm do motor das
// Finanças (getAnnualBreakdown → computeFinance); aqui o que a página mostra.

vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
vi.mock("./db", async (original) => ({ ...(await original<object>()), getUserPermissionOverrides: async () => ({}) }));

import { appRouter } from "./routers";

const page = () => readFileSync(resolve(import.meta.dirname, "..", "client/src/pages/AnnualPage.tsx"), "utf8");

describe("Anual — filtros", () => {
  it("anos a escolher: do próximo até 2016 (o histórico importado começa aí)", () => {
    const ys = yearOptions(2026);
    expect(ys[0]).toBe(2027);
    expect(ys[ys.length - 1]).toBe(ANNUAL_FIRST_YEAR);
    expect(ys).toHaveLength(2027 - 2016 + 1);
  });

  it("'De' nunca fica depois de 'Até': acompanha o que se mudou", () => {
    expect(normalizeMonthRange(3, 9, "from")).toEqual({ from: 3, to: 9 });
    expect(normalizeMonthRange(10, 9, "from")).toEqual({ from: 10, to: 10 });
    expect(normalizeMonthRange(3, 2, "to")).toEqual({ from: 2, to: 2 });
  });
});

describe("Anual — página", () => {
  it("erro ≠ ano a zero: mostra o porquê e deixa tentar de novo; a comparação também avisa", () => {
    const src = page();
    expect(src).toContain(") : error ? (");
    expect(src).toContain("Não foi possível calcular o ano.");
    expect(src).toContain("Não foi possível carregar {compareYear} para comparar");
    expect(src).toMatch(/count < 2 && !\["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"\]/);
  });

  it("o ano escolhe-se numa lista (já não pede o cálculo a cada tecla)", () => {
    const src = page();
    expect(src).not.toMatch(/type="number"\s+value=\{(year|compareYear)\}/);
    expect(src).toContain("years.map((y) => <SelectItem");
    expect(src).toContain('setRange(parseInt(v), toMonth, "from")');
    expect(src).toContain('setRange(fromMonth, parseInt(v), "to")');
  });

  it("IVA sem '23%' escrito à mão (a taxa vem das Definições e, nas despesas, da categoria)", () => {
    const src = page();
    expect(src).not.toContain("23% das");
    expect(src).toContain("IVA dedutível (nas despesas, à taxa de cada categoria)");
  });

  it("não reordena os meses no próprio estado durante o render", () => {
    expect(page()).toContain("[...months].sort(");
  });
});

describe("annual.breakdown", () => {
  const caller = () => appRouter.createCaller({ user: { id: 1, role: "super_admin" }, req: { headers: {} }, res: {} } as any);
  it("ano inválido → BAD_REQUEST (antes chegava ao motor e dava erro interno)", async () => {
    await expect(caller().annual.breakdown({ year: 2 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().annual.breakdown({ year: 2025.5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
