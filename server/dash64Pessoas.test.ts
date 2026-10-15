/**
 * Plano 64, PR D — Pessoas e RH: cada número lê a MESMA função da página de
 * referência, segue a cidade do topo e conta só as fichas ativas onde o rótulo
 * diz "ativas".
 *  D0 regra única "é extra"/"funcionário" (shared/employeeKind.ts) ·
 *  D1 rh.stats = a lista do RH (scopedEmployeeRows) · D2 Horas este mês pela
 *  regra do ponto (pontoMonthWindow + pontoMonthSummary) · D3 contratos a
 *  expirar · D4 documentos em falta (fichas sem documentos = 7) · D6 quiz só
 *  fichas ativas · D7 exames (forStats) · D9 "ontem" de Lisboa · D10 coluna
 *  Ponto da Atividade · D11 relatório posto ≠ contrato (a folha não muda).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

const h = vi.hoisted(() => {
  const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false };
  const emp = (id: number, projectId: number | null, o: Record<string, any> = {}) => ({
    employee: {
      id, fullName: `Pessoa ${id}`, email: `p${id}@x.pt`, projectId, isActive: 1, position: "driver", contractType: "permanent",
      contractEnd: null, userId: null, deactivationReason: null, department: null, ...o,
    },
    project: projectId != null ? { id: projectId, name: `Centro ${projectId}` } : null,
  });
  const employees = [
    emp(1, 49),                                                      // Lisboa (outra cidade)
    emp(2, 50),                                                      // funcionário (sem termo)
    emp(3, 65, { position: "extra" }),                               // extra pelo posto (contrato por omissão)
    emp(4, 50, { contractType: "extra" }),                           // extra pelo contrato
    emp(5, 50, { isActive: 0 }),                                     // inativa
    emp(6, 50, { isActive: 0, position: "extra", deactivationReason: "candidato" }), // candidato
    emp(7, null),                                                    // sem centro de custos
    emp(8, 50, { position: "backoffice", contractType: "fixed_term" }), // funcionário a termo
    emp(9, 50, { contractType: "partner_company" }),                 // parceiro-empresa
    emp(10, 65, { position: "extra", contractType: "extra" }),       // extra (os dois)
    emp(11, 50, { contractType: null }),                             // contrato vazio = sem termo
  ];
  return { porto, access: porto as any, employees, docs: new Map<number, Array<{ docType: string; status: string }>>() };
});

vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => h.access,
  loadCityAccessParts: async () => ({ access: h.access, base: h.access, all: h.access }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getProjects: async () => [
    { id: 48, name: "Multipark", level: "group", parentId: null },
    { id: 49, name: "Lisboa", level: "city", parentId: 48 },
    { id: 50, name: "Porto", level: "city", parentId: 48 },
    { id: 65, name: "Parque Porto", level: "project", parentId: 50 },
  ],
  resolveProjectIds: async (id: number) => (id === 50 ? [50, 65] : [id]),
  getEmployeeByUserId: async () => null,
  getAllUsers: async () => [],
  seedExtraRates: async () => {},
  getAllEmployees: async (f: { isActive?: boolean; position?: string } = {}) => h.employees.filter((r) =>
    (f.isActive === undefined || (r.employee.isActive === 1) === f.isActive) && (!f.position || r.employee.position === f.position)),
  getAllEmployeesDocumentStatus: async () => h.docs,
}));
vi.mock("./rhDocuments", async (original) => ({ ...(await original<object>()), licenceStatusesOrNull: async () => null }));

import { appRouter } from "./routers";
import { scopeCityQuery } from "./cityAccess";
import { employeeKind, extraRuleMismatch, hrCounts, isExtraEmployee } from "../shared/employeeKind";
import { isExtraEmployee as financeIsExtra } from "./finance/rules";
import { isExtraLike } from "../shared/pontoMode";
import { isTerminalExtra } from "../shared/terminalSession";
import { pairShifts, pontoMonthSummary, pontoMonthTotals, pontoMonthWindow, type TimeRecordLike } from "./payroll/shifts";
import { addDays, lisbonDayRangeUtc, lisbonYesterday } from "../shared/lisbonDay";
import { contractsExpiring, missingDocsTotals } from "../shared/peopleStats";
import { docsSummary } from "../shared/employeeDocuments";

const caller = (role = "admin") => appRouter.createCaller({ user: { id: 123, role }, req: { headers: {} }, res: {} } as any);
beforeEach(() => { h.access = h.porto; h.docs = new Map(); });

describe("D0 — regra única: extra = posto ou contrato; funcionário = o resto (sem parceiros-empresa)", () => {
  it("employeeKind e isExtraEmployee", () => {
    expect(employeeKind({ position: "extra", contractType: "permanent" })).toBe("extra");
    expect(employeeKind({ position: "driver", contractType: "extra" })).toBe("extra");
    expect(employeeKind({ position: "driver", contractType: "partner_company" })).toBe("partner_company");
    expect(employeeKind({ position: "extra", contractType: "partner_company" })).toBe("partner_company");
    expect(employeeKind({ position: "backoffice", contractType: "fixed_term" })).toBe("staff");
    expect(employeeKind({ position: "driver", contractType: "permanent" })).toBe("staff");
    expect(isExtraEmployee(null)).toBe(false);
  });
  it("igual: as finanças, o ponto e o terminal usam a MESMA função (reexportada), com os mesmos resultados", () => {
    expect(financeIsExtra).toBe(isExtraEmployee);
    expect(isExtraLike).toBe(isExtraEmployee);
    for (const e of [{ position: "extra", contractType: "permanent" }, { position: "driver", contractType: "extra" }, { position: "driver", contractType: "permanent" }, {}]) {
      expect(isTerminalExtra(e)).toBe(isExtraEmployee(e));
    }
  });
});

describe("D1 — contagens das fichas ativas (hrCounts) e rh.stats = a lista do RH", () => {
  it("contrato por omissão + posto extra conta só como extra; a soma bate com o total; inativas fora", () => {
    const c = hrCounts([
      { isActive: 1, position: "extra", contractType: null },
      { isActive: 1, position: "driver", contractType: null },
      { isActive: 1, position: "driver", contractType: "extra" },
      { isActive: 1, position: "driver", contractType: "partner_company" },
      { isActive: 0, position: "driver", contractType: "permanent" },
    ]);
    expect(c).toEqual({ totalActive: 4, staff: 1, extras: 2, partners: 1 });
    expect(c.staff + c.extras + c.partners).toBe(c.totalActive);
  });

  it("o rh.stats tem o mesmo âmbito por omissão que o rh.list (scopeCityQuery)", () => {
    expect(scopeCityQuery("rh.stats", h.porto as any, undefined)).toEqual({ projectId: 50 });
    expect(scopeCityQuery("rh.stats", { ...h.porto, all: true } as any, undefined)).toBeUndefined();
  });

  it("a cidade A não vê as fichas da cidade B; sem centro de custos fica de fora; funcionários, extras e parceiros", async () => {
    const s = await caller().rh.stats();
    // Porto: 2, 3, 4, 8, 9, 10, 11 ativas (fora: 1 de Lisboa, 7 sem centro, 5 inativa, 6 candidato)
    expect(s).toMatchObject({ totalActive: 7, staff: 3, extras: 3, partners: 1, totalPermanent: 3, totalExtras: 3 });
    // sem BD nos testes: as horas são "—" (null + o motivo), nunca 0
    expect(s.monthlyHours).toBeNull();
    expect(s.monthlyHoursError).toBeTruthy();
    await expect(caller().rh.stats({ projectId: 49 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("paridade: rh.stats({ projectId }).totalActive = nº de linhas de rh.list({ isActive: true, projectId })", async () => {
    for (const projectId of [undefined, 50, 65]) {
      const input = projectId === undefined ? {} : { projectId };
      const stats = await caller().rh.stats(input);
      const list = await caller().rh.list({ isActive: true, ...input });
      expect(stats.totalActive).toBe(list.length);
      expect(hrCounts(list.map((r: any) => r.employee))).toMatchObject({ staff: stats.staff, extras: stats.extras, partners: stats.partners });
    }
    expect((await caller().rh.stats({ projectId: 65 })).totalActive).toBe(2);
  });

  it("igual: o rh.list mostra as mesmas fichas de antes (âmbito, cidade escolhida e candidatos)", async () => {
    const active = await caller().rh.list({ isActive: true });
    expect(active.map((r: any) => r.employee.id).sort((a: number, b: number) => a - b)).toEqual([2, 3, 4, 8, 9, 10, 11]);
    const inactive = await caller().rh.list({ isActive: false });
    expect(inactive.map((r: any) => [r.employee.id, r.candidate])).toEqual([[5, false], [6, true]]);
    const park = await caller().rh.list({ isActive: true, projectId: 65 });
    expect(park.map((r: any) => r.employee.id)).toEqual([3, 10]);
  });
});

// ─── D2 / D10: horas pela regra do ponto ──────────────────────────────────────
const rec = (id: number, employeeId: number, type: "check_in" | "check_out", recordedAt: string, o: Partial<TimeRecordLike> = {}) =>
  ({ id, employeeId, type, recordedAt, hoursWorked: null, notes: null, reviewStatus: "ok" as const, ...o });
const RECORDS = [
  // ficha 1: noite de 30 set → 1 out (é de setembro), 5 out 8 h, 6 out rejeitado
  rec(1, 1, "check_in", "2026-09-30 21:00:00"), rec(2, 1, "check_out", "2026-10-01 05:00:00"),
  rec(3, 1, "check_in", "2026-10-05 08:00:00"), rec(4, 1, "check_out", "2026-10-05 16:00:00"),
  rec(5, 1, "check_in", "2026-10-06 08:00:00"), rec(6, 1, "check_out", "2026-10-06 12:00:00", { reviewStatus: "rejected" }),
  // ficha 2: suspeito a 10 out (3 h), noite de 31 out → 1 nov (8 h, conta em outubro), e uma de 5 nov (fora)
  rec(7, 2, "check_in", "2026-10-10 08:00:00"), rec(8, 2, "check_out", "2026-10-10 11:00:00", { notes: "[SUSPEITO] longe" }),
  rec(9, 2, "check_in", "2026-10-31 22:00:00"), rec(10, 2, "check_out", "2026-11-01 06:00:00"),
  rec(11, 2, "check_in", "2026-11-05 08:00:00"), rec(12, 2, "check_out", "2026-11-05 16:00:00"),
];

describe("D2 — Horas este mês pela regra do #390", () => {
  it("igual: a janela do getMonthlyHours não muda (pontoMonthWindow = a conta que lá estava)", () => {
    const w = pontoMonthWindow(2026, 10);
    expect(w).toEqual({
      firstDay: "2026-10-01", lastDay: "2026-10-31",
      readFrom: lisbonDayRangeUtc(addDays("2026-10-01", -1)).start, readUntil: lisbonDayRangeUtc(addDays("2026-10-31", 1)).end,
    });
    expect([w.readFrom, w.readUntil]).toEqual(["2026-09-29 23:00:00", "2026-11-02 00:00:00"]);
    expect(pontoMonthWindow(2026, 2).lastDay).toBe("2026-02-28");
    const db = src("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getMonthlyHours"), db.indexOf("// ─── RH: EXTRA RATES"));
    expect(fn).toContain("pontoMonthWindow(year, month)");
    expect(fn).toContain("pontoMonthSummary(likes, firstDay, lastDay)");
  });

  it("igual: o resumo sem a divisão noite/fim de semana dá as mesmas horas, estado e dia (só mais rápido)", () => {
    for (const id of [1, 2]) {
      const list = RECORDS.filter((r) => r.employeeId === id);
      const pick = (x: ReturnType<typeof pairShifts>) => x.shifts.map((s) => [s.inId, s.outId, s.hours, s.status, s.day]);
      expect(pick(pairShifts(list, { split: false }))).toEqual(pick(pairShifts(list)));
    }
    expect(src("server/payroll/payrollData.ts")).toContain("pairShifts((recordsByEmp.get(employeeId) ?? []).map(toShiftLike)).shifts");
  });

  it("a noite de 31 → 1 conta no mês em que entrou; rejeitados fora; suspeitos à parte", () => {
    const oct = pontoMonthTotals(RECORDS, "2026-10-01", "2026-10-31");
    expect(oct.totalHours).toBe(16);
    expect(oct.suspiciousHours).toBe(3);
    expect(oct.byEmployee.get(1)?.totalHours).toBe(8);
    expect(oct.byEmployee.get(2)?.totalHours).toBe(8);
    expect(pontoMonthTotals(RECORDS, "2026-09-01", "2026-09-30").totalHours).toBe(8);
  });

  it("paridade: a soma do RH = Σ getMonthlyHours de cada ficha (a mesma janela e a mesma conta)", () => {
    const w = pontoMonthWindow(2026, 10);
    const inWindow = RECORDS.filter((r) => r.recordedAt >= w.readFrom && r.recordedAt < w.readUntil);
    const rh = pontoMonthTotals(inWindow, w.firstDay, w.lastDay);
    // getMonthlyHours de UMA ficha = pontoMonthSummary das picagens dela na mesma janela
    const perFicha = [1, 2].map((id) => pontoMonthSummary(inWindow.filter((r) => r.employeeId === id), w.firstDay, w.lastDay));
    expect(rh.totalHours).toBe(perFicha.reduce((t, s) => t + s.totalHours, 0));
    expect(rh.suspiciousHours).toBe(perFicha.reduce((t, s) => t + s.suspiciousHours, 0));
    // ler tudo ou só a janela dá o mesmo (o que fica fora não conta)
    expect(pontoMonthTotals(RECORDS, w.firstDay, w.lastDay).totalHours).toBe(rh.totalHours);
  });

  it("o rh.stats lê as horas das fichas do âmbito (ativas ou não) sem os parceiros-empresa, numa só leitura agrupada", () => {
    const db = src("server/db.ts");
    const stats = db.slice(db.indexOf("export async function getHRStats"), db.indexOf("// ═══", db.indexOf("export async function getHRStats")));
    expect(stats).toContain('fichas.filter((r) => r.employee.contractType !== "partner_company")');
    expect(stats).toContain("hrCounts(fichas.map((r) => r.employee))");
    expect(stats).not.toMatch(/SUM\(|hoursWorked/);
    const totals = db.slice(db.indexOf("export async function getPontoMonthTotals"), db.indexOf("export async function getHRStats"));
    expect(totals).toContain("pontoMonthTotals(rows, w.firstDay, w.lastDay)");
    expect(totals).toContain("gte(timeRecords.recordedAt, w.readFrom), lt(timeRecords.recordedAt, w.readUntil)");
  });
});

describe("D3 — contratos a expirar (dias de Lisboa, hoje ≤ fim ≤ hoje + 30)", () => {
  it("fronteiras em hoje e em hoje + 30; contrato vazio fora", () => {
    const today = "2026-10-15";
    const rows = [
      { contractEnd: "2026-10-15 00:00:00" }, // acaba hoje → conta
      { contractEnd: "2026-11-14" },          // hoje + 30 → conta
      { contractEnd: "2026-11-15 00:00:00" }, // hoje + 31 → fora
      { contractEnd: "2026-10-14 00:00:00" }, // ontem → fora
      { contractEnd: null },
    ];
    expect(contractsExpiring(rows, today)).toBe(2);
  });
  it("o Pessoas pede a lista ATIVA do RH com a cidade do topo e sem o Período", () => {
    const page = src("client/src/pages/PessoasDashboard.tsx");
    expect(page).toContain("trpc.rh.list.useQuery({ isActive: true, ...scope }");
    expect(page).toContain("showDates={false}");
    expect(page).toContain("contractsExpiring(Array.from(employeeMap.values()), lisbonDayOf(Date.now()))");
    expect(page).toContain("trpc.evaluation.ranking.useQuery({ from: evalFrom, to: evalTo, ...scope }");
    expect(page).toContain("const evalTo = addDays(operationalDayOf(Date.now()), -1);");
    expect(page).not.toMatch(/value=\{stats\?\.totalActive \?\? 0\}/);
  });
});

describe("D4 — documentos em falta: as fichas sem documentos contam (7) e o cartão só soma as ativas", () => {
  it("puro: ficha sem documentos → 7; inativa e candidato fora do cartão (não estão na lista ativa)", () => {
    const status: Record<number, { total: number; present: number }> = {
      2: docsSummary([]),
      3: docsSummary([{ docType: "photo", status: "validated" }, { docType: "id_card", status: "pending" }]),
      5: docsSummary([]), // inativa
      6: docsSummary([]), // candidato
    };
    expect(docsSummary([]).total - docsSummary([]).present).toBe(7);
    expect(missingDocsTotals([{ id: 2 }, { id: 3 }], status)).toEqual({ missing: 7 + 5, employees: 2 });
  });
  it("rh.documents.allStatus devolve um resumo para CADA ficha do âmbito (ativas e não ativas), também sem documentos", async () => {
    h.docs = new Map([[2, [{ docType: "photo", status: "validated" }]], [1, [{ docType: "photo", status: "validated" }]]]);
    const r = await caller().rh.documents.allStatus();
    expect(Object.keys(r).map(Number).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 8, 9, 10, 11]);
    expect(r[2]).toMatchObject({ total: 7, present: 1 });
    expect(r[4]).toMatchObject({ total: 7, present: 0 });
    expect(r[1]).toBeUndefined(); // Lisboa: fora do âmbito
  });
});

describe("D6/D7 — quiz e exames: só fichas ativas, exames não arquivados e a cidade", () => {
  it("o quizRanking filtra as fichas ativas e o router passa o projectId", () => {
    const t = src("server/trainingAttempts.ts");
    const fn = t.slice(t.indexOf("export async function quizRanking"), t.indexOf("export async function displayNames"));
    expect(fn).toContain("eq(employees.isActive, 1)");
    expect(fn).toContain("projectScope(employees.projectId)");
    expect(fn).toContain("resolveProjectIds(opts.projectId)");
    const r = src("server/trainingRouter.ts");
    expect(r).toContain("return quizRanking(50, { projectId: input?.projectId ?? null });");
  });
  it("forStats: só o careerExamAttempts do dashboard; os meus exames e o histórico da ficha ficam como estavam", () => {
    const db = src("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getCareerExamAttempts"), db.indexOf("export async function deleteCareerExam"));
    expect(fn).toMatch(/if \(opts\.forStats\) \{\s*conditions\.push\(isNull\(careerExams\.archivedAt\), eq\(employees\.isActive, 1\), projectScope\(employees\.projectId\)\)/);
    const r = src("server/trainingRouter.ts");
    expect(r.match(/forStats: true/g)?.length).toBe(1);
    expect(r).toContain("trainingResultScope(await rhViewer(ctx.user)), { forStats: true });");
    expect(r).toContain("return getCareerExamAttempts(me.employee.id);");
    expect(r).toContain("const attempts = await getCareerExamAttempts(input.employeeId);");
  });
});

describe("D9 — Processar faltas (ontem) pelo dia de Lisboa", () => {
  it("00:30 de Lisboa de 16 out → 2026-10-15 (antes dava anteontem)", () => {
    const at = Date.UTC(2026, 9, 15, 23, 30); // 00:30 de 16 out em Lisboa (verão, UTC+1)
    expect(lisbonYesterday(at)).toBe("2026-10-15");
    expect(new Date(at - 86_400_000).toISOString().slice(0, 10)).toBe("2026-10-14"); // a conta antiga
    expect(src("client/src/pages/RhDashboardPage.tsx")).toContain("processNoShows.mutate({ date: lisbonYesterday(Date.now()) });");
  });
});

describe("D10 — Atividade diária → coluna Ponto pela regra da ficha → Ponto", () => {
  it("puro: um turno suspeito não soma; a saída no dia seguinte conta no dia da entrada", () => {
    const recs = [
      rec(1, 1, "check_in", "2026-10-04 21:00:00"), rec(2, 1, "check_out", "2026-10-05 05:00:00"), // entrou a 4 (Lisboa 22h)
      rec(3, 1, "check_in", "2026-10-05 21:00:00"), rec(4, 1, "check_out", "2026-10-06 05:00:00"), // entrou a 5 → 8 h no dia 5
      rec(5, 2, "check_in", "2026-10-05 08:00:00"), rec(6, 2, "check_out", "2026-10-05 12:00:00", { reviewStatus: "suspicious" }),
    ];
    const day = pontoMonthTotals(recs, "2026-10-05", "2026-10-05");
    expect(day.byEmployee.get(1)?.totalHours).toBe(8);
    expect(day.byEmployee.get(2)?.totalHours).toBe(0);
    expect(day.byEmployee.get(2)?.suspiciousHours).toBe(4);
  });
  it("lê [início − 1, fim + 1) e usa a mesma conta; os km provisórios continuam pelas saídas", () => {
    const a = src("server/dayActivity.ts");
    expect(a).toContain("const readFrom = lisbonDayRangeUtc(addDays(startDate, -1)).start;");
    expect(a).toContain("const readUntil = lisbonDayRangeUtc(addDays(lastDay, 1)).end;");
    expect(a).toContain("pontoMonthTotals(recs, startDate, lastDay).byEmployee");
    expect(a).not.toContain("p.pontoHours = r2((p.pontoHours ?? 0) + h)");
    expect(a).toContain("WHERE type = 'check_out' AND recordedAt >= ${range.start} AND recordedAt < ${range.end}");
  });
});

describe("D11 — relatório posto ≠ contrato (só leitura; a folha não muda)", () => {
  it("puro: {extra, permanent} e {driver, extra} aparecem; {extra, extra} não", () => {
    expect(extraRuleMismatch({ position: "extra", contractType: "permanent" })).toMatchObject({ payrollAs: "extra", extraBy: "position" });
    expect(extraRuleMismatch({ position: "driver", contractType: "extra" })).toMatchObject({ payrollAs: "staff", extraBy: "contract" });
    expect(extraRuleMismatch({ position: "extra", contractType: "extra" })).toBeNull();
    expect(extraRuleMismatch({ position: "driver", contractType: "permanent" })).toBeNull();
    expect(extraRuleMismatch({ position: "extra", contractType: "partner_company" })).toMatchObject({ payrollAs: "outside" });
  });
  it("só o super admin; fichas ativas do âmbito", async () => {
    await expect(caller("admin").rh.extraMismatch()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rows = await caller("super_admin").rh.extraMismatch();
    expect(rows.map((r) => r.employeeId).sort((a, b) => a - b)).toEqual([3, 4]);
    expect(rows.find((r) => r.employeeId === 3)).toMatchObject({ fullName: "Pessoa 3", projectName: "Centro 65", payrollAs: "extra" });
  });
  it("igual: a folha continua a decidir o extra só pelo posto e não usa a regra nova", () => {
    const p = src("server/payroll/payrollData.ts");
    expect(p).toContain('const isExtra = e.position === "extra";');
    expect(p).not.toMatch(/employeeKind|extraRuleMismatch/);
    expect(src("server/payroll/compute.ts")).toContain('const isExtra = e.position === "extra";');
  });
});
