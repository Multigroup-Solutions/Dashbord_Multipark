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
import { chooseOwnFicha, fichasToLinkByEmail, inactiveContractEnd, pontoFichaSplitWarning, pontoFichaWarnings, shiftOverlapWarnings, type PontoFichaLike } from "../shared/pontoFichas";
import { pontoMonthRecordIds, pontoMonthSummary, type TimeRecordLike } from "./payroll/shifts";
import { pairPonto } from "./evaluationCore";

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
    expect(w.get(4)).toEqual([expect.stringMatching(/^ficha inativa com 2 entrada\(s\) no ponto neste mês — confirma se é a ficha certa/)]);
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

describe("pontoFichaWarnings — a mesma pessoa paga em duas fichas", () => {
  const ficha = (o: Partial<PontoFichaLike> & { employeeId: number }): PontoFichaLike => ({ fullName: `Ficha ${o.employeeId}`, isActive: true, logins: [], checkIns: 0, inPayroll: true, ...o });
  it("duas fichas na folha com a mesma conta, só uma picou → aviso nas duas (o salário base contava nas duas)", () => {
    const w = pontoFichaWarnings([ficha({ employeeId: 10, logins: [500], checkIns: 20 }), ficha({ employeeId: 77, logins: [500] })]);
    expect(w.get(10)?.join(" ")).toMatch(/também na ficha #77 Ficha 77, que também entra nesta folha — confirma que não pagas a mesma pessoa duas vezes/);
    expect(w.get(77)?.join(" ")).toMatch(/também na ficha #10 Ficha 10/);
  });
  it("as duas picaram → só o aviso das horas divididas (sem repetir a ficha no outro aviso)", () => {
    const w = pontoFichaWarnings([ficha({ employeeId: 10, logins: [500], checkIns: 5 }), ficha({ employeeId: 77, logins: [500], checkIns: 3 })]);
    expect(w.get(10)).toHaveLength(1);
    expect(w.get(10)?.[0]).toMatch(/picou o ponto também em #77/);
  });
  it("fichas sem conta, fora da folha sem picagens, ou readmissão (a antiga inativa) não avisam", () => {
    const w = pontoFichaWarnings([
      ficha({ employeeId: 1, logins: [] }), ficha({ employeeId: 2, logins: [] }),
      ficha({ employeeId: 3, logins: [9], inPayroll: false }), ficha({ employeeId: 4, logins: [9] }),
      ficha({ employeeId: 5, logins: [11], isActive: false }), ficha({ employeeId: 6, logins: [11], checkIns: 10 }),
    ]);
    expect(w.size).toBe(0);
  });
});

describe("shiftOverlapWarnings — o mesmo tempo picado em duas fichas não conta duas vezes sem aviso", () => {
  const sh = (inAt: string, outAt: string | null) => ({ inAt, outAt });
  it("turnos sobrepostos na mesma conta → aviso nas duas, com as horas em duplicado", () => {
    const w = shiftOverlapWarnings([
      { employeeId: 10, fullName: "A", logins: [500], shifts: [sh("2026-09-20 07:00:00", "2026-09-20 15:00:00")] },
      { employeeId: 77, fullName: "B", logins: [500, 501], shifts: [sh("2026-09-20 13:00:00", "2026-09-20 21:00:00")] },
    ]);
    expect(w.get(10)?.[0]).toMatch(/também na ficha #77 B \(2 h sobrepostas\)/);
    expect(w.get(77)?.[0]).toMatch(/também na ficha #10 A \(2 h sobrepostas\)/);
  });
  it("turnos seguidos (sem sobrepor), contas diferentes ou entrada aberta → nada", () => {
    expect(shiftOverlapWarnings([
      { employeeId: 10, fullName: "A", logins: [500], shifts: [sh("2026-09-20 07:00:00", "2026-09-20 15:00:00")] },
      { employeeId: 77, fullName: "B", logins: [500], shifts: [sh("2026-09-20 15:00:00", "2026-09-20 21:00:00"), sh("2026-09-20 08:00:00", null)] },
      { employeeId: 88, fullName: "C", logins: [600], shifts: [sh("2026-09-20 07:00:00", "2026-09-20 15:00:00")] },
    ]).size).toBe(0);
  });
});

describe("inactiveContractEnd — ficha inativa sem fim de contrato que entra na folha pelas picagens", () => {
  it("extra → paga-se à hora o que picou; ativa ou com fim de contrato → como sempre", () => {
    expect(inactiveContractEnd({ isActive: false, isExtra: true, deactivatedAt: "2026-06-01 10:00:00" })).toEqual({ kind: "extra", end: null });
    expect(inactiveContractEnd({ isActive: true, isExtra: false })).toEqual({ kind: "none", end: null });
    expect(inactiveContractEnd({ isActive: false, isExtra: false, contractEnd: "2026-09-10" })).toEqual({ kind: "none", end: null });
  });
  it("outros → até ao dia (Lisboa) da desativação; sem data → não recebe (nunca o mês inteiro a dobrar)", () => {
    // 23:30 UTC de 14 set = 00:30 de 15 set em Lisboa
    expect(inactiveContractEnd({ isActive: false, isExtra: false, deactivatedAt: "2026-09-14 23:30:00" })).toEqual({ kind: "assumed", end: "2026-09-15" });
    expect(inactiveContractEnd({ isActive: false, isExtra: false, deactivatedAt: null })).toEqual({ kind: "unknown", end: null });
  });
});

describe("chooseOwnFicha — que ficha recebe o ponto quando a conta está em várias (determinístico)", () => {
  it("uma ativa e uma inativa → a ativa, mesmo pela conta extra", () => {
    expect(chooseOwnFicha([{ id: 90, isActive: false, via: "principal" }, { id: 12, isActive: true, via: "extra" }])).toBe(12);
  });
  it("duas ativas → a do ponto mais recente (o ponto não muda de ficha sozinho a meio do mês)", () => {
    expect(chooseOwnFicha([
      { id: 10, isActive: true, via: "principal", lastPontoAt: "2026-09-14 18:00:00" },
      { id: 77, isActive: true, via: "principal", lastPontoAt: null },
    ])).toBe(10);
    expect(chooseOwnFicha([
      { id: 10, isActive: true, via: "principal", lastPontoAt: "2026-09-14 18:00:00" },
      { id: 77, isActive: true, via: "principal", lastPontoAt: "2026-09-15 07:00:00" },
    ])).toBe(77);
  });
  it("sem ponto em nenhuma → principal antes de extra, depois a mais recente; sempre a mesma resposta", () => {
    const c = [{ id: 10, isActive: true, via: "principal" as const }, { id: 77, isActive: true, via: "principal" as const }, { id: 99, isActive: true, via: "extra" as const }];
    expect(chooseOwnFicha(c)).toBe(77);
    expect(chooseOwnFicha([...c].reverse())).toBe(77);
    expect(chooseOwnFicha([{ id: 3, isActive: false, via: "principal" }, { id: 9, isActive: false, via: "principal" }])).toBe(9);
    expect(chooseOwnFicha([])).toBeNull();
  });
});

describe("pontoMonthRecordIds — a lista do mês tem os turnos do mês inteiros (soma como a folha)", () => {
  const r = (id: number, type: TimeRecordLike["type"], recordedAt: string): TimeRecordLike => ({ id, type, recordedAt });
  // setembro (Lisboa = UTC+1): o mês é [31 ago 23:00, 30 set 23:00) UTC
  const start = "2026-08-31 23:00:00", end = "2026-09-30 23:00:00";
  it("a saída do turno da noite de dia 30 (já em outubro) aparece em setembro; a do turno de 31 ago não", () => {
    const ids = pontoMonthRecordIds([
      r(1, "check_in", "2026-08-31 20:00:00"), r(2, "check_out", "2026-09-01 02:00:00"), // turno de 31 ago (Lisboa)
      r(3, "check_in", "2026-09-30 20:00:00"), r(4, "check_out", "2026-10-01 04:00:00"), // turno de 30 set
      r(5, "check_out", "2026-09-10 12:00:00"),                                             // saída solta em setembro
      r(6, "check_in", "2026-10-01 08:00:00"),                                              // outubro
    ], "2026-09-01", "2026-09-30", start, end);
    expect([...ids].sort()).toEqual([3, 4, 5]);
  });
});

describe("as horas do ponto batem com a avaliação (pairPonto) — a mesma regra por turno", () => {
  const r = (id: number, type: TimeRecordLike["type"], recordedAt: string, extra: Partial<TimeRecordLike> = {}): TimeRecordLike => ({ id, type, recordedAt, ...extra });
  const recs = [
    r(1, "check_in", "2026-09-02 06:00:00"), r(2, "check_out", "2026-09-02 14:30:00"),
    r(3, "check_in", "2026-09-03 07:00:00"), r(4, "check_out", "2026-09-03 19:00:00", { hoursWorked: "12.00", reviewStatus: "suspicious", notes: "[SUSPEITO] check-out esquecido" }),
    r(5, "check_in", "2026-09-04 07:00:00"), r(6, "check_out", "2026-09-04 19:00:00", { hoursWorked: "9.50", reviewStatus: "approved" }),
    r(7, "check_in", "2026-09-05 07:00:00"), r(8, "check_out", "2026-09-05 15:00:00", { reviewStatus: "rejected" }),
    r(9, "check_in", "2026-09-06 21:00:00"), r(10, "check_out", "2026-09-07 05:00:00"), // noite que passa a meia-noite
  ];
  it("total do mês (ficha → Ponto e folha) = soma dos turnos que contam na avaliação", () => {
    const folha = pontoMonthSummary(recs, "2026-09-01", "2026-09-30");
    const avaliacao = pairPonto(recs.map((x) => ({ ...x, employeeId: 1 }))).filter((s) => s.countable).reduce((t, s) => t + s.hours, 0);
    expect(folha.totalHours).toBe(Math.round(avaliacao * 100) / 100);
    expect(folha.totalHours).toBe(8.5 + 9.5 + 8);
  });
  it("diferença conhecida: a avaliação conta o dia que fecha às 03:00; a folha, o dia de calendário em que o turno começou", () => {
    // entrada às 01:30 de 1 out (Lisboa) = 00:30 UTC: avaliação → 30 set (dia operacional); folha → outubro
    const late = [r(1, "check_in", "2026-10-01 00:30:00"), r(2, "check_out", "2026-10-01 06:30:00")];
    expect(pairPonto(late.map((x) => ({ ...x, employeeId: 1 })))[0].day).toBe("2026-09-30");
    expect(pontoMonthSummary(late, "2026-09-01", "2026-09-30").totalHours).toBe(0);
    expect(pontoMonthSummary(late, "2026-10-01", "2026-10-31").totalHours).toBe(6);
  });
});

describe("ligações no código (para não voltar atrás)", () => {
  it("a folha mete SEMPRE as fichas com entradas do ponto no mês, também inativas, com os avisos", () => {
    const src = read("server/payroll/payrollData.ts");
    expect(src).toMatch(/or\(bond, inArray\(employees\.id, withPontoIds\)\)/);
    expect(src).toMatch(/const fichaWarnings = pontoFichaWarnings\(folhaFichas\)/);
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
  it("ficha → Ponto: as picagens (fotos, GPS) só para quem vê a lista do ponto; o team leader continua a ver; mês validado", () => {
    const src = read("server/rhRouter.ts");
    const fn = src.slice(src.indexOf("monthlyHours: protectedProcedure"), src.indexOf("// ── PAYROLL"));
    expect(fn).toContain("month: z.number().int().min(1).max(12)");
    expect(fn).toContain("const canSeeRecords = await assertCanViewTimeRecords(ctx.user, input.employeeId).then(() => true, () => false);");
    expect(fn).toContain('if (!canSeeRecords) await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "supervisor");');
    expect(fn).toContain("return canSeeRecords ? res : { ...res, records: [] as typeof res.records };");
    const ui = read("client/src/pages/HRPage.tsx");
    expect(ui).toContain("trpc.rh.timeRecords.list.useQuery({ employeeId, limit: 1 })");
    // marcar/desmarcar terminal refresca a lista do mês (que agora vem das horas)
    const setT = ui.slice(ui.indexOf("const setTerminal = trpc.rh.timeRecords.setTerminal.useMutation"), ui.indexOf("const now = new Date();"));
    expect(setT).toContain("utils.rh.timeRecords.monthlyHours.invalidate()");
  });
  it("getEmployeeByUserId escolhe a ficha pela regra fixa (chooseOwnFicha), com o ponto mais recente entre várias ativas", () => {
    const db = read("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getEmployeeByUserId"), db.indexOf("export async function createEmployee"));
    expect(fn).toContain("if (activePrincipal.length === 1) return activePrincipal[0];");
    expect(fn).toContain("DATE_FORMAT(MAX(${timeRecords.recordedAt})");
    expect(fn.match(/chooseOwnFicha\(/g)?.length).toBe(2);
  });
});
