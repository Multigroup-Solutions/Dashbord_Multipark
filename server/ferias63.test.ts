/**
 * Plano 63, passo 11 — mapa de férias: regras puras (tabela 11.3, quem vê o
 * quê, datas, mês fechado, aviso antes de escalado), os leitores só com as
 * aprovadas, a migração 0830, os interruptores e as definições.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  DEFAULT_VACATION_APPROVALS, FERIAS_AVISOS_FLAG, FERIAS_MAPA_FLAG, HR_PEOPLE_KEY, LEAVES_VIEW_ALL_KEY, VACATION_APPROVALS_KEY, VACATION_DAYS_PER_YEAR_KEY,
  absenceForScheduler, cancelLeaveError, closedMonthMessage, closedMonthOfPeriod, decideLeaveError, isRealIsoDay, leaveForViewer, leaveInputError,
  leaveViewerMode, monthsOfPeriod, noticeBeforeAssignment, parseApproverIds, schedulerAbsenceText, vacationApprovalsSchema, vacationApproversFor,
  vacationDaysInYear, vacationYearWarning, workingDaysIn, type ApproverCandidate, type VacationApprovals,
} from "../shared/leaves";
import { AUTOMATION_FLAGS, SETTINGS, automationFlagDefault, automationFlagSuperAdminOnly, settingSuperAdminOnly, validateSetting } from "../shared/appSettings";
import { approvedLeaveSql, fullDayLeaveSql } from "./leavesSql";
import { computeEmployeeMonth } from "./payroll/compute";

const root = resolve(import.meta.dirname, "..");
const src = (p: string) => readFileSync(resolve(root, p), "utf8");
const render = (q: any) => new MySqlDialect().sqlToQuery(q).sql;

// ─── Tabela 11.3: quem aprova quem ──────────────────────────────────────────

// Contas (sem nomes no código: aqui são só números)
const SUPER = 1, DIRECAO = 2, RH = 3, SUP_LX = 4, SUP_PT = 5, SUP_ALL = 6, OUTRO = 7, INATIVO_SUP = 8;
const users: ApproverCandidate[] = [
  { id: SUPER, role: "super_admin", isActive: true },
  { id: DIRECAO, role: "admin", isActive: true },
  { id: RH, role: "backoffice", isActive: true },
  { id: SUP_LX, role: "supervisor", isActive: true, cities: ["lisbon"] },
  { id: SUP_PT, role: "supervisor", isActive: true, cities: ["porto"] },
  { id: SUP_ALL, role: "supervisor", isActive: true, cities: "all" },
  { id: OUTRO, role: "admin", isActive: true },
  { id: INATIVO_SUP, role: "supervisor", isActive: false, cities: ["lisbon"] },
];
const hrPeople = [RH];
/** As regras do Jorge, com a direção escolhida para os supervisores e as exceções por pessoa. */
const rules: VacationApprovals = {
  ...DEFAULT_VACATION_APPROVALS,
  positions: { ...DEFAULT_VACATION_APPROVALS.positions, supervisor: { approvers: ["super_admin", "accounts"], userIds: [DIRECAO] } },
  people: [
    { employeeId: 600, approvers: ["super_admin"], userIds: [], note: "supervisor de todas as cidades" },
    { employeeId: 700, approvers: ["super_admin"], userIds: [] },
  ],
};
const req = (employeeId: number, position: string | null, city: string | null, userIds: number[] = []) => ({ employeeId, position, city, userIds });
const approvers = (r: ReturnType<typeof req>, ru: VacationApprovals = rules, hr = hrPeople) => vacationApproversFor(r, ru, users, hr);

