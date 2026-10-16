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
      contractEnd: null, userId: null, deactivationReason: null, department: null,
      // dados de dinheiro e identidade: nenhum número novo os pode levar (auditoria)
      monthlySalary: "1234.56", nib: "PT50000201231234567890154", nif: "123456789", ...o,
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
  return { porto, access: porto as any, employees, docs: new Map<number, Array<{ docType: string; status: string }>>(), me: null as any };
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
  getEmployeeByUserId: async () => h.me,
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
import { countableShifts, pairShifts, pontoMonthSummary, pontoMonthTotals, pontoMonthWindow, type Shift, type TimeRecordLike } from "./payroll/shifts";
import { readdirSync } from "node:fs";
import { workedHours } from "../shared/dayWorkSummary";
import { searchHelpSections } from "./assistant/helpTools";
import { knowledgeTree } from "./assistant/knowledgeTree";
import { pickHelpDocs } from "./_core/ai/chat/retrieval";
import { staffHelpDocs } from "./assistant/service";
import { addDays, lisbonDayRangeUtc, lisbonYesterday } from "../shared/lisbonDay";
import { contractsExpiring, missingDocsTotals } from "../shared/peopleStats";
import { docsSummary } from "../shared/employeeDocuments";

const caller = (role = "admin") => appRouter.createCaller({ user: { id: 123, role }, req: { headers: {} }, res: {} } as any);
beforeEach(() => { h.access = h.porto; h.docs = new Map(); h.me = null; });

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

// ═══ Auditoria final do PR D (plano 64) ══════════════════════════════════════

describe("Auditoria D — dinheiro: finanças, ponto e terminal decidem 'extra' exatamente como antes", () => {
  // as três cópias que existiam antes do D0, tal e qual
  const oldFinance = (e: { contractType?: string | null; position?: string | null }) => e.contractType === "extra" || e.position === "extra";
  const oldPonto = (e: { position?: string | null; contractType?: string | null }) => e.position === "extra" || e.contractType === "extra";
  const oldTerminal = (e: { position?: string | null; contractType?: string | null } | null | undefined) => !!e && (e.position === "extra" || e.contractType === "extra");

  it("igual em todas as combinações de posto × contrato (também vazios, nulos e maiúsculas)", () => {
    const positions = ["extra", "Extra", "EXTRA", "driver", "senior_driver", "team_leader", "supervisor", "backoffice", "frontoffice", "director", "", null, undefined];
    const contracts = ["extra", "Extra", "permanent", "fixed_term", "partner_company", "", null, undefined];
    let n = 0;
    for (const position of positions) for (const contractType of contracts) {
      const e = { position, contractType };
      const tag = JSON.stringify(e);
      expect(financeIsExtra(e), tag).toBe(oldFinance(e));
      expect(isExtraLike(e), tag).toBe(oldPonto(e));
      expect(isTerminalExtra(e), tag).toBe(oldTerminal(e));
      n++;
    }
    expect(n).toBe(positions.length * contracts.length);
    expect(isTerminalExtra(null)).toBe(false);
    expect(isTerminalExtra(undefined)).toBe(false);
  });

  it("o motor da Faturação usa a mesma regra; a folha e o custo dos extras não foram tocados", () => {
    expect(src("server/finance/engine.ts")).toContain("if (R.isExtraEmployee(e)) continue;");
    // o custo dos extras da Faturação já era "contrato OU posto" em SQL (não muda)
    expect(src("server/finance/extrasCost.ts")).toContain('or(eq(employees.contractType, "extra"), eq(employees.position, "extra"))');
    for (const f of ["server/payroll/payrollData.ts", "server/payroll/compute.ts", "server/finance/extrasCost.ts", "server/finance/engine.ts"]) {
      expect(src(f), f).not.toMatch(/employeeKind|hrCounts|extraRuleMismatch|split: false/);
    }
  });
});

