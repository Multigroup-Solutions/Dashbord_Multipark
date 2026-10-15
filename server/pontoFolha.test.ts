/**
 * Folha de ordenados × fichas da mesma pessoa (setembro de 2026: as horas da
 * 2.ª quinzena ficaram noutra ficha). Corre `computePayrollForMonth` com uma
 * BD falsa (devolve as linhas preparadas por tabela; os filtros SQL não se
 * testam aqui) para ver o que a folha faz com essas linhas:
 *  - as horas das duas fichas aparecem, cada turno uma só vez, e somam o mesmo
 *    que o ponto (`pontoMonthSummary`);
 *  - ficha inativa de extra paga à hora; de salário, só até à desativação (nunca
 *    o mês inteiro a dobrar);
 *  - o mesmo tempo picado nas duas fichas fica avisado nas duas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { employeeLeaves, employeeSalaryHistory, employees, extraRates, schedules, timeRecords } from "../drizzle/schema";
import { pontoMonthSummary } from "./payroll/shifts";

type Emp = Record<string, any>;
type Rec = { id: number; employeeId: number; type: "check_in" | "check_out"; recordedAt: string; hoursWorked?: string | null; notes?: string | null; reviewStatus?: string | null; terminalStatus?: null; terminalUntil?: null };

const state: { emps: Emp[]; recs: Rec[]; aliases: Array<{ userId: number; employeeId: number }> } = { emps: [], recs: [], aliases: [] };

function fakeDb() {
  const builder = (fields: unknown) => {
    const q = { table: null as unknown, joined: false, grouped: false };
    const rows = (): any[] => {
      if (q.table === timeRecords && q.grouped) {
        // entradas por ficha (o mês inteiro está nas linhas preparadas)
        const m = new Map<number, number>();
        for (const r of state.recs) if (r.type === "check_in" && r.recordedAt >= "2026-08-31 23:00:00" && r.recordedAt < "2026-09-30 23:00:00") m.set(r.employeeId, (m.get(r.employeeId) ?? 0) + 1);
        return [...m].map(([id, checkIns]) => ({ id, checkIns }));
      }
      if (q.table === timeRecords) return [...state.recs].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id - b.id));
      if (q.table === employees && q.joined) return state.emps.map((e) => ({ employee: e, project: null }));
      if (q.table === employees) return state.emps.map((e) => ({ id: e.id, fullName: e.fullName, isActive: e.isActive, userId: e.userId }));
      if (q.table === extraRates) return [{ level: 1, levelName: "junior", hourlyRate: "5.00" }];
      if (q.table === employeeSalaryHistory || q.table === employeeLeaves || q.table === schedules) return [];
      return [];
    };
    const b: any = {
      from: (t: unknown) => { q.table = t; return b; },
      leftJoin: () => { q.joined = true; return b; },
      innerJoin: () => b,
      where: () => b,
      orderBy: () => b,
      groupBy: () => { q.grouped = true; return b; },
      then: (ok: (v: any[]) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(rows()).then(ok, ko),
    };
    void fields;
    return b;
  };
  return { select: builder, execute: async () => [state.aliases] };
}

vi.mock("./db", () => ({ getDb: async () => fakeDb(), resolveProjectIds: async () => [] }));
vi.mock("./pontoTerminal", () => ({ pontoTerminalEnabled: async () => false }));

const { computePayrollForMonth } = await import("./payroll/payrollData");

const emp = (o: Partial<Emp> & { id: number }): Emp => ({
  fullName: `Ficha ${o.id}`, position: "extra", extraLevel: 1, contractStart: null, contractEnd: null, isActive: 1,
  monthlySalary: null, mealAllowancePerDay: null, userId: null, deactivatedAt: null, department: null, projectId: null, nif: null, nib: null, ...o,
});
let nextId = 1;
/** turno de 8 h que começa às `h` (UTC) do dia `day` */
const shift = (employeeId: number, day: string, h = 7, extra: Partial<Rec> = {}): Rec[] => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    { id: nextId++, employeeId, type: "check_in", recordedAt: `${day} ${pad(h)}:00:00` },
    { id: nextId++, employeeId, type: "check_out", recordedAt: `${day} ${pad(h + 8)}:00:00`, ...extra },
  ];
};
const daysFrom = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `2026-09-${String(a + i).padStart(2, "0")}`);

beforeEach(() => { state.emps = []; state.recs = []; state.aliases = []; nextId = 1; });

