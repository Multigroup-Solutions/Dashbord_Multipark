import { describe, expect, it } from "vitest";
import { parseExpenseAmount, sumAmounts } from "../shared/expenseAmount";
import { comparePeriods, dayBounds, dayToMysql, isIsoDay } from "../shared/expensePeriods";
import { expenseTotals } from "../shared/expenseTotals";
import {
  canSeeAggregates,
  canSeeExpense,
  resolveExpenseVisibility,
  type VisibilityDeps,
} from "./expenseScope";

// ─── valores ──────────────────────────────────────────────────────────────────
describe("parseExpenseAmount", () => {
  it("aceita os formatos PT e devolve 2 casas com ponto", () => {
    expect(parseExpenseAmount("45,90")).toBe("45.90");
    expect(parseExpenseAmount("45.90 €")).toBe("45.90");
    expect(parseExpenseAmount("1.234,56")).toBe("1234.56");
    expect(parseExpenseAmount("1 234,56")).toBe("1234.56");
    expect(parseExpenseAmount("1,234.56")).toBe("1234.56");
    expect(parseExpenseAmount("1234.5")).toBe("1234.50");
    expect(parseExpenseAmount(12)).toBe("12.00");
  });
  it("recusa zero, negativos, 3 casas e lixo", () => {
    expect(parseExpenseAmount("0")).toBeNull();
    expect(parseExpenseAmount("-5")).toBeNull();
    expect(parseExpenseAmount("1.999")).toBeNull();
    expect(parseExpenseAmount("abc")).toBeNull();
    expect(parseExpenseAmount("")).toBeNull();
    expect(parseExpenseAmount(null)).toBeNull();
  });
  it("soma em cêntimos sem erro de vírgula flutuante", () => {
    expect(sumAmounts(["0.10", "0.20"])).toBe(0.3);
    expect(sumAmounts(["100", null, "", "40.50"])).toBe(140.5);
  });
});

// ─── períodos ─────────────────────────────────────────────────────────────────
describe("dayBounds / isIsoDay", () => {
  it("inclui o último dia por inteiro", () => {
    expect(dayBounds("2026-09-01", "2026-09-09")).toEqual({ start: "2026-09-01 00:00:00", end: "2026-09-09 23:59:59" });
    expect(dayBounds(undefined, "2026-09-09")).toEqual({ end: "2026-09-09 23:59:59" });
    expect(dayBounds()).toEqual({});
  });
  it("recusa datas inválidas e intervalos invertidos", () => {
    expect(() => dayBounds("2026-13-01")).toThrow();
    expect(() => dayBounds("2026-02-30")).toThrow();
    expect(() => dayBounds("2026-09-10", "2026-09-01")).toThrow();
    expect(isIsoDay("2024-02-29")).toBe(true);
    expect(isIsoDay("2023-02-29")).toBe(false);
    expect(dayToMysql("2026-09-09")).toBe("2026-09-09 00:00:00");
  });
});

describe("comparePeriods", () => {
  it("mês até hoje vs mesmos dias do mês anterior", () => {
    const p = comparePeriods("2026-09-09");
    expect(p.a).toMatchObject({ from: "2026-09-01", to: "2026-09-09" });
    expect(p.b).toMatchObject({ from: "2026-08-01", to: "2026-08-09" });
  });
  it("limita o dia ao fim do mês anterior (31 mar → 28 fev)", () => {
    const p = comparePeriods("2026-03-31");
    expect(p.b).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
  });
  it("atravessa o ano e suporta homólogo", () => {
    expect(comparePeriods("2026-01-15").b).toMatchObject({ from: "2025-12-01", to: "2025-12-15" });
    expect(comparePeriods("2026-09-09", "month_to_date", 12).b).toMatchObject({ from: "2025-09-01", to: "2025-09-09" });
  });
  it("meses completos", () => {
    const p = comparePeriods("2026-09-09", "full_months");
    expect(p.a).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(p.b).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
  });
});

