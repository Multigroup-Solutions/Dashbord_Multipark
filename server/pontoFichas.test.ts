/**
 * Horas que "desapareciam" do ponto (setembro de 2026: duas pessoas só
 * apareciam até meio do mês). A conta de login podia ficar em duas fichas, o
 * ponto passava para a outra e a folha não lia fichas inativas.
 *  - shared/pontoFichas.ts: a que ficha se liga uma conta pelo email, avisos da
 *    folha e aviso na entrada do ponto;
 *  - server/payroll/shifts.ts pontoMonthSummary: o mês da ficha → Ponto com a
 *    regra da folha (dias de Lisboa).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fichasToLinkByEmail, pontoFichaSplitWarning, pontoFichaWarnings, type PontoFichaLike } from "../shared/pontoFichas";
import { pontoMonthSummary, type TimeRecordLike } from "./payroll/shifts";

const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");

describe("fichasToLinkByEmail — uma conta nunca fica em duas fichas pelo email", () => {
  it("a conta já está numa ficha ativa → não se liga a mais nenhuma (era assim que o ponto mudava de ficha)", () => {
    expect(fichasToLinkByEmail([{ id: 40, isActive: true }], true)).toEqual([]);
    expect(fichasToLinkByEmail([{ id: 40, isActive: false }], true)).toEqual([]);
  });
  it("sem ficha: uma ativa → essa; várias ativas → só a mais antiga (antes ligava todas)", () => {
    expect(fichasToLinkByEmail([{ id: 12, isActive: true }], false)).toEqual([12]);
    expect(fichasToLinkByEmail([{ id: 30, isActive: true }, { id: 12, isActive: true }, { id: 7, isActive: false }], false)).toEqual([12]);
  });
  it("só inativas → a mais recente (quem volta a entrar); nenhuma candidata → nada", () => {
    expect(fichasToLinkByEmail([{ id: 3, isActive: false }, { id: 9, isActive: false }], false)).toEqual([9]);
    expect(fichasToLinkByEmail([], false)).toEqual([]);
  });
});

describe("pontoFichaWarnings — a folha diz quando as horas de uma pessoa estão divididas", () => {
  const ficha = (o: Partial<PontoFichaLike> & { employeeId: number }): PontoFichaLike => ({ fullName: `Ficha ${o.employeeId}`, isActive: true, logins: [], checkIns: 0, ...o });

  it("a mesma conta picou em duas fichas no mês → aviso nas duas, com a outra ficha e as entradas", () => {
    const w = pontoFichaWarnings([
      ficha({ employeeId: 10, logins: [500], checkIns: 14 }),
      ficha({ employeeId: 77, logins: [500], checkIns: 13, isActive: false }),
    ]);
    expect(w.get(10)?.join(" ")).toMatch(/também em #77 Ficha 77 \(13 entrada\(s\)\).*junta as fichas em RH → Ligações/);
    expect(w.get(77)?.join(" ")).toMatch(/também em #10 Ficha 10 \(14 entrada\(s\)\)/);
    expect(w.get(77)?.join(" ")).toMatch(/ficha inativa com 13 entrada\(s\)/);
  });
  it("conta extra (employee_accounts) também conta como a mesma pessoa", () => {
    const w = pontoFichaWarnings([
      ficha({ employeeId: 10, logins: [500, 501], checkIns: 5 }),
      ficha({ employeeId: 20, logins: [501], checkIns: 2 }),
    ]);
    expect(w.get(10)?.[0]).toMatch(/#20/);
    expect(w.get(20)?.[0]).toMatch(/#10/);
  });
  it("sem picagens no mês, ou contas diferentes → sem aviso; ficha inativa com picagens → aviso", () => {
    const w = pontoFichaWarnings([
      ficha({ employeeId: 1, logins: [1], checkIns: 3 }),
      ficha({ employeeId: 2, logins: [1], checkIns: 0 }),
      ficha({ employeeId: 3, logins: [3], checkIns: 4 }),
      ficha({ employeeId: 4, logins: [], checkIns: 2, isActive: false }),
    ]);
    expect(w.has(1)).toBe(false);
    expect(w.has(2)).toBe(false);
    expect(w.has(3)).toBe(false);
    expect(w.get(4)).toEqual([expect.stringMatching(/^ficha inativa com 2 entrada\(s\) no ponto neste mês — as horas contam/)]);
  });
});

describe("pontoFichaSplitWarning — aviso na entrada do ponto", () => {
  it("só com duas ou mais fichas ativas", () => {
    expect(pontoFichaSplitWarning(10, [10])).toBeNull();
    expect(pontoFichaSplitWarning(10, [])).toBeNull();
    expect(pontoFichaSplitWarning(10, [10, 77])).toBe("A tua conta está em 2 fichas ativas. Esta entrada ficou na ficha #10 (as outras: #77). Avisa o RH para juntar as fichas, senão as horas ficam divididas.");
  });
});

describe("pontoMonthSummary — ficha → Ponto com a regra da folha", () => {
  // setembro: Lisboa = UTC+1
  const r = (id: number, type: TimeRecordLike["type"], recordedAt: string, extra: Partial<TimeRecordLike> = {}): TimeRecordLike => ({ id, type, recordedAt, ...extra });

  it("turno das 00:30 de dia 1 (23:30 UTC de 31 ago) é de setembro; o do último dia que passa a meia-noite também", () => {
    const s = pontoMonthSummary([
      r(1, "check_in", "2026-08-31 23:30:00"), r(2, "check_out", "2026-09-01 07:30:00"),   // 8 h, 1 set (Lisboa)
      r(3, "check_in", "2026-09-30 20:00:00"), r(4, "check_out", "2026-10-01 04:00:00"),   // 8 h, 30 set (Lisboa)
      r(5, "check_in", "2026-10-01 08:00:00"), r(6, "check_out", "2026-10-01 16:00:00"),   // outubro
    ], "2026-09-01", "2026-09-30");
    expect(s).toEqual({ totalHours: 16, shifts: 2, suspiciousHours: 0, suspiciousShifts: 0, openShifts: 0 });
  });
  it("suspeitos e entradas sem saída ficam à parte; rejeitados não contam; aprovados contam", () => {
    const s = pontoMonthSummary([
      r(1, "check_in", "2026-09-02 07:00:00"), r(2, "check_out", "2026-09-02 19:00:00", { hoursWorked: "12.00", reviewStatus: "suspicious" }),
      r(3, "check_in", "2026-09-03 07:00:00"), r(4, "check_out", "2026-09-03 15:00:00", { reviewStatus: "rejected" }),
      r(5, "check_in", "2026-09-04 07:00:00"), r(6, "check_out", "2026-09-04 19:00:00", { hoursWorked: "10.00", reviewStatus: "approved" }),
      r(7, "check_in", "2026-09-05 07:00:00"),
    ], "2026-09-01", "2026-09-30");
    expect(s).toEqual({ totalHours: 10, shifts: 1, suspiciousHours: 12, suspiciousShifts: 1, openShifts: 1 });
  });
  it("caso de setembro: as picagens da 2.ª quinzena na outra ficha não aparecem nesta — por isso a folha avisa", () => {
    const ficha10 = [r(1, "check_in", "2026-09-01 07:00:00"), r(2, "check_out", "2026-09-01 15:00:00")];
    const ficha77 = [r(3, "check_in", "2026-09-20 07:00:00"), r(4, "check_out", "2026-09-20 15:00:00")];
    expect(pontoMonthSummary(ficha10, "2026-09-01", "2026-09-30").totalHours).toBe(8);
    expect(pontoMonthSummary([...ficha10, ...ficha77], "2026-09-01", "2026-09-30").totalHours).toBe(16);
  });
});

describe("ligações no código (para não voltar atrás)", () => {
  it("a folha mete SEMPRE as fichas com entradas do ponto no mês, também inativas, com os avisos", () => {
    const src = read("server/payroll/payrollData.ts");
    expect(src).toMatch(/or\(bond, inArray\(employees\.id, withPontoIds\)\)/);
    expect(src).toMatch(/const fichaWarnings = pontoFichaWarnings\(pontoFichas\)/);
    expect(src).toMatch(/lisbonDayRangeUtc\(monthFirst, monthLast\)/);
  });
  it("o login liga no máximo uma ficha e nunca a 2.ª de uma conta que já tem ficha ativa", () => {
    const src = read("server/identity.ts");
    expect(src).toMatch(/fichasToLinkByEmail\(rows\.map/);
    expect(src).toMatch(/for \(const r of rows\.filter\(\(x\) => pick\.includes\(x\.id\)\)\)/);
    expect(src).toMatch(/if \(user && !\(await accountHasActiveFicha\(db, user\.id, employee\.id\)\)\) patch\.userId = user\.id;/);
  });
  it("a ficha → Ponto mostra o mês todo (já não só as 30 últimas picagens) e as horas da folha", () => {
    const ui = read("client/src/pages/HRPage.tsx");
    expect(ui).not.toMatch(/records\.slice\(0, 30\)/);
    expect(ui).toMatch(/monthRecords\.map\(/);
    expect(read("server/db.ts")).toMatch(/const summary = pontoMonthSummary\(/);
  });
  it("a entrada do ponto avisa quando a conta está em mais do que uma ficha ativa", () => {
    const src = read("server/rhRouter.ts");
    expect(src).toMatch(/pontoFichaSplitWarning\(input\.employeeId, await activeFichaIdsOfAccount\(/);
    expect(src).toMatch(/warning: \[fichaWarning, missingAgentWarning\]\.filter\(Boolean\)\.join\(" "\) \|\| null/);
  });
});