describe("folha de setembro: a conta picou em duas fichas (A até dia 14, B a partir de 15)", () => {
  it("as horas aparecem todas, cada turno uma vez, e as duas linhas avisam", async () => {
    state.emps = [
      emp({ id: 10, fullName: "Ariana (RH)", userId: 500 }),
      emp({ id: 77, fullName: "Ariana (antiga)", userId: 500, isActive: 0, deactivatedAt: "2026-06-01 10:00:00" }),
    ];
    state.recs = [...daysFrom(1, 14).flatMap((d) => shift(10, d)), ...daysFrom(15, 30).flatMap((d) => shift(77, d))];
    const rows = await computePayrollForMonth(2026, 9);
    const a = rows.find((r) => r.employeeId === 10)!, b = rows.find((r) => r.employeeId === 77)!;
    expect(a.totalHours).toBe(14 * 8);
    expect(b.totalHours).toBe(16 * 8);
    // cada turno uma vez: a soma das duas fichas = o ponto da pessoa toda
    const all = pontoMonthSummary(state.recs.map((r) => ({ ...r })), "2026-09-01", "2026-09-30");
    expect(a.totalHours + b.totalHours).toBe(all.totalHours);
    // extra inativa: paga à hora o que picou (5 €/h)
    expect(b.extraPayment).toBe(16 * 8 * 5);
    expect(a.warnings.join(" ")).toMatch(/picou o ponto também em #77 Ariana \(antiga\) \(16 entrada\(s\)\)/);
    expect(b.warnings.join(" ")).toMatch(/ficha inativa com 16 entrada\(s\)/);
    expect(b.warnings.join(" ")).toMatch(/picou o ponto também em #10 Ariana \(RH\) \(14 entrada\(s\)\)/);
  });

  it("a mesma conta pela conta extra (employee_accounts) também avisa", async () => {
    state.emps = [emp({ id: 10, userId: 500 }), emp({ id: 77, userId: 900, isActive: 0 })];
    state.aliases = [{ userId: 500, employeeId: 77 }];
    state.recs = [...shift(10, "2026-09-02"), ...shift(77, "2026-09-20")];
    const rows = await computePayrollForMonth(2026, 9);
    expect(rows.find((r) => r.employeeId === 10)!.warnings.join(" ")).toMatch(/também em #77/);
  });

  it("o mesmo tempo picado nas duas fichas → aviso de horas em duplicado nas duas", async () => {
    state.emps = [emp({ id: 10, userId: 500 }), emp({ id: 77, userId: 500, isActive: 0 })];
    state.recs = [...shift(10, "2026-09-20", 7), ...shift(77, "2026-09-20", 9)];
    const rows = await computePayrollForMonth(2026, 9);
    expect(rows.find((r) => r.employeeId === 10)!.warnings.join(" ")).toMatch(/o mesmo tempo está picado também na ficha #77 .*\(6 h sobrepostas\)/);
    expect(rows.find((r) => r.employeeId === 77)!.warnings.join(" ")).toMatch(/o mesmo tempo está picado também na ficha #10/);
  });
});

describe("ficha inativa de salário que entra pelas picagens: nunca o mês inteiro", () => {
  const salaried = { position: "driver", monthlySalary: "900.00", mealAllowancePerDay: "6.00" };
  it("desativada a 15 de setembro → salário até dia 15, com aviso", async () => {
    state.emps = [emp({ id: 20, userId: 600, isActive: 0, deactivatedAt: "2026-09-15 10:00:00", ...salaried })];
    state.recs = daysFrom(1, 12).flatMap((d) => shift(20, d));
    const [r] = await computePayrollForMonth(2026, 9);
    expect(r.contractDays).toBe(15);
    expect(r.baseSalary).toBe(450);
    expect(r.warnings.join(" ")).toMatch(/o salário conta até 2026-09-15 \(dia da desativação\)/);
  });
  it("desativada antes do mês (2.ª ficha da mesma pessoa) → 0 €, horas à vista e avisos", async () => {
    state.emps = [
      emp({ id: 10, userId: 500, ...salaried }),
      emp({ id: 77, userId: 500, isActive: 0, deactivatedAt: "2026-06-01 10:00:00", ...salaried }),
    ];
    state.recs = [...daysFrom(1, 14).flatMap((d) => shift(10, d)), ...daysFrom(15, 16).flatMap((d) => shift(77, d))];
    const rows = await computePayrollForMonth(2026, 9);
    const b = rows.find((r) => r.employeeId === 77)!;
    expect(b.totalHours).toBe(16);
    expect(b.baseSalary).toBe(0);
    expect(b.totalPayment).toBe(0);
    expect(b.warnings.join(" ")).toMatch(/sem vínculo neste mês/);
    expect(b.warnings.join(" ")).toMatch(/também em #10/);
    expect(rows.find((r) => r.employeeId === 10)!.baseSalary).toBe(900);
  });
  it("sem data de desativação → não recebe nada por esta ficha e diz porquê", async () => {
    state.emps = [emp({ id: 30, userId: 700, isActive: 0, deactivatedAt: null, ...salaried })];
    state.recs = shift(30, "2026-09-03");
    const [r] = await computePayrollForMonth(2026, 9);
    expect(r.totalPayment).toBe(0);
    expect(r.totalHours).toBe(8);
    expect(r.warnings.join(" ")).toMatch(/nem de desativação: esta ficha não recebe nada neste mês/);
  });
});

describe("turnos por rever e rejeitados contam como sempre", () => {
  it("suspeito fica à parte (não pago), rejeitado não conta, aprovado conta", async () => {
    state.emps = [emp({ id: 40, userId: 800 })];
    state.recs = [
      ...shift(40, "2026-09-02", 7, { reviewStatus: "suspicious", hoursWorked: "12.00", notes: "[SUSPEITO] check-out esquecido — cortado a 12h" }),
      ...shift(40, "2026-09-03", 7, { reviewStatus: "rejected" }),
      ...shift(40, "2026-09-04", 7, { reviewStatus: "approved", hoursWorked: "6.00" }),
    ];
    const [r] = await computePayrollForMonth(2026, 9);
    expect(r.totalHours).toBe(6);
    expect(r.suspiciousHours).toBe(12);
    expect(r.extraPayment).toBe(30);
  });
});