// ─── totais ───────────────────────────────────────────────────────────────────
describe("expenseTotals", () => {
  it("deixa as canceladas fora do total e conta-as à parte", () => {
    const t = expenseTotals([
      { amount: "100.00", status: "pending" },
      { amount: "40.72", status: "paid" },
      { amount: "3.00", status: "cancelled" },
      { amount: "10", status: "overdue" },
    ]);
    expect(t.total).toBe(150.72);
    expect(t.pending).toBe(100);
    expect(t.paid).toBe(40.72);
    expect(t.overdue).toBe(10);
    expect(t.cancelled).toBe(3);
    expect(t.count).toBe(3);
    expect(t.cancelledCount).toBe(1);
  });
});

// ─── visibilidade ─────────────────────────────────────────────────────────────
function deps(over: Partial<VisibilityDeps> = {}): VisibilityDeps {
  return {
    denied: async () => false,
    employeeProjectId: async () => 10,
    resolveProjectIds: async (id) => (id === 10 ? [10, 11, 12] : [id]),
    ...over,
  };
}

describe("resolveExpenseVisibility", () => {
  it("admin vê tudo; com deny de totais só as suas", async () => {
    expect(await resolveExpenseVisibility({ id: 1, role: "admin" }, deps())).toEqual({ kind: "all" });
    expect(await resolveExpenseVisibility({ id: 1, role: "super_admin" }, deps())).toEqual({ kind: "all" });
    const v = await resolveExpenseVisibility({ id: 7, role: "admin" }, deps({ denied: async (_u, p) => p === "finance.view_totals" }));
    expect(v).toEqual({ kind: "own", userId: 7 });
  });
  it("supervisor: as suas + centro de custos COM descendentes", async () => {
    const v = await resolveExpenseVisibility({ id: 5, role: "supervisor" }, deps());
    expect(v).toEqual({ kind: "own_or_projects", userId: 5, projectIds: [10, 11, 12] });
  });
  it("supervisor sem ficha: só as suas", async () => {
    const v = await resolveExpenseVisibility({ id: 5, role: "supervisor" }, deps({ employeeProjectId: async () => null }));
    expect(v).toEqual({ kind: "own_or_projects", userId: 5, projectIds: [] });
    expect(canSeeExpense(v, { insertedById: 5, projectId: 99 })).toBe(true);
    expect(canSeeExpense(v, { insertedById: 6, projectId: 10 })).toBe(false);
  });
  it("backoffice/team_leader: só as próprias; frontoffice/extra: nada", async () => {
    expect(await resolveExpenseVisibility({ id: 3, role: "backoffice" }, deps())).toEqual({ kind: "own", userId: 3 });
    expect(await resolveExpenseVisibility({ id: 3, role: "team_leader" }, deps())).toEqual({ kind: "own", userId: 3 });
    expect(await resolveExpenseVisibility({ id: 3, role: "frontoffice" }, deps())).toEqual({ kind: "none" });
    expect(await resolveExpenseVisibility({ id: 3, role: "extra" }, deps())).toEqual({ kind: "none" });
  });
});

describe("canSeeExpense / canSeeAggregates", () => {
  it("aplica a mesma regra a uma linha (detalhe/documento)", () => {
    const sup = { kind: "own_or_projects" as const, userId: 5, projectIds: [10, 11] };
    expect(canSeeExpense(sup, { insertedById: 9, projectId: 11 })).toBe(true);   // Redpark Lisboa ⊂ Lisboa
    expect(canSeeExpense(sup, { insertedById: 9, projectId: 30 })).toBe(false);
    expect(canSeeExpense({ kind: "own", userId: 5 }, { insertedById: 5, projectId: null })).toBe(true);
    expect(canSeeExpense({ kind: "none" }, { insertedById: 5, projectId: 10 })).toBe(false);
    expect(canSeeExpense({ kind: "all" }, { insertedById: 1, projectId: null })).toBe(true);
  });
  it("totais só para quem vê além das próprias", () => {
    expect(canSeeAggregates({ kind: "all" })).toBe(true);
    expect(canSeeAggregates({ kind: "own_or_projects", userId: 1, projectIds: [] })).toBe(true);
    expect(canSeeAggregates({ kind: "own", userId: 1 })).toBe(false);
    expect(canSeeAggregates({ kind: "none" })).toBe(false);
  });
});