describe("tabela 11.3 — quem aprova quem (configurável, basta um)", () => {
  it("team leader → RH ou supervisor da cidade (o de todas as cidades também cobre)", () => {
    expect(approvers(req(10, "team_leader", "lisbon", [20]))).toEqual({ userIds: [RH, SUP_LX, SUP_ALL], kind: "position", fallback: false });
  });
  it("front office → supervisor da cidade ou RH (a cidade é a da ficha de quem pede)", () => {
    expect(approvers(req(11, "frontoffice", "porto", [21])).userIds).toEqual([RH, SUP_PT, SUP_ALL]);
  });
  it("back office → RH", () => {
    expect(approvers(req(12, "backoffice", "lisbon", [22])).userIds).toEqual([RH]);
  });
  it("supervisor de uma cidade → super admin ou as contas escolhidas (a direção)", () => {
    expect(approvers(req(13, "supervisor", "lisbon", [SUP_LX])).userIds).toEqual([SUPER, DIRECAO]);
  });
  it("supervisor de todas as cidades e outra pessoa à parte → exceção por pessoa (super admin)", () => {
    expect(approvers(req(600, "supervisor", null, [SUP_ALL]))).toEqual({ userIds: [SUPER], kind: "person", fallback: false });
    expect(approvers(req(700, "director", "lisbon", [OUTRO]))).toEqual({ userIds: [SUPER], kind: "person", fallback: false });
  });
  it("quem está no RH → super admin (ganha ao posto)", () => {
    expect(approvers(req(14, "backoffice", "lisbon", [RH]))).toEqual({ userIds: [SUPER], kind: "hr", fallback: false });
  });
  it("diretor → super admin; condutores com contrato → supervisor da cidade ou RH", () => {
    expect(approvers(req(15, "director", "lisbon", [25])).userIds).toEqual([SUPER]);
    expect(approvers(req(16, "driver", "faro", [26])).userIds).toEqual([RH, SUP_ALL]);
    expect(approvers(req(17, "senior_driver", "lisbon", [27])).userIds).toEqual([RH, SUP_LX, SUP_ALL]);
  });
  it("ninguém aprova as suas: as contas da própria ficha saem; sem ninguém → super admin", () => {
    // um back office que está no RH e cuja regra fosse "RH" → ficava ele próprio → cai no super admin
    const onlyHr: VacationApprovals = { ...rules, hrPeople: { approvers: ["hr"], userIds: [] } };
    expect(approvers(req(18, "backoffice", "lisbon", [RH]), onlyHr)).toEqual({ userIds: [SUPER], kind: "hr", fallback: true });
    // o supervisor de Lisboa não aprova as suas (e o inativo nunca aprova)
    expect(approvers(req(19, "team_leader", "lisbon", [SUP_LX])).userIds).toEqual([RH, SUP_ALL]);
  });
  it("posto sem regra (ou regra vazia) → super admin (rede de segurança)", () => {
    expect(approvers(req(30, "extra", "lisbon", [40]))).toMatchObject({ userIds: [SUPER], kind: "default" });
    const empty: VacationApprovals = { ...rules, positions: { ...rules.positions, backoffice: { approvers: [], userIds: [] } } };
    expect(approvers(req(31, "backoffice", "lisbon", [41]), empty)).toEqual({ userIds: [SUPER], kind: "position", fallback: true });
  });
  it("RH configurado mas inativo/inexistente não conta; contas escolhidas inativas também não", () => {
    expect(approvers(req(32, "backoffice", "lisbon", [42]), rules, [99])).toEqual({ userIds: [SUPER], kind: "position", fallback: true });
  });
  it("a omissão não tem nomes nem contas (escolhem-se nas Definições) e passa na validação", () => {
    const r = vacationApprovalsSchema.safeParse(DEFAULT_VACATION_APPROVALS);
    expect(r.success).toBe(true);
    for (const rule of Object.values(DEFAULT_VACATION_APPROVALS.positions)) expect(rule?.userIds).toEqual([]);
    expect(DEFAULT_VACATION_APPROVALS.people).toEqual([]);
    expect(DEFAULT_VACATION_APPROVALS.positions.team_leader?.approvers).toEqual(["hr", "city_supervisor"]);
    expect(DEFAULT_VACATION_APPROVALS.positions.frontoffice?.approvers).toEqual(["city_supervisor", "hr"]);
    expect(DEFAULT_VACATION_APPROVALS.positions.backoffice?.approvers).toEqual(["hr"]);
    expect(DEFAULT_VACATION_APPROVALS.positions.supervisor?.approvers).toEqual(["super_admin", "accounts"]);
    expect(DEFAULT_VACATION_APPROVALS.hrPeople.approvers).toEqual(["super_admin"]);
    expect(vacationApprovalsSchema.safeParse({ ...DEFAULT_VACATION_APPROVALS, people: [{ employeeId: 1, approvers: ["x"], userIds: [] }] }).success).toBe(false);
    expect(vacationApprovalsSchema.safeParse({ ...DEFAULT_VACATION_APPROVALS, people: [{ employeeId: 1, approvers: [], userIds: [] }, { employeeId: 1, approvers: [], userIds: [] }] }).success).toBe(false);
    for (const f of ["shared/leaves.ts", "server/leaves.ts", "server/leavesRouter.ts", "shared/appSettings.ts", "client/src/components/ferias/VacationApprovalsEditor.tsx"]) {
      expect(src(f), f).not.toMatch(/C[áa]tia|Camila|Lu[íi]s\b|Tabuada/);
    }
  });
});

// ─── Aprovar, recusar, cancelar ──────────────────────────────────────────────