describe("Auditoria D — pairShifts sem a divisão (split: false): as mesmas horas, estado e dia", () => {
  const strip = ({ split: _s, daysTouched: _d, ...rest }: Shift) => rest;
  // a conta do pontoMonthSummary ANTES (com a divisão), a partir dos turnos do caminho completo
  const refSummary = (fullShifts: Shift[], firstDay: string, lastDay: string) => {
    const month = fullShifts.filter((s) => s.day >= firstDay && s.day <= lastDay);
    const countable = countableShifts(month);
    const suspicious = month.filter((s) => s.status === "suspicious");
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      totalHours: r2(countable.reduce((t, s) => t + s.hours, 0)), shifts: countable.length,
      suspiciousHours: r2(suspicious.reduce((t, s) => t + s.hours, 0)), suspiciousShifts: suspicious.length,
      openShifts: month.filter((s) => s.status === "open").length,
    };
  };
  const same = (records: TimeRecordLike[]) => {
    const full = pairShifts(records);
    const fast = pairShifts(records, { split: false });
    expect(fast.shifts.map(strip)).toEqual(full.shifts.map(strip));
    expect(fast.orphans).toEqual(full.orphans);
    return full;
  };
  const r = (id: number, type: "check_in" | "check_out", recordedAt: string, o: Partial<TimeRecordLike> = {}): TimeRecordLike =>
    ({ id, type, recordedAt, hoursWorked: null, notes: null, reviewStatus: "ok", ...o });

  it("fronteiras: mudança de hora em março e em outubro, meia-noite e viragem do mês em Lisboa", () => {
    // março: 00:30 WET → 04:00 WEST (a hora 01h–02h não existe): 2,5 h reais, dia 29
    expect(same([r(1, "check_in", "2026-03-29 00:30:00"), r(2, "check_out", "2026-03-29 03:00:00")]).shifts[0])
      .toMatchObject({ hours: 2.5, day: "2026-03-29", status: "ok" });
    // outubro: em UTC ainda é dia 24, em Lisboa já é dia 25 (00:30 WEST); a hora 01h repete-se
    expect(same([r(1, "check_in", "2026-10-24 23:30:00"), r(2, "check_out", "2026-10-25 02:00:00")]).shifts[0])
      .toMatchObject({ hours: 2.5, day: "2026-10-25" });
    // 23:30 UTC de 30 set = 00:30 de 1 out em Lisboa (verão): o turno é de outubro
    const sept = [r(1, "check_in", "2026-09-30 23:30:00"), r(2, "check_out", "2026-10-01 07:30:00")];
    expect(same(sept).shifts[0]).toMatchObject({ hours: 8, day: "2026-10-01" });
    expect(pontoMonthSummary(sept, "2026-10-01", "2026-10-31").totalHours).toBe(8);
    expect(pontoMonthSummary(sept, "2026-09-01", "2026-09-30").totalHours).toBe(0);
    // noite de 31 out → 1 nov (inverno, Lisboa = UTC): fica em outubro
    expect(same([r(1, "check_in", "2026-10-31 22:00:00"), r(2, "check_out", "2026-11-01 06:00:00")]).shifts[0].day).toBe("2026-10-31");
  });

  it("sobrepostos, sem saída, saída sem entrada, suspeitos, rejeitados, aprovados, cortados a 12 h e 0 minutos", () => {
    const recs = [
      r(1, "check_out", "2026-10-05 07:00:00"),                                                   // saída sem entrada
      r(2, "check_in", "2026-10-05 08:00:00"), r(3, "check_in", "2026-10-05 09:00:00"),            // entrada sobre entrada
      r(4, "check_out", "2026-10-05 17:00:00", { notes: "[SUSPEITO] longe" }),
      r(5, "check_in", "2026-10-06 08:00:00"), r(6, "check_out", "2026-10-06 12:00:00", { reviewStatus: "rejected" }),
      r(7, "check_in", "2026-10-07 08:00:00"), r(8, "check_out", "2026-10-07 20:00:00", { reviewStatus: "approved", hoursWorked: "6.50" }),
      r(9, "check_in", "2026-10-08 08:00:00", { reviewStatus: "approved", hoursWorked: "0" }), r(10, "check_out", "2026-10-08 12:00:00", { reviewStatus: null }),
      r(11, "check_in", "2026-10-09 06:00:00"), r(12, "check_out", "2026-10-10 00:00:00", { hoursWorked: "12.00" }), // saída cortada a 12 h
      r(13, "check_in", "2026-10-11 08:00:00"), r(14, "check_out", "2026-10-11 08:00:00"),          // 0 minutos
      r(16, "check_in", "2026-10-12 08:00:00"), r(15, "check_out", "2026-10-12 08:00:00"),          // mesma hora: manda o id
      r(17, "check_in", "2026-10-13 08:00:00"),                                                   // sem saída no fim
    ];
    const full = same(recs);
    expect(full.orphans.map((o) => o.id)).toEqual([1, 15]);
    expect(full.shifts.map((s) => [s.inId, s.status, s.hours])).toEqual([
      [2, "open", 0], [3, "suspicious", 8], [5, "rejected", 4], [7, "approved", 6.5], [9, "approved", 0], [11, "ok", 12], [13, "ok", 0], [16, "open", 0], [17, "open", 0],
    ]);
    expect(pontoMonthSummary(recs, "2026-10-01", "2026-10-31")).toEqual(refSummary(full.shifts, "2026-10-01", "2026-10-31"));
  });

  it("propriedade: 300 sequências ao calhas à volta das mudanças de hora e das viragens do mês dão o mesmo", () => {
    let seed = 64;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
    const shuffle = <T,>(a: T[]): T[] => {
      const out = [...a];
      for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
      return out;
    };
    const ANCHORS = ["2026-03-28 21:00:00", "2026-03-29 00:00:00", "2026-10-24 21:00:00", "2026-10-25 00:00:00", "2026-09-30 21:00:00", "2026-10-31 21:00:00", "2026-12-31 21:00:00", "2026-06-15 08:00:00"];
    const GAPS_MIN = [0, 1, 7, 30, 59, 61, 180, 240, 480, 600, 719, 721, 960, 1000];
    const STATUS = ["ok", "ok", "ok", "suspicious", "approved", "rejected", null, undefined] as const;
    const NOTES = [null, null, null, "nota", "[SUSPEITO] fora da zona"];
    const HOURS = [null, null, "", "0", "0.00", "3.25", "12.00", "25", 7];
    const WINDOWS: Array<[string, string]> = [
      ["2026-03-01", "2026-03-31"], ["2026-09-01", "2026-09-30"], ["2026-10-01", "2026-10-31"], ["2026-11-01", "2026-11-30"],
      ["2026-12-01", "2026-12-31"], ["2026-03-29", "2026-03-29"], ["2026-10-25", "2026-10-25"],
    ];
    const seen: Record<string, number> = { ok: 0, open: 0, suspicious: 0, approved: 0, rejected: 0, orphans: 0, overnight: 0, dstDays: 0, ties: 0 };
    for (let k = 0; k < 300; k++) {
      let t = Date.parse(pick(ANCHORS).replace(" ", "T") + "Z") + Math.floor(rnd() * 6 * 60) * 60_000;
      const n = 2 + Math.floor(rnd() * 9);
      const ids = shuffle(Array.from({ length: n }, (_, i) => i + 1));
      const recs: TimeRecordLike[] = [];
      for (let i = 0; i < n; i++) {
        const type = (i % 2 === 0) !== (rnd() < 0.15) ? "check_in" : "check_out";
        recs.push({
          id: ids[i], type, recordedAt: new Date(t).toISOString().slice(0, 19).replace("T", " "),
          hoursWorked: pick(HOURS), notes: pick(NOTES), reviewStatus: pick(STATUS) as TimeRecordLike["reviewStatus"],
          terminalStatus: pick([null, "terminal", "partial"]), terminalUntil: null,
        });
        const gap = pick(GAPS_MIN);
        if (gap === 0) seen.ties++;
        t += gap * 60_000 + (gap === 0 ? 0 : Math.floor(rnd() * 60) * 1000);
      }
      const input = shuffle(recs); // o emparelhamento ordena por hora e, no empate, pelo id
      const full = same(input);
      for (const [first, last] of WINDOWS) {
        expect(pontoMonthSummary(input, first, last), `${k} ${first}`).toEqual(refSummary(full.shifts, first, last));
      }
      seen.orphans += full.orphans.length;
      for (const s of full.shifts) {
        seen[s.status]++;
        if (s.outAt && s.daysTouched.length > 1) seen.overnight++;
        if (s.day === "2026-03-29" || s.day === "2026-10-25") seen.dstDays++;
      }
    }
    // o gerador passou mesmo pelos casos difíceis
    for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(0);
  });

  it("a folha continua no caminho com a divisão; só o resumo do mês usa o caminho rápido", () => {
    // sábado 21h → domingo 05h em Lisboa (verão): 8 h de fim de semana
    const recs = [r(1, "check_in", "2026-10-03 20:00:00"), r(2, "check_out", "2026-10-04 04:00:00")];
    const full = pairShifts(recs).shifts[0];
    expect(full.split).toEqual({ normal: 0, night: 0, weekend: 8 });
    expect(full.daysTouched).toEqual(["2026-10-03", "2026-10-04"]);
    // o caminho rápido salta mesmo a divisão (por isso não pode servir a folha)
    expect(pairShifts(recs, { split: false }).shifts[0].split).toEqual({ normal: 0, night: 0, weekend: 0 });
    // quem passa `split: false` no código: só o pontoMonthSummary
    const users: string[] = [];
    for (const dir of ["server", "shared"]) {
      for (const f of readdirSync(resolve(__dirname, "..", dir), { recursive: true }) as string[]) {
        if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
        if (src(`${dir}/${f}`).includes("{ split: false }")) users.push(`${dir}/${f}`);
      }
    }
    expect(users).toEqual(["server/payroll/shifts.ts"]);
    const shifts = src("server/payroll/shifts.ts");
    expect(shifts.match(/pairShifts\([^)]*\{ split: false \}\)/g)).toEqual(["pairShifts(records, { split: false })"]);
    const summary = shifts.slice(shifts.indexOf("export function pontoMonthSummary"), shifts.indexOf("export function pontoMonthWindow"));
    expect(summary).toContain("pairShifts(records, { split: false })");
    expect(src("server/payroll/payrollData.ts")).toContain("pairShifts((recordsByEmp.get(employeeId) ?? []).map(toShiftLike)).shifts");
  });
});

