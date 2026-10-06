/**
 * P3 lote 29d — Caixa por dia e despesas do turno (Jorge, 6 out 2026):
 * "na caixa deve vir a caixa por dia, a que vem da Multipark: quem fechou, quem
 * não fechou, quem entregou, dividido por cidade, só os parques que operamos;
 * cada dia terá uma correção de caixa … quem tem acesso coloca o motivo, se
 * está correto ou não"; "a caixa deve ir às despesas e retirar as despesas
 * operacionais da noite pagas pelo team leader" e "na passagem de turno pode-se
 * colocar despesas do turno e elas entram diretamente para a caixa e para as
 * despesas".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDayCheckoutsSql, buildDayPaymentsSql, mapDayCheckout } from "./multiparkDb/cashDay";
import { assertReadOnlySql } from "./multiparkDb/client";
import { buildCashDayBoard, cityOfParkName, dayReviewProblem, isOperatedPark } from "./cashDay";
import { isOwnInvoiceKey, parseShiftCashSource, shiftCashSource, shiftExpensesTotal } from "./shiftExpenses";
import { MIGRATION_0470_STATEMENTS } from "./migrations/migration_0470";
import { caixaTabFrom } from "../shared/caixaTabs";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const range = { parkIds: ["pA", "pB"], start: "2026-10-04 23:00:00", end: "2026-10-05 23:00:00" };

describe("29d — leitura da Multipark (só leitura, com parâmetros)", () => {
  it("pagamentos do dia por parque e método; saídas do dia por condutor e estado do dinheiro", () => {
    const a = buildDayPaymentsSql(range);
    expect(a.sql).toContain(`z."recordedAt" >= $`);
    expect(a.sql).toContain("GROUP BY 1, 2");
    expect(a.params).toEqual(expect.arrayContaining(["pA", "pB", range.start, range.end]));
    const c = buildDayCheckoutsSql(range);
    for (const col of [`b."checkOutDriverName"`, `b."driverValidated"`, `b."cashierClosedByName"`, `b."cashValidated"`]) expect(c.sql).toContain(col);
    expect(c.sql).toContain(`b."status"::text = 'CHECKED_OUT'`);
    for (const q of [a, c]) expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(() => buildDayPaymentsSql({ ...range, parkIds: [] })).toThrow();
    expect(mapDayCheckout({ park_id: "pA", driver: "Rui", method: "Dinheiro", driver_ok: "f", closed: true, closed_by: "Ana", n: "2", paid: "40" }))
      .toMatchObject({ parkId: "pA", driver: "Rui", driverOk: false, closed: true, closedBy: "Ana", count: 2, paid: 40 });
  });

  it("só os parques que operamos; cidade pelo nome da cidade do parque", () => {
    expect(isOperatedPark({ id: "1", name: "Airpark Lisboa", ours: true })).toBe(true);
    expect(isOperatedPark({ id: "2", name: "Top Parking", ours: true })).toBe(false); // lista dos não operados (28a)
    expect(isOperatedPark({ id: "3", name: "Airpark Faro", ours: true }, ["3"])).toBe(false); // excluído em Definições
    expect(isOperatedPark({ id: "4", name: "Parque X", ours: false })).toBe(false);
    expect(cityOfParkName("Lisboa")).toBe("lisbon");
    expect(cityOfParkName("Faro")).toBe("faro");
    expect(cityOfParkName("Madrid")).toBeNull();
  });
});

describe("29d — a caixa do dia por cidade", () => {
  const board = buildCashDayBoard({
    parks: [{ id: "pA", name: "Airpark Lisboa", city: "lisbon" }, { id: "pB", name: "Redpark Lisboa", city: "lisbon" }, { id: "pF", name: "Airpark Faro", city: "faro" }],
    payments: [
      { parkId: "pA", method: "Dinheiro", amount: 300, count: 6 },
      { parkId: "pB", method: "Numerário", amount: 100, count: 2 },
      { parkId: "pA", method: "Multibanco", amount: 250, count: 5 },
      { parkId: "pA", method: "Stripe", amount: 500, count: 7 },
      { parkId: "pF", method: "Dinheiro", amount: 80, count: 1 },
    ],
    checkouts: [
      { parkId: "pA", driver: "Rui", method: "Dinheiro", driverOk: true, driverBy: "Rui", closed: true, closedBy: "Ana (TL)", validated: false, validatedBy: null, count: 4, paid: 200 },
      { parkId: "pA", driver: "Rui", method: "Dinheiro", driverOk: false, driverBy: null, closed: false, closedBy: null, validated: false, validatedBy: null, count: 1, paid: 50 },
      { parkId: "pB", driver: "Sara", method: "Multibanco", driverOk: false, driverBy: null, closed: true, closedBy: "Ana (TL)", validated: true, validatedBy: "BO", count: 3, paid: 90 },
    ],
    shiftExpenses: new Map([["lisbon", { total: 35.5, count: 2 }]]),
    counts: [{ parkId: "pA", counted: 330, expenses: 0 }, { parkId: "pB", counted: 30, expenses: 4.5 }],
    reviews: [{ city: "faro", status: "ok", reason: null, byName: "Jorge", at: "2026-10-06 09:00:00" }],
  });
  const lx = board.find((c) => c.city === "lisbon")!;

  it("recebido por método; tem de estar em dinheiro = dinheiro − despesas do turno − gastos da contagem", () => {
    expect(lx.receivedCash).toBe(400);
    expect(lx.byMethod.map((m) => [m.method, m.amount])).toEqual([["online", 500], ["cash", 400], ["card", 250]]);
    expect(lx.shiftExpenses).toBe(35.5);
    expect(lx.countExpenses).toBe(4.5);
    expect(lx.expectedCash).toBe(360);
    expect(lx.counted).toBe(360);
    expect(lx.difference).toBe(0);
  });

  it("por condutor: entregou ao líder? caixa fechada? e por quem", () => {
    const rui = lx.agents.find((a) => a.name === "Rui")!;
    expect(rui).toMatchObject({ bookings: 5, paid: 250, cashBookings: 5, cashPaid: 250, notDelivered: 1, notDeliveredPaid: 50, notClosed: 1, closedBy: ["Ana (TL)"] });
    const sara = lx.agents.find((a) => a.name === "Sara")!;
    expect(sara).toMatchObject({ cashBookings: 0, notDelivered: 0, notClosed: 0 }); // multibanco: não há dinheiro a entregar
    expect(lx.agents[0].name).toBe("Rui"); // quem tem dinheiro por entregar aparece primeiro
    expect(lx).toMatchObject({ closedBy: ["Ana (TL)"], notClosed: 1, notDelivered: 1, notDeliveredPaid: 50, review: null });
  });

  it("cada cidade à parte; sem contagem a diferença fica '—' (null), nunca 0", () => {
    const fa = board.find((c) => c.city === "faro")!;
    expect(fa).toMatchObject({ receivedCash: 80, expectedCash: 80, counted: null, difference: null, review: { status: "ok", byName: "Jorge" } });
    expect(board.find((c) => c.city === "porto")).toBeUndefined();
  });

  it("correção do dia: 'não certo' pede sempre motivo; 'certo' com diferença também", () => {
    expect(dayReviewProblem({ status: "not_ok", reason: "", difference: 0 })).toMatch(/motivo/);
    expect(dayReviewProblem({ status: "not_ok", reason: "Faltam 20 € do Rui", difference: -20 })).toBeNull();
    expect(dayReviewProblem({ status: "ok", reason: "", difference: 0 })).toBeNull();
    expect(dayReviewProblem({ status: "ok", reason: "", difference: null })).toBeNull();
    expect(dayReviewProblem({ status: "ok", reason: "", difference: 5 })).toMatch(/diferença/);
    expect(dayReviewProblem({ status: "ok", reason: "Troco devolvido ao cliente", difference: 5 })).toBeNull();
  });
});

describe("29d — despesas do turno (Passagem de turno → Despesas + caixa)", () => {
  it("marca da despesa do turno, talão só do próprio, total sem as anuladas", () => {
    expect(shiftCashSource("2026-10-05", "night", "lisbon")).toBe("shift:2026-10-05:night:lisbon");
    expect(parseShiftCashSource("shift:2026-10-05:night:lisbon")).toEqual({ day: "2026-10-05", shift: "night", city: "lisbon" });
    expect(parseShiftCashSource("outra:coisa")).toBeNull();
    expect(isOwnInvoiceKey(7, "invoices/7/123-talao.jpg")).toBe(true);
    expect(isOwnInvoiceKey(7, "invoices/8/123-talao.jpg")).toBe(false);
    expect(isOwnInvoiceKey(7, "invoices/7/../8/x.jpg")).toBe(false);
    expect(isOwnInvoiceKey(7, null)).toBe(true);
    expect(shiftExpensesTotal([{ amount: 10.1, status: "paid" }, { amount: 5, status: "cancelled" }, { amount: 2.2, status: "paid" }])).toBe(12.3);
  });

  it("entra nas Despesas paga, em dinheiro, no centro da cidade e com o talão; anular = cancelada (nunca apagada)", () => {
    const s = src("server/shiftExpenses.ts");
    expect(s).toContain(`paymentMethod: "cash",`);
    expect(s).toContain(`status: "paid",`);
    expect(s).toContain("cashSource: shiftCashSource(o.day, o.shift, o.city),");
    expect(s).toContain(`await db.update(expenses).set({ status: "cancelled" } as any)`);
    expect(s).not.toMatch(/db\.delete\(|DELETE FROM/);
    const r = src("server/routers.ts");
    const i = r.indexOf("addExpense: protectedProcedure");
    expect(r.slice(i, i + 900)).toContain(`requireAccess(ctx.user, "passagem_turno", "edit");`);
    expect(src("client/src/pages/ShiftHandoverPage.tsx")).toContain("<ShiftExpensesCard date={date} shift={shift} city={city} canEdit={canEdit}");
  });

  it("migração 0470: só acrescenta (coluna + 2 tabelas), registada", () => {
    expect(MIGRATION_0470_STATEMENTS.join(" ")).not.toMatch(/DROP|DELETE|TRUNCATE/);
    expect(MIGRATION_0470_STATEMENTS[0]).toContain("ADD COLUMN `cashSource`");
    expect(src("server/migrations/index.ts")).toContain(`["0470", () => import("./migration_0470")`);
  });
});

describe("29d — ecrã e permissões", () => {
  it("Caixa abre no 'Por dia'; a correção do dia pede Caixa → editar e fica registada", () => {
    expect(caixaTabFrom("")).toBe("dia");
    expect(caixaTabFrom("?tab=resumo")).toBe("resumo");
    const r = src("server/cashCheckRouter.ts");
    const i = r.indexOf("dayReview: protectedProcedure");
    expect(r.slice(i, i + 900)).toContain(`requireAccess(ctx.user, cashModuleFor(ctx.user, "edit"), "edit");`);
    expect(src("server/cashDay.ts")).toContain("INSERT INTO cash_day_review_log");
    const ui = src("client/src/components/cashCheck/CashDayBoard.tsx");
    for (const t of ["Tem de estar em dinheiro", "Despesas do turno", "Entregou ao líder", "Caixa fechada", "Dia certo", "Dia não certo"]) expect(ui, t).toContain(t);
  });
});