describe("aprovar / recusar / cancelar (nunca apagar)", () => {
  const pedido = { employeeId: 10, status: "requested", leaveType: "vacation", approverUserIds: [RH, SUP_LX] };
  it("só quem está na lista do pedido (ou o super admin); ninguém aprova as suas; um pedido tratado não volta", () => {
    expect(decideLeaveError({ userId: RH, role: "backoffice", employeeId: 3 }, pedido, [20])).toBeNull();
    expect(decideLeaveError({ userId: SUPER, role: "super_admin", employeeId: 1 }, pedido, [20])).toBeNull();
    expect(decideLeaveError({ userId: OUTRO, role: "admin", employeeId: 7 }, pedido, [20])).toMatch(/Não estás entre quem aprova/);
    expect(decideLeaveError({ userId: 20, role: "super_admin", employeeId: 10 }, pedido, [20])).toMatch(/Ninguém aprova as suas/);
    expect(decideLeaveError({ userId: RH, role: "backoffice", employeeId: 3 }, pedido, [RH])).toMatch(/Ninguém aprova as suas/);
    expect(decideLeaveError({ userId: RH, role: "backoffice", employeeId: 3 }, { ...pedido, status: "approved" }, [20])).toMatch(/já foi tratado/);
  });
  it("cancelar: o próprio o pedido (e o extra o seu aviso); as aprovadas quem aprova, quem gere a ficha ou o super admin", () => {
    const me = { userId: 20, role: "team_leader", employeeId: 10, canManage: false };
    expect(cancelLeaveError(me, pedido, [20])).toBeNull();
    expect(cancelLeaveError(me, { ...pedido, status: "approved" }, [20])).toMatch(/só as cancela quem as aprova/);
    expect(cancelLeaveError({ ...me, role: "extra" }, { ...pedido, leaveType: "unavailable", status: "approved" }, [20])).toBeNull();
    expect(cancelLeaveError({ userId: SUP_LX, role: "supervisor", employeeId: 4, canManage: false }, { ...pedido, status: "approved" }, [20])).toBeNull();
    expect(cancelLeaveError({ userId: OUTRO, role: "admin", employeeId: 7, canManage: true }, { ...pedido, status: "approved", approverUserIds: [] }, [20])).toBeNull();
    expect(cancelLeaveError({ userId: OUTRO, role: "admin", employeeId: 7, canManage: false }, { ...pedido, status: "approved", approverUserIds: [] }, [20])).toMatch(/Sem permissão/);
    expect(cancelLeaveError({ userId: SUPER, role: "super_admin", employeeId: 1, canManage: false }, { ...pedido, status: "cancelled" }, [20])).toMatch(/Já está cancelado/);
  });
  it("o DELETE desapareceu: rh.leaves.delete cancela e nada apaga employee_leaves", () => {
    const router = src("server/leavesRouter.ts");
    const del = router.slice(router.indexOf("delete: protectedProcedure"), router.indexOf("cancel: protectedProcedure"));
    expect(del).toContain("await assertCanManageEmployee(ctx.user, empId);");
    expect(del).toContain("await cancelLeave(");
    const files = listServerTs();
    for (const f of files) {
      const s = src(f);
      expect(s, f).not.toMatch(/db\.delete\(employeeLeaves\)|DELETE\s+FROM\s+`?employee_leaves/i);
    }
    expect(src("server/db.ts")).not.toContain("deleteEmployeeLeave");
    expect(src("server/db.ts")).toMatch(/export async function cancelEmployeeLeave[\s\S]{0,700}status: "cancelled"[\s\S]{0,300}inArray\(employeeLeaves\.status, \["requested", "approved"\]\)/);
  });
  it("lê a lista de quem podia aprovar (JSON) sem partir", () => {
    expect(parseApproverIds([3, "4", null])).toEqual([3, 4]);
    expect(parseApproverIds("[5,6]")).toEqual([5, 6]);
    expect(parseApproverIds("lixo")).toEqual([]);
    expect(parseApproverIds(null)).toEqual([]);
  });
});

// ─── Quem vê o quê ───────────────────────────────────────────────────────────

describe("quem vê o quê (filtro do servidor)", () => {
  const mode = (o: Partial<Parameters<typeof leaveViewerMode>[0]>) => leaveViewerMode({ role: "driver", userId: 50, hasEmployee: true, isExtra: false, viewAll: [], hrPeople: [], ...o });
  it("tudo: super admin, as contas de rh.leavesViewAll e o RH; supervisor: a sua área; colegas; extras", () => {
    expect(mode({ role: "super_admin" })).toBe("full");
    expect(mode({ role: "admin", viewAll: [50] })).toBe("full");
    expect(mode({ role: "backoffice", hrPeople: [50] })).toBe("full");
    expect(mode({ role: "supervisor" })).toBe("supervisor");
    expect(mode({ role: "supervisor", hrPeople: [50] })).toBe("full");
    expect(mode({ role: "backoffice" })).toBe("employee");
    expect(mode({ role: "team_leader" })).toBe("employee");
    expect(mode({ role: "extra", isExtra: true })).toBe("extra");
    expect(mode({ role: "user", hasEmployee: false })).toBe("none");
  });
  const baixa = { id: 1, employeeId: 9, leaveType: "sick", status: "approved", fromDate: "2026-11-02", toDate: "2026-11-06", hours: null, notes: "atestado", decisionNote: "ok" };
  const ferias = { ...baixa, id: 2, leaveType: "vacation", status: "requested", notes: "casamento" };
  const indisp = { ...baixa, id: 3, leaveType: "unavailable", notes: "exames" };
  it("os colegas nunca veem as baixas (nem as notas); só as férias pedidas/aprovadas", () => {
    expect(leaveForViewer("employee", false, baixa)).toBeNull();
    expect(leaveForViewer("employee", false, indisp)).toBeNull();
    expect(leaveForViewer("employee", false, ferias)).toMatchObject({ leaveType: "vacation", notes: null, decisionNote: null });
    expect(leaveForViewer("employee", false, { ...ferias, status: "cancelled" })).toBeNull();
    expect(leaveForViewer("employee", false, { ...ferias, status: "rejected" })).toBeNull();
    expect(leaveForViewer("extra", false, ferias)).toBeNull();
    expect(leaveForViewer("none", false, ferias)).toBeNull();
  });
  it("o supervisor vê \"ausente\" sem o motivo; as férias e as indisponibilidades como são", () => {
    expect(leaveForViewer("supervisor", false, baixa)).toMatchObject({ leaveType: "absent", notes: null, decisionNote: null });
    for (const t of ["unpaid", "other"]) expect(leaveForViewer("supervisor", false, { ...baixa, leaveType: t })?.leaveType).toBe("absent");
    expect(leaveForViewer("supervisor", false, ferias)?.leaveType).toBe("vacation");
    expect(leaveForViewer("supervisor", false, indisp)?.leaveType).toBe("unavailable");
  });
  it("o próprio e quem vê tudo: o tipo e as notas", () => {
    expect(leaveForViewer("employee", true, baixa)).toMatchObject({ leaveType: "sick", notes: "atestado" });
    expect(leaveForViewer("full", false, baixa)).toMatchObject({ leaveType: "sick", notes: "atestado" });
  });
  it("o mapa, a ficha (rh.leaves.list) e o PDF passam todos pelo filtro do servidor", () => {
    const s = src("server/leaves.ts");
    expect(s).toMatch(/function shownLeave[\s\S]{0,300}leaveForViewer\(v\.mode, own, row\)/);
    const ficha = s.slice(s.indexOf("export async function leavesForEmployee"));
    expect(ficha).toContain('const mode: LeaveViewerMode = own || v.mode === "full" ? "full" : "supervisor";');
    expect(ficha).toContain("leaveForViewer(mode, own, r)");
    expect(src("server/leavesRouter.ts")).toContain('return leavesForEmployee(await resolveLeaveViewer(ctx.user), input.employeeId, input.year);');
    // PDF: só férias aprovadas (nunca baixas), só para quem vê tudo e o supervisor
    const pdf = s.slice(s.indexOf("export async function leaveMapForPdf"));
    expect(pdf).toContain('if (l.leaveType !== "vacation" || l.status !== "approved") continue;');
    expect(src("server/leavesRouter.ts")).toContain('if (v.mode !== "full" && v.mode !== "supervisor") throw new TRPCError({ code: "FORBIDDEN"');
  });
  it("quem escala no Extras-Dia vê \"indisponível (avisou a DD/MM)\", férias ou \"ausente\" — nunca a baixa", () => {
    const a = absenceForScheduler({ leaveType: "unavailable", status: "approved", fromDate: "2026-11-02", toDate: "2026-11-03", requestedAt: "2026-10-30 09:00:00" });
    expect(a).toEqual({ kind: "unavailable", fromDate: "2026-11-02", toDate: "2026-11-03", noticeDay: "2026-10-30", partial: false });
    expect(schedulerAbsenceText(a)).toBe("Indisponível (avisou a 30/10)");
    expect(schedulerAbsenceText(absenceForScheduler({ leaveType: "sick", fromDate: "2026-11-02", toDate: "2026-11-02" }))).toBe("Ausente");
    expect(schedulerAbsenceText(absenceForScheduler({ leaveType: "vacation", fromDate: "2026-11-02", toDate: "2026-11-02" }))).toBe("De férias");
    expect(schedulerAbsenceText(null)).toBeNull();
  });
});

// ─── Datas e dias úteis ──────────────────────────────────────────────────────

describe("datas validadas e parte do dia", () => {
  it("só datas que existem, início ≤ fim, no máximo um ano", () => {
    expect(isRealIsoDay("2026-02-28")).toBe(true);
    expect(isRealIsoDay("2026-02-30")).toBe(false);
    expect(isRealIsoDay("2026-1-5")).toBe(false);
    expect(leaveInputError({ leaveType: "vacation", fromDate: "2026-1-5", toDate: "2026-01-09" })).toMatch(/início inválida/);
    expect(leaveInputError({ leaveType: "vacation", fromDate: "2026-08-10", toDate: "2026-08-03" })).toMatch(/antes da de início/);
    expect(leaveInputError({ leaveType: "vacation", fromDate: "2026-01-01", toDate: "2027-01-02" })).toMatch(/um ano/);
    expect(leaveInputError({ leaveType: "vacation", fromDate: "2026-08-03", toDate: "2026-08-14" })).toBeNull();
    expect(leaveInputError({ leaveType: "férias", fromDate: "2026-08-03", toDate: "2026-08-14" })).toMatch(/desconhecido/);
  });
  it("parte do dia: só ausência justificada, um dia, 0,25 h a 12 h em quartos de hora", () => {
    expect(leaveInputError({ leaveType: "other", fromDate: "2026-11-03", toDate: "2026-11-03", hours: 2.5 })).toBeNull();
    expect(leaveInputError({ leaveType: "vacation", fromDate: "2026-11-03", toDate: "2026-11-03", hours: 2 })).toMatch(/ausência justificada/);
    expect(leaveInputError({ leaveType: "other", fromDate: "2026-11-03", toDate: "2026-11-04", hours: 2 })).toMatch(/um só dia/);
    expect(leaveInputError({ leaveType: "other", fromDate: "2026-11-03", toDate: "2026-11-03", hours: 13 })).toMatch(/Horas entre/);
    expect(leaveInputError({ leaveType: "other", fromDate: "2026-11-03", toDate: "2026-11-03", hours: 1.1 })).toMatch(/quartos de hora/);
  });
  it("o servidor valida as datas no pedido e no lançamento (antes aceitava qualquer texto)", () => {
    const r = src("server/leavesRouter.ts");
    expect(r).toContain('const isoDay = z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/, "Data inválida (AAAA-MM-DD).");');
    const s = src("server/leaves.ts");
    expect(s.slice(s.indexOf("export async function requestLeave"))).toMatch(/leaveInputError\(\{ leaveType, fromDate: input\.fromDate, toDate: input\.toDate \}\)/);
    expect(s.slice(s.indexOf("export async function launchLeave"))).toContain("const err = leaveInputError(input);");
  });
  it("dias úteis: sem fins de semana nem feriados (nacionais e o municipal da cidade)", () => {
    expect(workingDaysIn("2026-08-03", "2026-08-14")).toBe(10);
    // 4 jun (Corpo de Deus) e 10 jun (Dia de Portugal)
    expect(workingDaysIn("2026-06-01", "2026-06-12", "lisbon")).toBe(8);
    // 24 jun: São João só no Porto
    expect(workingDaysIn("2026-06-22", "2026-06-26", "porto")).toBe(4);
    expect(workingDaysIn("2026-06-22", "2026-06-26", "lisbon")).toBe(5);
    // passagem de ano: só os dias do ano contam para o total desse ano
    expect(vacationDaysInYear([{ leaveType: "vacation", status: "approved", fromDate: "2026-12-28", toDate: "2027-01-08" }], 2026)).toBe(4);
    expect(vacationDaysInYear([{ leaveType: "vacation", status: "approved", fromDate: "2026-12-28", toDate: "2027-01-08" }], 2027)).toBe(5);
  });
  it("total do ano: pedidas + aprovadas (as recusadas/canceladas e as baixas não); 22 é só aviso", () => {
    const ls = [
      { leaveType: "vacation", status: "approved", fromDate: "2026-08-03", toDate: "2026-08-14" },
      { leaveType: "vacation", status: "requested", fromDate: "2026-10-19", toDate: "2026-10-23" },
      { leaveType: "vacation", status: "rejected", fromDate: "2026-11-02", toDate: "2026-11-06" },
      { leaveType: "vacation", status: "cancelled", fromDate: "2026-11-09", toDate: "2026-11-13" },
      { leaveType: "sick", status: "approved", fromDate: "2026-03-02", toDate: "2026-03-06" },
    ];
    expect(vacationDaysInYear(ls, 2026)).toBe(15);
    expect(vacationYearWarning(15, 22)).toBeNull();
    expect(vacationYearWarning(25, 22)).toMatch(/25 dias úteis.*22.*só um aviso/);
    expect(vacationYearWarning(25, 0)).toBeNull();
  });
});

// ─── Mês fechado ─────────────────────────────────────────────────────────────

describe("mês fechado (ordenado aprovado ou pago): nada muda", () => {
  it("o período toca um mês fechado → recusa com o mês", () => {
    expect(monthsOfPeriod("2026-12-28", "2027-01-08")).toEqual(["2026-12", "2027-01"]);
    const closed = new Set(["2026-09"]);
    expect(closedMonthOfPeriod({ fromDate: "2026-09-28", toDate: "2026-10-02" }, closed)).toBe("2026-09");
    expect(closedMonthOfPeriod({ fromDate: "2026-10-01", toDate: "2026-10-02" }, closed)).toBeNull();
    expect(closedMonthMessage("2026-09")).toBe("O mês de setembro de 2026 já está fechado (ordenado aprovado ou pago): não se muda.");
  });
  it("pedir, aprovar, cancelar e lançar confirmam o fecho (falha a ler → não grava)", () => {
    const s = src("server/leaves.ts");
    const fn = (name: string) => s.slice(s.indexOf(`export async function ${name}`), s.indexOf("\n}\n", s.indexOf(`export async function ${name}`)));
    expect(fn("requestLeave")).toContain("await assertPeriodOpen(input);");
    expect(fn("decideLeave")).toContain("if (input.approve) await assertPeriodOpen(leave);");
    expect(fn("cancelLeave")).toContain("await assertPeriodOpen(leave);");
    expect(fn("launchLeave")).toContain("await assertPeriodOpen(input);");
    expect(fn("assertPeriodOpen")).toContain("closedPayrollMonthKeys()");
    expect(fn("assertPeriodOpen")).toContain("Não deu para confirmar se o mês está fechado: nada foi gravado.");
  });
});

// ─── Extras: avisar antes / depois de ser escalado ───────────────────────────

describe("extras: \"não vou estar\" antes de ser escalado → falta sem pontos; depois → falta normal", () => {
  const aviso = { leaveType: "unavailable", status: "approved", fromDate: "2026-11-02", toDate: "2026-11-04", hours: null, requestedAt: "2026-10-30 09:00:00" };
  it("avisou antes da linha da escala → justifica", () => {
    expect(noticeBeforeAssignment([aviso], "2026-11-03", "2026-11-01 12:00:00")).toBe(aviso);
  });
  it("avisou depois de ser escalado → não justifica (ninguém foge a uma falta à última hora)", () => {
    expect(noticeBeforeAssignment([aviso], "2026-11-03", "2026-10-29 12:00:00")).toBeNull();
  });
  it("fora do período, de parte do dia, ou não aprovada → não justifica", () => {
    expect(noticeBeforeAssignment([aviso], "2026-11-05", "2026-11-01 12:00:00")).toBeNull();
    expect(noticeBeforeAssignment([{ ...aviso, hours: "2.00" }], "2026-11-03", "2026-11-01 12:00:00")).toBeNull();
    expect(noticeBeforeAssignment([{ ...aviso, status: "cancelled" }], "2026-11-03", "2026-11-01 12:00:00")).toBeNull();
    expect(noticeBeforeAssignment([aviso], "2026-11-03", null)).toBeNull();
  });
  it("sem requestedAt (linhas antigas) conta a data em que foi lançada", () => {
    expect(noticeBeforeAssignment([{ ...aviso, requestedAt: null, createdAt: "2026-10-30 09:00:00" }], "2026-11-03", "2026-11-01 12:00:00")).not.toBeNull();
  });
  it("a deteção dá 0 pontos só com o aviso antes e só com FERIAS_MAPA ligado", () => {
    const s = src("server/rhService.ts");
    const fn = s.slice(s.indexOf("export async function detectExtraDiaNoShows"), s.indexOf("// ─── Tarefa 62 (Q8)"));
    expect(fn).toContain("createdAt: extrasDiaAssignments.createdAt");
    // com o 2b: avisou antes → 0 (com a nota); senão funcionário 0, extra 1
    expect(fn).toContain("const points = notice ? 0 : extraDiaNoShowPoints(kindOf.get(r.employeeId));");
    const helper = s.slice(s.indexOf("async function noticesForNoShows"), s.indexOf("export interface NoShowReport"));
    expect(helper).toContain("if (!isFeatureEnabled(FERIAS_MAPA_FLAG, { defaultEnabled: automationFlagDefault(FERIAS_MAPA_FLAG) })) return out;");
  });
});

// ─── Leitores: só as aprovadas ───────────────────────────────────────────────

function listServerTs(dir = resolve(root, "server")): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { out.push(...listServerTs(p)); continue; }
    if (f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".generated.ts")) out.push(p.slice(root.length + 1));
  }
  return out;
}

/** Leem `employee_leaves` SEM contar ausências — lista escrita (plano §11.4). */
const READER_EXCEPTIONS: Record<string, string> = {
  "server/rhGuards.ts": "employeeIdOfRecord: só a ficha do registo",
  "server/leavesRouter.ts": "employeeIdOfRecord (cancelar) e o router do mapa",
  "server/leaves.ts": "o próprio mapa: mostra pedidos, recusas e cancelamentos a quem os pode ver",
  "server/leavesSql.ts": "a definição da expressão",
  "server/mergeDuplicateExtras.ts": "junção de extras: conta todas as linhas, só informativo",
  "server/evaluationCore.ts": "pura: recebe as ausências já filtradas pelo evaluationEngine",
};

describe("leitores: só ausências aprovadas (approvedLeaveSql)", () => {
  it("a expressão: aprovadas e sem a indisponibilidade dos extras; dia inteiro = sem horas", () => {
    expect(render(approvedLeaveSql())).toBe("(`status` = 'approved' AND `leaveType` <> 'unavailable')");
    expect(render(approvedLeaveSql("l"))).toBe("(l.`status` = 'approved' AND l.`leaveType` <> 'unavailable')");
    expect(render(fullDayLeaveSql())).toBe("`hours` IS NULL");
  });
  it("todos os ficheiros de server/ que leem employee_leaves usam approvedLeaveSql (fora a lista de exceções)", () => {
    const readers = listServerTs().filter((f) => !f.startsWith("server/migrations/") && /employee_leaves|employeeLeaves/.test(src(f)));
    expect(readers.length).toBeGreaterThan(5);
    const missing = readers.filter((f) => !READER_EXCEPTIONS[f] && !src(f).includes("approvedLeaveSql"));
    expect(missing).toEqual([]);
    for (const f of Object.keys(READER_EXCEPTIONS)) expect(readers, f).toContain(f);
  });
  it("cada leitor tem o filtro NA consulta das ausências", () => {
    const pd = src("server/payroll/payrollData.ts");
    expect(pd).toMatch(/\.from\(employeeLeaves\)\.where\(and\([^\n]*approvedLeaveSql\(\)\)\)/);
    const ev = src("server/evaluationEngine.ts");
    expect(ev).toMatch(/FROM employee_leaves\s+WHERE fromDate <= \$\{addDays\(endDay, 1\)\} AND toDate >= \$\{addDays\(startDay, -1\)\} AND \$\{approvedLeaveSql\(\)\}/);
    const rh = src("server/rhService.ts");
    expect(rh).toMatch(/FROM employee_leaves\s+WHERE fromDate <= \$\{addDays\(dateStr, 1\)\} AND toDate >= \$\{addDays\(dateStr, -1\)\} AND \$\{approvedLeaveSql\(\)\} AND \$\{fullDayLeaveSql\(\)\}/);
    // os leitores que vieram com os passos 10a e 10b (horários por rever, fins de semana e exceções por data)
    expect(src("server/scheduleOverrides.ts")).toMatch(/FROM employee_leaves\s+WHERE employeeId IN \(\$\{ids\}\) AND fromDate <= \$\{toDay\} AND toDate >= \$\{fromDay\} AND \$\{approvedLeaveSql\(\)\} AND \$\{fullDayLeaveSql\(\)\}/);
    expect(src("server/scheduleReview.ts")).toMatch(/FROM employee_leaves\s+WHERE fromDate <= \$\{monthEnd\} AND toDate >= \$\{monthStart\} AND employeeId IN \(\$\{idList\(ids\)\}\) AND \$\{approvedLeaveSql\(\)\} AND \$\{fullDayLeaveSql\(\)\}/);
    const db = src("server/db.ts");
    const days = db.slice(db.indexOf("export async function getLeaveDaysForMonth"), db.indexOf("export async function getLeaveDaysForMonth") + 1200);
    expect(days).toContain("approvedLeaveSql(),");
    expect(days).toContain("isNull(employeeLeaves.hours),");
  });
  it("a folha: parte do dia e indisponibilidade não são dias de ausência; o resto como sempre", () => {
    const base = {
      employee: { id: 1, fullName: "Ana", position: "backoffice", extraLevel: null, contractStart: null, contractEnd: null, isActive: 1, monthlySalary: 1100, mealAllowancePerDay: 0 },
      year: 2026, month: 11, shifts: [], extraRateByLevel: new Map(), extraRateByName: new Map(),
    };
    expect(computeEmployeeMonth({ ...base, leaves: [{ leaveType: "vacation", fromDate: "2026-11-02", toDate: "2026-11-06" }] }).leaveDays).toBe(5);
    expect(computeEmployeeMonth({ ...base, leaves: [{ leaveType: "other", fromDate: "2026-11-03", toDate: "2026-11-03", hours: "2.00" }] }).leaveDays).toBe(0);
    expect(computeEmployeeMonth({ ...base, leaves: [{ leaveType: "unavailable", fromDate: "2026-11-03", toDate: "2026-11-05" }] }).leaveDays).toBe(0);
    const unpaid = computeEmployeeMonth({ ...base, leaves: [{ leaveType: "unpaid", fromDate: "2026-11-02", toDate: "2026-11-04" }] });
    expect(unpaid.unpaidDays).toBe(3);
    expect(unpaid.baseSalary).toBe(990);
  });
  it("parceiros-empresa fora da folha (e fora do mapa)", () => {
    expect(src("server/payroll/payrollData.ts")).toContain("sql`COALESCE(${employees.contractType}, '') <> 'partner_company'`");
    expect(src("server/leaves.ts")).toContain("WHERE COALESCE(e.contractType, '') <> ${PARTNER_COMPANY_CONTRACT}");
    expect(src("server/rhRouter.ts").match(/contractType: z\.enum\(\["permanent","fixed_term","extra","partner_company"\]\)/g)?.length).toBe(2);
    expect(src("drizzle/schema.ts")).toContain("contractType: mysqlEnum(['permanent','fixed_term','extra','partner_company']).default('permanent'),");
  });
});

// ─── Migração, interruptores e definições ───────────────────────────────────

describe("PDF do mapa", () => {
  it("gera um PDF com as férias de cada pessoa (e uma página mesmo sem ninguém)", async () => {
    const { renderLeaveMapPdf } = await import("./leavesPdf");
    const pdf = await renderLeaveMapPdf({ year: 2026, cityKey: "lisbon", rows: [{ fullName: "Ana", city: "lisbon", periods: [{ fromDate: "2026-08-03", toDate: "2026-08-14", workingDays: 10 }], total: 10 }] });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    const empty = await renderLeaveMapPdf({ year: 2026, cityKey: "all", rows: [] });
    expect(empty.subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("migração 0830", () => {
  it("estado (o que existe fica aprovado), aprovação, parte do dia, 'unavailable' no fim do ENUM, partner_company", async () => {
    const m = await import("./migrations/migration_0830");
    const all = m.MIGRATION_0830_STATEMENTS.join("\n");
    expect(all).toContain("ADD COLUMN `status` VARCHAR(10) NOT NULL DEFAULT 'approved'");
    expect(all).toContain("MODIFY COLUMN `leaveType` ENUM('vacation','sick','unpaid','other','unavailable') NOT NULL DEFAULT 'vacation'");
    expect(all).toContain("ADD COLUMN `hours` DECIMAL(4,2) NULL");
    expect(all).toContain("ADD COLUMN `approverUserIds` JSON NULL");
    for (const c of ["requestedById", "requestedAt", "decidedById", "decidedAt", "decisionNote", "cancelledById", "cancelledAt"]) expect(all).toContain(`ADD COLUMN \`${c}\``);
    expect(all).toContain("MODIFY COLUMN `contractType` ENUM('permanent','fixed_term','extra','partner_company') NULL DEFAULT 'permanent'");
    expect(all).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
    expect([...m.IDEMPOTENT_ERROR_CODES_0830].sort()).toEqual(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
    const { SCHEMA_MIGRATION_IDS } = await import("./migrations/index");
    expect(SCHEMA_MIGRATION_IDS).toContain("0830");
    expect([...SCHEMA_MIGRATION_IDS].sort()).toEqual([...SCHEMA_MIGRATION_IDS]);
  });
});

describe("interruptores e definições", () => {
  it("FERIAS_MAPA e FERIAS_AVISOS: no catálogo, desligados, só o super admin", () => {
    for (const f of [FERIAS_MAPA_FLAG, FERIAS_AVISOS_FLAG]) {
      expect(AUTOMATION_FLAGS.some((x) => x.name === f), f).toBe(true);
      expect(automationFlagDefault(f), f).toBe(false);
      expect(automationFlagSuperAdminOnly(f), f).toBe(true);
    }
    // os avisos só saem com os dois ligados
    expect(src("server/leaves.ts")).toContain("export const feriasAvisosOn = async () => (await flagOn(FERIAS_MAPA_FLAG)) && (await flagOn(FERIAS_AVISOS_FLAG));");
  });
  it("definições: contas (ids, sem nomes), regras validadas, dias por ano; quem vê/aprova só o super admin muda", () => {
    for (const k of [HR_PEOPLE_KEY, LEAVES_VIEW_ALL_KEY]) {
      expect(SETTINGS[k].defaultValue).toEqual([]);
      expect(validateSetting(k, [3, 3, 9])).toEqual({ ok: true, value: [3, 9] });
      expect(validateSetting(k, ["RH"]).ok).toBe(false);
      expect(settingSuperAdminOnly(k)).toBe(true);
    }
    expect(SETTINGS[VACATION_APPROVALS_KEY].defaultValue).toEqual(DEFAULT_VACATION_APPROVALS);
    expect(validateSetting(VACATION_APPROVALS_KEY, DEFAULT_VACATION_APPROVALS).ok).toBe(true);
    expect(validateSetting(VACATION_APPROVALS_KEY, { positions: {}, hrPeople: { approvers: ["nobody"] }, people: [] }).ok).toBe(false);
    expect(settingSuperAdminOnly(VACATION_APPROVALS_KEY)).toBe(true);
    expect(SETTINGS[VACATION_DAYS_PER_YEAR_KEY].defaultValue).toBe(22);
    expect(validateSetting(VACATION_DAYS_PER_YEAR_KEY, 70).ok).toBe(false);
  });
  it("o ecrã: rota /ferias, atalho no Perfil e no RH, editor das regras nas Definições", () => {
    expect(src("client/src/App.tsx")).toContain('<Route path="/ferias">');
    expect(src("client/src/pages/ProfilePage.tsx")).toContain("useLeaveStatus()");
    expect(src("client/src/pages/HRPage.tsx")).toContain("<FeriasMapButton />");
    expect(src("client/src/pages/DefinicoesPage.tsx")).toContain("<VacationApprovalsEditor value={approvalsDraft}");
    // o mapa só aparece com o interruptor (a página e as rotas do mapa perguntam ao servidor)
    const r = src("server/leavesRouter.ts");
    for (const name of ["map", "mine", "request", "pending", "decide", "pdf", "launchPeople", "myApprovers"]) {
      const block = r.slice(r.indexOf(`  ${name}: protectedProcedure`), r.indexOf(`  ${name}: protectedProcedure`) + 400);
      expect(block, name).toContain("await assertMapOn();");
    }
  });
  it("(auditoria final) sem números de registo no ecrã: contas e pessoas que já não estão ativas dizem-se por palavras", () => {
    const ed = src("client/src/components/ferias/VacationApprovalsEditor.tsx");
    expect(ed).not.toMatch(/`Conta \$\{|`Ficha \$\{/);
    expect(ed).toContain('"Conta que já não está ativa"');
    expect(ed).toContain('"Pessoa que já não está ativa"');
    // o extra que avisa num dia em que já está na escala fica a saber que não tira a falta (fala com quem escala)
    expect(src("client/src/pages/FeriasPage.tsx")).toContain("const late = alreadyScheduledWarning(r.alreadyScheduled);");
    for (const f of ["client/src/pages/FeriasPage.tsx", "client/src/components/ferias/FeriasBits.tsx"]) {
      expect(src(f), f).not.toMatch(/`(Conta|Ficha|Pedido|Ausência) #?\$\{/);
    }
  });
});
