/**
 * Plano 63, passo 11 — as 5 decisões do Jorge (15 out 2026) sobre o mapa de
 * férias, com a BD simulada:
 *  1. o "não vou estar" (e outra ausência de dia inteiro) tira a pessoa da
 *     proposta automática do Extras-Dia (só com FERIAS_MAPA);
 *  2. "avisou antes de ser escalado" conta desde que ESSA pessoa foi posta
 *     NESSE dia (personAssignedAt, 0830);
 *  3. a falta de quem tinha avisado (0 pontos) não conta para a ordem;
 *  4. férias já aprovadas só as lança quem as aprova, o RH e o super admin;
 *  5. o administrador (sem ser super admin nem estar nas listas) tem a vista
 *     de supervisor, de todas as cidades.
 * E com os interruptores desligados nada muda.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  blocksAutoProposal, isNoticeNoShow, launchApprovedVacationError, leaveViewerMode, NOTICE_NO_SHOW_MARK, noticeBeforeAssignment, noticeNoShowNote,
  personAssignmentChanged, scheduledSince,
} from "../shared/leaves";

const state = vi.hoisted(() => ({
  employees: [] as any[],
  leaves: [] as any[],
  users: [] as any[],
  logins: new Map<number, number[]>(),
  settings: {} as Record<string, unknown>,
  created: [] as any[],
  cityAccess: new Map<number, any>(),
}));

const PROJECTS = [
  { id: 1, name: "Lisboa", level: "city", parentId: null },
  { id: 2, name: "Porto", level: "city", parentId: null },
  { id: 3, name: "Faro", level: "city", parentId: null },
];

vi.mock("./db", async (original) => {
  const dialect = new MySqlDialect();
  const active = (l: any) => l.status === "requested" || l.status === "approved";
  const db = {
    execute: async (q: any) => {
      const { sql: t, params } = dialect.sqlToQuery(q);
      if (t.includes("FROM projects")) return [PROJECTS];
      if (t.includes("FROM users")) return [state.users.filter((u) => u.isActive)];
      if (t.includes("FROM employee_accounts")) return [[]];
      if (t.includes("hasLeaves")) {
        return [state.employees.map((e) => ({ ...e, hasLeaves: state.leaves.some((l) => l.employeeId === e.id && active(l)) ? 1 : 0 }))
          .filter((e) => e.contractType !== "partner_company" && (e.isActive === 1 || e.hasLeaves === 1))];
      }
      if (t.includes("FROM employee_leaves l") && t.includes("l.employeeId IN")) {
        const ids = params.filter((p) => typeof p === "number");
        const strs = params.filter((p) => typeof p === "string") as string[];
        const [to, from, ...statuses] = strs;
        return [state.leaves.filter((l) => ids.includes(l.employeeId) && l.fromDate <= to && l.toDate >= from && (!statuses.length || statuses.includes(l.status)))];
      }
      return [[]];
    },
  };
  return {
    ...(await original<object>()),
    getDb: async () => db,
    getEmployeeById: async (id: number) => { const e = state.employees.find((x) => x.id === id); return e ? { employee: e, project: null } : undefined; },
    getEmployeeByUserId: async (uid: number) => {
      const e = state.employees.find((x) => x.userId === uid || (state.logins.get(x.id) ?? []).includes(uid));
      return e ? { employee: e, project: null } : undefined;
    },
    logActivity: async () => {},
    createEmployeeLeave: async (d: any) => {
      const id = 1000 + state.created.length;
      state.created.push({ id, ...d });
      state.leaves.push({ id, ...d, status: d.status ?? "approved", hours: d.hours ?? null, notes: d.notes ?? null });
      return id;
    },
  };
});
vi.mock("./personIdentity", () => ({
  listEmployeeLogins: async (id: number) => (state.logins.get(id) ?? []).map((userId) => ({ userId, name: null, email: null, role: "user", isActive: true, principal: true, lastSignedIn: null, loginMethod: null })),
}));
vi.mock("./appSettings", async (original) => ({ ...(await original<object>()), getSetting: async (k: string) => state.settings[k] ?? null }));
vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccessParts: async (userId: number) => ({ access: state.cityAccess.get(userId) ?? { all: false, cityNames: [] } }) }));
vi.mock("./terminalPay", () => ({ closedPayrollMonthKeys: async () => new Set<string>() }));
vi.mock("./notify", () => ({ notify: async () => ({ recipients: [], emailed: 0, duplicates: 0, city: null }) }));

import { assertCanLaunchApprovedVacation, awayForAutoProposal, launchLeave, leaveMap, resolveLeaveViewer, vacationLaunchableIds } from "./leaves";
import { cityScope } from "./cityScope";

const root = resolve(import.meta.dirname, "..");
const src = (p: string) => readFileSync(resolve(root, p), "utf8");

const U = {
  jorge: { id: 1, role: "super_admin" }, rh: { id: 3, role: "backoffice" }, supLx: { id: 4, role: "supervisor" },
  ana: { id: 20, role: "frontoffice" }, admin: { id: 40, role: "admin" }, adminComFicha: { id: 41, role: "admin" },
};
const NATIONAL = { all: true, defaultCityId: null, cityIds: [1, 2, 3], projectIds: [1, 2, 3], missingCostCenter: false };
const LISBOA = { all: false, defaultCityId: 1, cityIds: [1], projectIds: [1], missingCostCenter: false };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
  process.env.FERIAS_MAPA = "on";
  state.employees = [
    { id: 1, fullName: "Diretor Geral", position: "director", contractType: "permanent", projectId: 1, isActive: 1, userId: 1 },
    { id: 3, fullName: "Pessoa RH", position: "backoffice", contractType: "permanent", projectId: 1, isActive: 1, userId: 3 },
    { id: 4, fullName: "Supervisor Lisboa", position: "supervisor", contractType: "permanent", projectId: 1, isActive: 1, userId: 4 },
    { id: 10, fullName: "Ana Front", position: "frontoffice", contractType: "fixed_term", projectId: 1, isActive: 1, userId: 20 },
    { id: 11, fullName: "Rui Condutor", position: "driver", contractType: "permanent", projectId: 1, isActive: 1, userId: 21 },
    { id: 12, fullName: "Zé Extra", position: "extra", contractType: "extra", projectId: 1, isActive: 1, userId: 22 },
    { id: 13, fullName: "TL Porto", position: "team_leader", contractType: "permanent", projectId: 2, isActive: 1, userId: 23 },
    { id: 15, fullName: "Bea Back", position: "backoffice", contractType: "permanent", projectId: 1, isActive: 1, userId: 25 },
    { id: 16, fullName: "Admin Com Ficha", position: "backoffice", contractType: "permanent", projectId: 1, isActive: 1, userId: 41 },
  ];
  state.logins = new Map(state.employees.map((e) => [e.id, [e.userId]]));
  state.users = [
    { id: 1, role: "super_admin", isActive: 1 }, { id: 3, role: "backoffice", isActive: 1 }, { id: 4, role: "supervisor", isActive: 1 },
    { id: 20, role: "frontoffice", isActive: 1 }, { id: 21, role: "condutor", isActive: 1 }, { id: 22, role: "extra", isActive: 1 }, { id: 23, role: "team_leader", isActive: 1 },
    { id: 25, role: "backoffice", isActive: 1 }, { id: 40, role: "admin", isActive: 1 }, { id: 41, role: "admin", isActive: 1 },
  ];
  state.cityAccess = new Map([[4, { all: false, cityNames: ["Lisboa"] }]]);
  state.leaves = [
    { id: 1, employeeId: 11, leaveType: "sick", status: "approved", fromDate: "2026-11-02", toDate: "2026-11-06", hours: null, notes: "atestado", decisionNote: null, approverUserIds: null, requestedAt: "2026-10-01 09:00:00", createdAt: "2026-10-01 09:00:00" },
    { id: 2, employeeId: 13, leaveType: "vacation", status: "approved", fromDate: "2026-11-09", toDate: "2026-11-13", hours: null, notes: null, decisionNote: null, approverUserIds: [3], requestedAt: null, createdAt: "2026-09-01 09:00:00" },
    { id: 3, employeeId: 12, leaveType: "unavailable", status: "approved", fromDate: "2026-11-03", toDate: "2026-11-03", hours: null, notes: "exames", decisionNote: null, approverUserIds: null, requestedAt: "2026-10-10 09:00:00", createdAt: "2026-10-10 09:00:00" },
    { id: 4, employeeId: 10, leaveType: "other", status: "approved", fromDate: "2026-11-03", toDate: "2026-11-03", hours: 2, notes: "consulta", decisionNote: null, approverUserIds: null, requestedAt: "2026-10-10 09:00:00", createdAt: "2026-10-10 09:00:00" },
    { id: 5, employeeId: 15, leaveType: "unavailable", status: "cancelled", fromDate: "2026-11-03", toDate: "2026-11-03", hours: null, notes: null, decisionNote: null, approverUserIds: null, requestedAt: "2026-10-10 09:00:00", createdAt: "2026-10-10 09:00:00" },
  ];
  state.settings = { "rh.hrPeople": [3] };
  state.created = [];
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.FERIAS_MAPA;
});

// ─── 1. "Não vou estar" fora da proposta automática ─────────────────────────

describe("1. quem avisou que não está não é proposto automaticamente", () => {
  it("dia inteiro tira (o \"não vou estar\" e outra ausência aprovada); parte do dia não", () => {
    expect(blocksAutoProposal({ kind: "unavailable", fromDate: "2026-11-03", toDate: "2026-11-03", noticeDay: "2026-10-10", partial: false })).toBe(true);
    expect(blocksAutoProposal({ kind: "absent", fromDate: "2026-11-02", toDate: "2026-11-06", noticeDay: null, partial: false })).toBe(true);
    expect(blocksAutoProposal({ kind: "absent", fromDate: "2026-11-03", toDate: "2026-11-03", noticeDay: null, partial: true })).toBe(false);
    expect(blocksAutoProposal(null)).toBe(false);
  });
  it("com o mapa ligado: o extra que avisou e quem tem baixa saem; parte do dia e as canceladas não", async () => {
    expect([...(await awayForAutoProposal("2026-11-03", [10, 11, 12, 15]))].sort()).toEqual([11, 12]);
    expect([...(await awayForAutoProposal("2026-11-04", [10, 11, 12, 15]))]).toEqual([11]);
  });
  it("com o mapa DESLIGADO ninguém sai (como antes)", async () => {
    delete process.env.FERIAS_MAPA;
    expect([...(await awayForAutoProposal("2026-11-03", [10, 11, 12, 15]))]).toEqual([]);
  });
  it("a proposta, o \"Completar\" e o \"Preencher\" usam a regra; à mão continua só o aviso", () => {
    const sched = src("server/extrasSchedule.ts");
    const eligible = sched.slice(sched.indexOf("export async function loadEligibleExtras"), sched.indexOf("export async function loadScheduleCandidates"));
    expect(eligible).toContain('(await import("./leaves")).awayForAutoProposal(date, eligible.map((c) => c.id))');
    // a proposta e o completar escolhem de loadScheduleCandidates → loadEligibleExtras
    expect(sched.slice(sched.indexOf("export async function proposeSchedule"))).toContain("await loadScheduleCandidates(date, city)");
    expect(sched.slice(sched.indexOf("export async function completeSchedule"))).toContain("await loadScheduleCandidates(date, city)");
    const auto = src("server/extrasAutomation.ts");
    const fill = auto.slice(auto.indexOf("export async function autofillShift"), auto.indexOf("export async function coverageFor"));
    expect(fill).toContain('(await import("./leaves")).awayForAutoProposal(input.date');
    expect(fill).toContain("!away.has(c.id)");
    // pôr à mão (upsertAssignment) não lê ausências: só o ecrã avisa
    expect(src("server/extrasDia.ts").split("export async function upsertAssignment")[1].split("\nfunction googleShiftChanged")[0]).not.toContain("awayForAutoProposal");
  });
});

// ─── 2. "Avisou antes de ser escalado" = antes de ESTA pessoa ser posta NESTE dia ─

describe("2. avisou antes de ser escalado: conta desde que a pessoa foi posta nesse dia", () => {
  it("trocar a pessoa ou o dia é uma escala nova; mexer nas horas não", () => {
    const prev = { employeeId: 5, assignmentDate: "2026-11-02", personName: "Zé" };
    expect(personAssignmentChanged(prev, { ...prev })).toBe(false);
    expect(personAssignmentChanged(prev, { ...prev, personName: "Zé Extra" })).toBe(false); // mesma ficha
    expect(personAssignmentChanged(prev, { ...prev, employeeId: 6 })).toBe(true);
    expect(personAssignmentChanged(prev, { ...prev, assignmentDate: "2026-11-03" })).toBe(true);
    expect(personAssignmentChanged({ employeeId: null, assignmentDate: "2026-11-02", personName: "Convidado" }, { employeeId: null, assignmentDate: "2026-11-02", personName: "Outro" })).toBe(true);
    expect(personAssignmentChanged({ employeeId: null, assignmentDate: "2026-11-02", personName: "Convidado" }, { employeeId: 7, assignmentDate: "2026-11-02", personName: "Convidado" })).toBe(true);
  });
  it("desde quando: personAssignedAt; as linhas antigas (sem ela) usam a criação da linha", () => {
    expect(scheduledSince({ personAssignedAt: "2026-11-01 10:00:00", createdAt: "2026-10-01 10:00:00" })).toBe("2026-11-01 10:00:00");
    expect(scheduledSince({ personAssignedAt: null, createdAt: "2026-10-01 10:00:00" })).toBe("2026-10-01 10:00:00");
    expect(scheduledSince({ createdAt: "2026-10-01 10:00:00" })).toBe("2026-10-01 10:00:00");
  });
  it("linha criada a 1/10 com outra pessoa; o Zé avisou a 30/10 e foi posto nessa linha a 1/11 → avisou ANTES", () => {
    const aviso = { leaveType: "unavailable", status: "approved", fromDate: "2026-11-02", toDate: "2026-11-02", hours: null, requestedAt: "2026-10-30 08:00:00" };
    const linha = { createdAt: "2026-10-01 10:00:00", personAssignedAt: "2026-11-01 10:00:00" };
    expect(noticeBeforeAssignment([aviso], "2026-11-02", scheduledSince(linha))).toBe(aviso);
    // pela criação da linha (a regra antiga) seria "depois"
    expect(noticeBeforeAssignment([aviso], "2026-11-02", linha.createdAt)).toBeNull();
    // posto a 20/10 e avisou a 30/10 → depois → falta normal
    expect(noticeBeforeAssignment([aviso], "2026-11-02", scheduledSince({ createdAt: "2026-10-01 10:00:00", personAssignedAt: "2026-10-20 10:00:00" }))).toBeNull();
  });
  it("a migração 0830 só acrescenta a coluna (NULL), e as linhas novas e trocadas gravam-na", async () => {
    const m = await import("./migrations/migration_0830");
    expect(m.MIGRATION_0830_STATEMENTS).toContain("ALTER TABLE `extras_dia_assignments` ADD COLUMN `personAssignedAt` TIMESTAMP NULL DEFAULT NULL");
    expect(m.MIGRATION_0830_STATEMENTS.join("\n")).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|personAssignedAt` = /i);
    expect(src("drizzle/schema.ts")).toContain("personAssignedAt: timestamp({ mode: 'string' }),");
    const sched = src("server/extrasSchedule.ts");
    // a proposta e o completar: linhas novas com a hora
    expect(sched.match(/source, personAssignedAt\)/g)?.length).toBe(2);
    expect(sched.match(/'auto', \$\{utcNowSql\(\)\}\)/g)?.length).toBe(2);
    // o arquivo guarda a linha inteira, com a hora
    expect(sched).toContain("'personAssignedAt', personAssignedAt");
    // a possível falta usa a hora da pessoa (ou a criação)
    expect(src("server/rhService.ts")).toContain("noticeBeforeAssignment(notices.get(r.employeeId) ?? [], dateStr, scheduledSince(r))");
  });
});

// ─── 3. A falta de quem tinha avisado não conta para a ordem ────────────────

describe("3. a falta de quem tinha avisado (0 pontos) não conta para a ordem da proposta", () => {
  it("a nota escrita na possível falta é reconhecida; as outras não", () => {
    const note = `Possível falta ao extras-dia em 2026-11-02 (Zé, lisbon, 9h) — sem check-in no turno; confirmar com a operação${noticeNoShowNote("2026-10-30")}`;
    expect(note).toContain("tinha avisado a 30/10 que não estava (antes de ser escalado): sem pontos");
    expect(isNoticeNoShow({ points: 0, notes: note })).toBe(true);
    expect(isNoticeNoShow({ points: 0, notes: `${note} · revisão: confirmada` })).toBe(true);
    // a do funcionário (0 pontos, sem aviso) e as de 1 ponto contam
    expect(isNoticeNoShow({ points: 0, notes: "Possível falta … · funcionário: sem pontos; confirmar com a operação" })).toBe(false);
    expect(isNoticeNoShow({ points: 1, notes: note })).toBe(false);
    expect(isNoticeNoShow({ points: 0, notes: null })).toBe(false);
  });
  it("a contagem das faltas (60 dias) tira-as na própria consulta", () => {
    const s = src("server/extrasSchedule.ts");
    const hist = s.slice(s.indexOf("async function loadHistory"), s.indexOf("type DriverCandidateRow"));
    expect(hist).toContain("AND NOT (points = 0 AND COALESCE(notes, '') LIKE ${`%${NOTICE_NO_SHOW_MARK}%`})");
    expect(NOTICE_NO_SHOW_MARK).toBe("(antes de ser escalado): sem pontos");
  });
});

// ─── 4. Lançar férias já aprovadas ──────────────────────────────────────────

describe("4. férias já aprovadas: só quem as aprova, o RH e o super admin", () => {
  const base = { actorUserId: 4, actorRole: "supervisor", own: false, mapOn: true, hrPeople: [3], approverUserIds: [3] };
  it("regra pura", () => {
    expect(launchApprovedVacationError(base)).toMatch(/só as lança quem aprova as férias desta pessoa, o RH ou o super admin/);
    expect(launchApprovedVacationError({ ...base, approverUserIds: [3, 4] })).toBeNull();
    expect(launchApprovedVacationError({ ...base, actorUserId: 3, actorRole: "backoffice" })).toBeNull();
    expect(launchApprovedVacationError({ ...base, actorUserId: 1, actorRole: "super_admin", own: true })).toBeNull();
    expect(launchApprovedVacationError({ ...base, own: true, approverUserIds: [4] })).toMatch(/ninguém aprova as suas/);
    // mapa desligado: como antes (só as próprias não)
    expect(launchApprovedVacationError({ ...base, mapOn: false })).toBeNull();
    expect(launchApprovedVacationError({ ...base, mapOn: false, own: true })).toMatch(/ninguém aprova as suas/);
  });
  it("o supervisor da cidade lança férias a quem aprova (front office, condutor), não a um back office (só o RH aprova)", async () => {
    await expect(launchLeave(U.supLx, { employeeId: 15, leaveType: "vacation", fromDate: "2026-11-16", toDate: "2026-11-20" }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/só as lança quem aprova as férias desta pessoa/) });
    expect(state.created).toEqual([]);
    await launchLeave(U.supLx, { employeeId: 10, leaveType: "vacation", fromDate: "2026-11-16", toDate: "2026-11-20" });
    expect(state.created.at(-1)).toMatchObject({ employeeId: 10, leaveType: "vacation", status: "approved", decidedById: 4 });
  });
  it("baixas e ausências continuam com quem gere a ficha (só as férias mudam)", async () => {
    await launchLeave(U.supLx, { employeeId: 15, leaveType: "sick", fromDate: "2026-11-16", toDate: "2026-11-20" });
    expect(state.created.at(-1)).toMatchObject({ employeeId: 15, leaveType: "sick", status: "approved" });
  });
  it("o RH e o super admin lançam a todos; um administrador que não aprova não", async () => {
    await launchLeave(U.rh, { employeeId: 15, leaveType: "vacation", fromDate: "2026-11-16", toDate: "2026-11-17" });
    await launchLeave(U.jorge, { employeeId: 13, leaveType: "vacation", fromDate: "2026-12-01", toDate: "2026-12-02" });
    expect(state.created.map((c) => c.employeeId)).toEqual([15, 13]);
    await expect(launchLeave(U.admin, { employeeId: 15, leaveType: "vacation", fromDate: "2026-12-07", toDate: "2026-12-08" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("as próprias continuam proibidas (também a quem as aprovaria), salvo o super admin", async () => {
    await expect(assertCanLaunchApprovedVacation(U.rh, 3, 3)).rejects.toThrow(/ninguém aprova as suas/);
    await expect(assertCanLaunchApprovedVacation(U.jorge, 1, 1)).resolves.toBeUndefined();
  });
  it("com o mapa DESLIGADO nada muda: quem gere a ficha lança férias (só as próprias não)", async () => {
    delete process.env.FERIAS_MAPA;
    await launchLeave(U.supLx, { employeeId: 15, leaveType: "vacation", fromDate: "2026-11-16", toDate: "2026-11-20" });
    expect(state.created.at(-1)).toMatchObject({ employeeId: 15, leaveType: "vacation" });
    await expect(assertCanLaunchApprovedVacation(U.supLx, 4, 4)).rejects.toThrow(/ninguém aprova as suas/);
  });
  it("o ecrã de lançar sabe a quem esta conta lança férias (o servidor volta a confirmar)", async () => {
    const people = [10, 11, 13, 15, 4].map((id) => { const e = state.employees.find((x) => x.id === id)!; return { id, position: e.position, projectId: e.projectId, userId: e.userId }; });
    expect([...(await vacationLaunchableIds(U.supLx, people))].sort((a, b) => a - b)).toEqual([10, 11]);
    expect([...(await vacationLaunchableIds(U.rh, people))].sort((a, b) => a - b)).toEqual([4, 10, 11, 13, 15]);
    expect([...(await vacationLaunchableIds(U.jorge, people))].sort((a, b) => a - b)).toEqual([4, 10, 11, 13, 15]);
    const r = src("server/leavesRouter.ts");
    expect(r).toContain("canVacation: vacationOk ? vacationOk.has(Number(r.id)) : true");
    expect(src("client/src/pages/FeriasPage.tsx")).toContain('const vacationBlocked = leaveType === "vacation" && person?.canVacation === false;');
  });
  it("a dispensa de uma possível falta com \"Férias\" tem a mesma regra", () => {
    const s = src("server/rhService.ts");
    const guard = s.slice(s.indexOf("async function assertDismissLeaveAllowed"), s.indexOf("// ─── Ponto: revisão de registos suspeitos"));
    expect(guard).toContain('if (leave.leaveType === "vacation") await leaves.assertCanLaunchApprovedVacation(reviewer, employeeId, emp?.userId ?? null);');
  });
});

// ─── 5. Administrador: vista de supervisor, todas as cidades ────────────────

describe("5. o administrador (sem ser super admin nem estar nas listas) vê como o supervisor, de todas as cidades", () => {
  const mode = (o: Partial<Parameters<typeof leaveViewerMode>[0]>) => leaveViewerMode({ role: "admin", userId: 50, hasEmployee: false, isExtra: false, viewAll: [], hrPeople: [], ...o });
  it("regra pura: admin → supervisor; nas listas (ou super admin) → tudo", () => {
    expect(mode({})).toBe("supervisor");
    expect(mode({ hasEmployee: true })).toBe("supervisor");
    expect(mode({ viewAll: [50] })).toBe("full");
    expect(mode({ hrPeople: [50] })).toBe("full");
    expect(mode({ role: "super_admin" })).toBe("full");
    // os outros papéis não mudam
    expect(mode({ role: "backoffice", hasEmployee: true })).toBe("employee");
    expect(mode({ role: "supervisor" })).toBe("supervisor");
  });
  it("o mapa do administrador: todas as cidades, as baixas como \"ausente\" sem o motivo", async () => {
    const v = await cityScope.run(NATIONAL, () => resolveLeaveViewer(U.admin));
    expect(v.mode).toBe("supervisor");
    expect(v.scopeProjectIds).toBeNull();
    const m = await leaveMap(v, { year: 2026, canManageRh: true });
    const name = new Map(m.people.map((p) => [p.id, p.fullName]));
    const shown = m.leaves.map((l) => `${name.get(l.employeeId)}:${l.leaveType}${l.notes ? `:${l.notes}` : ""}`).sort();
    expect(shown).toEqual(["Ana Front:absent", "Rui Condutor:absent", "TL Porto:vacation", "Zé Extra:unavailable:exames"]);
    expect(m.people.map((p) => p.fullName)).toContain("TL Porto");
  });
  it("um administrador com ficha também; a ficha não lhe dá o mapa de colega", async () => {
    const v = await cityScope.run(NATIONAL, () => resolveLeaveViewer(U.adminComFicha));
    expect(v.mode).toBe("supervisor");
    const m = await leaveMap(v, { year: 2026, canManageRh: true });
    expect(m.leaves.find((l) => l.employeeId === 11)?.leaveType).toBe("absent");
  });
  it("o supervisor continua com a sua área (só o administrador ganha todas as cidades)", async () => {
    const v = await cityScope.run(LISBOA, () => resolveLeaveViewer(U.supLx));
    const m = await leaveMap(v, { year: 2026, canManageRh: true });
    expect(m.people.map((p) => p.fullName)).not.toContain("TL Porto");
  });
  it("o ecrã diz \"todas as cidades\" à vista de supervisor sem âmbito de cidade", () => {
    expect(src("server/leavesRouter.ts")).toContain('allCities: v.mode === "full" || (v.mode === "supervisor" && v.scopeProjectIds == null),');
    expect(src("client/src/pages/FeriasPage.tsx")).toContain('`Vês ${s.allCities ? "todas as cidades" : "a tua área"}.');
  });
  it("com o mapa DESLIGADO o mapa não abre a ninguém (a ficha já mostrava as baixas como \"ausente\" a quem não vê tudo)", () => {
    const r = src("server/leavesRouter.ts");
    const block = r.slice(r.indexOf("  map: protectedProcedure"), r.indexOf("  map: protectedProcedure") + 300);
    expect(block).toContain("await assertMapOn();");
    const s = src("server/leaves.ts");
    expect(s.slice(s.indexOf("export async function leavesForEmployee"))).toContain('const mode: LeaveViewerMode = own || v.mode === "full" ? "full" : "supervisor";');
  });
});