describe("Auditoria D — âmbito: ninguém vê fichas, contagens ou horas de outra cidade", () => {
  const lisboa = { all: false, defaultCityId: 49, cityName: "Lisboa", cityIds: [49], projectIds: [49], missingCostCenter: false };

  it("o projectId do topo nunca alarga: Lisboa a pedir o Porto → FORBIDDEN em todas as leituras do PR", async () => {
    h.access = lisboa;
    const sup = caller("supervisor");
    await expect(sup.rh.list({ isActive: true, projectId: 50 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(sup.rh.stats({ projectId: 50 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(sup.rh.stats({ projectId: 65 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(sup.training.quizRanking({ projectId: 50 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(sup.training.careerExamAttempts({ projectId: 50 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // sem cidade no topo: só a dele (contagens e documentos)
    expect((await sup.rh.stats()).totalActive).toBe(1);
    expect(Object.keys(await sup.rh.documents.allStatus()).map(Number)).toEqual([1]);
  });

  it("o team leader só conta quem está abaixo dele no seu centro — as mesmas fichas da lista", async () => {
    h.me = { employee: { id: 99, projectId: 50, position: "team_leader", isActive: 1 } };
    const tl = caller("team_leader");
    const list = await tl.rh.list({ isActive: true });
    expect(list.map((x: any) => x.employee.id).sort((a: number, b: number) => a - b)).toEqual([2, 3, 4, 9, 10, 11]);
    const s = await tl.rh.stats();
    expect(s).toMatchObject({ totalActive: list.length, staff: 2, extras: 3, partners: 1 });
    // documentos: ativas e não ativas abaixo dele (o backoffice 8 e Lisboa ficam de fora)
    expect(Object.keys(await tl.rh.documents.allStatus()).map(Number).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 9, 10, 11]);
  });

  it("o relatório posto ≠ contrato é só do super admin, no servidor", async () => {
    for (const role of ["admin", "backoffice", "frontoffice", "supervisor", "team_leader", "user"]) {
      await expect(caller(role).rh.extraMismatch(), role).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("nada novo leva ordenados, IBAN ou NIF: só contagens, horas e resumos de documentos", async () => {
    h.docs = new Map([[2, [{ docType: "photo", status: "validated" }]]]);
    // valores e nomes de campos (o tipo de documento "nib_proof" é só o nome do documento em falta)
    const leaks = (v: unknown) => /1234\.56|1234,56|PT5000|123456789|"monthlySalary"|"nib"|"nif"|"iban"/i.test(JSON.stringify(v));
    for (const role of ["backoffice", "supervisor", "admin"]) {
      const stats = await caller(role).rh.stats();
      expect(Object.keys(stats).sort(), role).toEqual(
        ["extras", "month", "monthlyHours", "monthlyHoursError", "monthlySuspiciousHours", "partners", "staff", "totalActive", "totalExtras", "totalPermanent"]);
      expect(leaks(stats), role).toBe(false);
      expect(leaks(await caller(role).rh.documents.allStatus()), role).toBe(false);
    }
    const mismatch = await caller("super_admin").rh.extraMismatch();
    expect(mismatch.length).toBeGreaterThan(0);
    expect(leaks(mismatch)).toBe(false);
  });
});

describe("Auditoria D — Geral: o admin nacional vê o mesmo total de antes; só mudam o que o plano decidiu", () => {
  it("sem cidade, todas as cidades e também as fichas sem centro; efetivos/extras pela regra única (P1)", async () => {
    h.access = { all: true, defaultCityId: null, cityIds: [49, 50], projectIds: [48, 49, 50, 65], missingCostCenter: false };
    const s = await caller("admin").rh.stats();
    const active = h.employees.filter((x) => x.employee.isActive === 1).map((x) => x.employee);
    // a conta antiga (getHRStats antes do D1): count(*) das fichas ativas, sem âmbito
    expect(s.totalActive).toBe(active.length);
    expect(s.totalActive).toBe(9);
    // o que muda de propósito: extras = posto OU contrato; efetivos = funcionários (sem termo e a termo)
    const oldExtras = active.filter((e) => e.position === "extra").length;
    const oldPermanent = active.filter((e) => e.contractType === "permanent").length;
    expect([oldExtras, oldPermanent]).toEqual([2, 4]);
    expect([s.totalExtras, s.totalPermanent, s.partners]).toEqual([3, 5, 1]);
    expect(s.totalPermanent + s.totalExtras + s.partners).toBe(s.totalActive);
  });

  it("quem não tem acesso nacional vê a sua cidade (o mesmo âmbito por omissão da lista)", async () => {
    const s = await caller("supervisor").rh.stats();
    const list = await caller("supervisor").rh.list({ isActive: true });
    expect(s.totalActive).toBe(list.length);
    expect(list.every((x: any) => [50, 65].includes(x.employee.projectId))).toBe(true);
  });
});

describe("Auditoria D — D10 não mexe no custo dos extras nem no Parado", () => {
  it("o custo da Atividade vem da escala; o ponto só escreve a coluna Ponto", () => {
    const a = src("server/dayActivity.ts");
    expect(a).toContain("else if (a.level) cost = hours * rateFor(rates, a.level);");
    expect(a.match(/\.pontoHours\s*=/g)).toEqual([".pontoHours ="]);
    expect(a).not.toMatch(/cost[^\n]*pontoHours|pontoHours[^\n]*cost/);
    // o "Parado" do Resumo do dia é do GPS do turno (shiftDayDetail) ou do dia — nunca do ponto
    expect(src("server/shiftDayDetail.ts")).not.toContain("pontoHours");
    const w = src("shared/dayWorkSummary.ts");
    expect(w.slice(w.indexOf("export function stoppedHours"), w.indexOf("export function fmtHours"))).not.toContain("pontoHours");
  });

  it("Resumo do dia: as horas trabalhadas são as da coluna Ponto; sem turnos que contem, o Zello (~) — e está na ajuda", () => {
    expect(workedHours({ pontoHours: 8, hoursOnline: 9, hoursWorked: 5 })).toEqual({ hours: 8, source: "ponto" });
    expect(workedHours({ pontoHours: null, hoursOnline: 9.04, hoursWorked: 5 })).toEqual({ hours: 9, source: "zello" });
    expect(src("docs/ajuda/atividade-diaria.md")).toContain("pela regra da coluna Ponto da Atividade do Dia");
  });
});

describe("Auditoria D — ajuda", () => {
  it("'funcionários' leva à barra do RH; 'Como funciona isto?' continua na página aberta", () => {
    const hits = searchHelpSections(knowledgeTree(), "funcionários", { max: 3 });
    expect(hits[0]?.section.id).toBe("rh-ponto.md#barra-de-numeros-do-rh-total-ativos-funcionarios-extras-hora");
    const docs = staffHelpDocs();
    expect(pickHelpDocs(docs, "Como funciona isto?", { path: "/rh" }).map((d) => d.file)).toEqual(["rh-ponto.md"]);
    expect(pickHelpDocs(docs, "Como funciona isto?", { path: "/pessoas-dashboard" }).map((d) => d.file)).toEqual(["dashboards.md"]);
  });
});
