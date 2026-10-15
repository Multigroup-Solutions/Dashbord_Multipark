/**
 * Plano 63, passo 11 — o fluxo do mapa de férias com a BD simulada: pedir,
 * aprovar/recusar, cancelar, mês fechado, avisos (só com os dois
 * interruptores) e quem vê o quê no mapa (filtro do servidor).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({
  employees: [] as any[],
  leaves: [] as any[],
  users: [] as any[],
  logins: new Map<number, number[]>(),
  settings: {} as Record<string, unknown>,
  closed: new Set<string>(),
  closedFails: false,
  created: [] as any[],
  cancelled: [] as any[],
  notified: [] as any[],
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
      if (t.includes("hasLeaves")) {
        return [state.employees.map((e) => ({ ...e, hasLeaves: state.leaves.some((l) => l.employeeId === e.id && active(l)) ? 1 : 0 }))
          .filter((e) => e.contractType !== "partner_company" && (e.isActive === 1 || e.hasLeaves === 1))];
      }
      if (t.startsWith("UPDATE employee_leaves")) {
        const [status, by, at, note, id] = params as any[];
        const l = state.leaves.find((x) => x.id === id && x.status === "requested");
        if (!l) return [{ affectedRows: 0 }];
        Object.assign(l, { status, decidedById: by, decidedAt: at, decisionNote: note });
        return [{ affectedRows: 1 }];
      }
      const emp = (id: number) => state.employees.find((e) => e.id === id) ?? {};
      if (t.includes("l.leaveType = 'vacation'") && t.includes("JOIN employees e")) {
        return [state.leaves.filter((l) => l.leaveType === "vacation" && active(l)).map((l) => ({ ...l, fullName: emp(l.employeeId).fullName, projectId: emp(l.employeeId).projectId }))];
      }
      if (t.includes("FROM employee_leaves l JOIN employees e")) {
        const uid = params.find((p) => typeof p === "string" && /^\d+$/.test(p));
        return [state.leaves.filter((l) => l.status === "requested" && (uid == null || (l.approverUserIds ?? []).includes(Number(uid))))
          .map((l) => ({ ...l, fullName: emp(l.employeeId).fullName, projectId: emp(l.employeeId).projectId, position: emp(l.employeeId).position }))];
      }
      if (t.includes("FROM employee_leaves l") && t.includes("l.id = ")) return [state.leaves.filter((l) => l.id === params[0])];
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
      const row = { id, ...d, status: d.status ?? "approved", approverUserIds: d.approverUserIds ?? null };
      state.created.push(row);
      state.leaves.push({ ...row, hours: d.hours ?? null, notes: d.notes ?? null });
      return id;
    },
    cancelEmployeeLeave: async (id: number, by: number, note: string | null) => {
      state.cancelled.push({ id, by, note });
      const l = state.leaves.find((x) => x.id === id);
      if (l) l.status = "cancelled";
      return true;
    },
  };
});
vi.mock("./personIdentity", () => ({
  listEmployeeLogins: async (id: number) => (state.logins.get(id) ?? []).map((userId) => ({ userId, name: null, email: null, role: "user", isActive: true, principal: true, lastSignedIn: null, loginMethod: null })),
}));
vi.mock("./appSettings", async (original) => ({ ...(await original<object>()), getSetting: async (k: string) => state.settings[k] ?? null }));
vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccessParts: async (userId: number) => ({ access: state.cityAccess.get(userId) ?? { all: false, cityNames: [] } }) }));
vi.mock("./terminalPay", () => ({ closedPayrollMonthKeys: async () => { if (state.closedFails) throw new Error("BD"); return state.closed; } }));
vi.mock("./notify", () => ({ notify: async (i: any) => { state.notified.push(i); return { recipients: [], emailed: 0, duplicates: 0, city: null }; } }));

import { cancelLeave, decideLeave, leaveMap, pendingForApprover, requestLeave, resolveLeaveViewer, assertPeriodOpen } from "./leaves";
import { cityScope } from "./cityScope";

const U = { jorge: { id: 1, role: "super_admin" }, rh: { id: 3, role: "backoffice" }, supLx: { id: 4, role: "supervisor" }, ana: { id: 20, role: "frontoffice" }, rui: { id: 21, role: "condutor" }, ze: { id: 22, role: "extra" }, parceiro: { id: 24, role: "user" } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
  process.env.FERIAS_MAPA = "on";
  delete process.env.FERIAS_AVISOS;
  state.employees = [
    { id: 1, fullName: "Diretor Geral", position: "director", contractType: "permanent", projectId: 1, isActive: 1, userId: 1 },
    { id: 3, fullName: "Pessoa RH", position: "backoffice", contractType: "permanent", projectId: 1, isActive: 1, userId: 3 },
    { id: 4, fullName: "Supervisor Lisboa", position: "supervisor", contractType: "permanent", projectId: 1, isActive: 1, userId: 4 },
    { id: 10, fullName: "Ana Front", position: "frontoffice", contractType: "fixed_term", projectId: 1, isActive: 1, userId: 20 },
    { id: 11, fullName: "Rui Condutor", position: "driver", contractType: "permanent", projectId: 1, isActive: 1, userId: 21 },
    { id: 12, fullName: "Zé Extra", position: "extra", contractType: "extra", projectId: 1, isActive: 1, userId: 22 },
    { id: 13, fullName: "TL Porto", position: "team_leader", contractType: "permanent", projectId: 2, isActive: 1, userId: 23 },
    { id: 14, fullName: "Parceiro Lda", position: "driver", contractType: "partner_company", projectId: 1, isActive: 1, userId: 24 },
  ];
  state.logins = new Map(state.employees.map((e) => [e.id, [e.userId]]));
  state.users = [
    { id: 1, role: "super_admin", isActive: 1 }, { id: 3, role: "backoffice", isActive: 1 }, { id: 4, role: "supervisor", isActive: 1 },
    { id: 20, role: "frontoffice", isActive: 1 }, { id: 21, role: "condutor", isActive: 1 }, { id: 22, role: "extra", isActive: 1 }, { id: 23, role: "team_leader", isActive: 1 },
  ];
  state.cityAccess = new Map([[4, { all: false, cityNames: ["Lisboa"] }]]);
  state.leaves = [
    { id: 1, employeeId: 11, leaveType: "sick", status: "approved", fromDate: "2026-11-02", toDate: "2026-11-06", hours: null, notes: "atestado", decisionNote: null, approverUserIds: null, requestedAt: "2026-10-01 09:00:00", createdAt: "2026-10-01 09:00:00" },
    { id: 2, employeeId: 13, leaveType: "vacation", status: "approved", fromDate: "2026-11-09", toDate: "2026-11-13", hours: null, notes: null, decisionNote: null, approverUserIds: [3], requestedAt: null, createdAt: "2026-09-01 09:00:00" },
    { id: 3, employeeId: 12, leaveType: "unavailable", status: "approved", fromDate: "2026-11-03", toDate: "2026-11-03", hours: null, notes: "exames", decisionNote: null, approverUserIds: null, requestedAt: "2026-10-10 09:00:00", createdAt: "2026-10-10 09:00:00" },
    { id: 4, employeeId: 10, leaveType: "vacation", status: "requested", fromDate: "2026-12-21", toDate: "2026-12-24", hours: null, notes: "Natal", decisionNote: null, approverUserIds: [3, 4], requestedAt: "2026-10-12 09:00:00", createdAt: "2026-10-12 09:00:00" },
    { id: 5, employeeId: 11, leaveType: "vacation", status: "approved", fromDate: "2026-12-21", toDate: "2026-12-23", hours: null, notes: null, decisionNote: null, approverUserIds: [3, 4], requestedAt: null, createdAt: "2026-09-01 09:00:00" },
  ];
  state.settings = { "rh.hrPeople": [3] };
  state.closed = new Set();
  state.closedFails = false;
  state.created = []; state.cancelled = []; state.notified = [];
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.FERIAS_MAPA;
  delete process.env.FERIAS_AVISOS;
});

const viewer = (u: { id: number; role: string }) => resolveLeaveViewer(u);

describe("pedir", () => {
  it("funcionário → férias POR APROVAR, com a lista de quem aprova guardada (front office: supervisor da cidade ou RH)", async () => {
    const r = await requestLeave(await viewer(U.ana), { fromDate: "2026-11-16", toDate: "2026-11-20", notes: "  praia " });
    expect(r).toMatchObject({ status: "requested", approvers: 2 });
    expect(state.created[0]).toMatchObject({ employeeId: 10, leaveType: "vacation", status: "requested", approverUserIds: [3, 4], notes: "praia", createdById: 20 });
    expect(state.notified).toEqual([]); // FERIAS_AVISOS desligado
  });
  it("com FERIAS_AVISOS ligado, o sino vai a quem pode aprovar", async () => {
    process.env.FERIAS_AVISOS = "on";
    await requestLeave(await viewer(U.ana), { fromDate: "2026-11-16", toDate: "2026-11-20" });
    expect(state.notified).toHaveLength(1);
    expect(state.notified[0]).toMatchObject({ kind: "leave_to_approve", targetUserIds: [3, 4], link: "/ferias?tab=aprovar" });
    expect(state.notified[0].body).toContain("5 dia(s) úteis");
  });
  it("extra → \"não vou estar\": entra logo, sem aprovação nem pagamento", async () => {
    const r = await requestLeave(await viewer(U.ze), { fromDate: "2026-11-20", toDate: "2026-11-22" });
    expect(r).toMatchObject({ status: "approved", approvers: 0 });
    expect(state.created[0]).toMatchObject({ leaveType: "unavailable", status: "approved", decidedById: null });
  });
  it("as do super admin ficam aprovadas sozinhas", async () => {
    const r = await requestLeave(await viewer(U.jorge), { fromDate: "2026-11-16", toDate: "2026-11-17" });
    expect(r.status).toBe("approved");
    expect(state.created[0]).toMatchObject({ leaveType: "vacation", status: "approved", decidedById: 1 });
  });
  it("recusas: parceiro-empresa, datas no passado, sobreposição com as suas, mês fechado, o fecho por ler", async () => {
    await expect(requestLeave(await viewer(U.parceiro), { fromDate: "2026-11-16", toDate: "2026-11-17" })).rejects.toThrow(/parceiros-empresa/);
    await expect(requestLeave(await viewer(U.ana), { fromDate: "2026-10-01", toDate: "2026-10-02" })).rejects.toThrow(/de hoje em diante/);
    await expect(requestLeave(await viewer(U.ana), { fromDate: "2026-12-24", toDate: "2026-12-28" })).rejects.toThrow(/Já tens férias marcadas/);
    await expect(requestLeave(await viewer(U.ana), { fromDate: "2026-11-20", toDate: "2026-11-16" })).rejects.toThrow(/antes da de início/);
    state.closed = new Set(["2026-11"]);
    await expect(requestLeave(await viewer(U.ana), { fromDate: "2026-11-16", toDate: "2026-11-17" })).rejects.toThrow("O mês de novembro de 2026 já está fechado");
    state.closed = new Set(); state.closedFails = true;
    await expect(assertPeriodOpen({ fromDate: "2026-11-16", toDate: "2026-11-17" })).rejects.toThrow(/nada foi gravado/);
    expect(state.created).toEqual([]);
  });
});

describe("aprovar e recusar", () => {
  it("ninguém aprova as suas; quem não está na lista não aprova; recusar pede o motivo", async () => {
    await expect(decideLeave(await viewer(U.ana), { id: 4, approve: true })).rejects.toThrow(/Ninguém aprova as suas/);
    await expect(decideLeave(await viewer(U.rui), { id: 4, approve: true })).rejects.toThrow(/Não estás entre quem aprova/);
    await expect(decideLeave(await viewer(U.rh), { id: 4, approve: false })).rejects.toThrow(/motivo da recusa/);
    expect(state.leaves.find((l) => l.id === 4).status).toBe("requested");
  });
  it("basta um: o RH aprova; a pessoa recebe o aviso (com os avisos ligados); já não se volta a decidir", async () => {
    process.env.FERIAS_AVISOS = "on";
    expect(await decideLeave(await viewer(U.rh), { id: 4, approve: true })).toEqual({ id: 4, status: "approved" });
    expect(state.leaves.find((l) => l.id === 4)).toMatchObject({ status: "approved", decidedById: 3 });
    expect(state.notified.at(-1)).toMatchObject({ kind: "my_leave", targetUserIds: [20], title: "Férias aprovadas: 21/12 a 24/12" });
    await expect(decideLeave(await viewer(U.supLx), { id: 4, approve: false, note: "x" })).rejects.toThrow(/já foi tratado/);
  });
  it("recusar com o motivo (a pessoa vê-o)", async () => {
    process.env.FERIAS_AVISOS = "on";
    await decideLeave(await viewer(U.supLx), { id: 4, approve: false, note: "Natal sem gente" });
    expect(state.leaves.find((l) => l.id === 4)).toMatchObject({ status: "rejected", decisionNote: "Natal sem gente" });
    expect(state.notified.at(-1).body).toContain("Motivo: Natal sem gente");
  });
  it("mês fechado: não se aprova", async () => {
    state.closed = new Set(["2026-12"]);
    await expect(decideLeave(await viewer(U.rh), { id: 4, approve: true })).rejects.toThrow(/dezembro de 2026 já está fechado/);
  });
  it("por aprovar: só os pedidos em que a conta está na lista (o super admin vê todos), com os dias úteis e quem mais está fora", async () => {
    const mine = await pendingForApprover(await viewer(U.rh));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: 4, fullName: "Ana Front", city: "lisbon", workingDays: 4, yearTotal: 4, daysPerYear: 22, colleaguesAway: ["Rui Condutor"] });
    expect(await pendingForApprover(await viewer(U.rui))).toEqual([]);
    expect(await pendingForApprover(await viewer(U.jorge))).toHaveLength(1);
  });
});

describe("cancelar (nunca apagar)", () => {
  it("a pessoa cancela o seu pedido; as aprovadas não (pede a quem aprova)", async () => {
    const ana = await viewer(U.ana);
    await cancelLeave({ userId: 20, role: "frontoffice", employeeId: ana.employeeId }, { id: 4 }, false);
    expect(state.cancelled).toEqual([{ id: 4, by: 20, note: null }]);
    const rui = await viewer(U.rui);
    await expect(cancelLeave({ userId: 21, role: "condutor", employeeId: rui.employeeId }, { id: 5 }, false)).rejects.toThrow(/só as cancela quem as aprova/);
  });
  it("quem aprova cancela as aprovadas; mês fechado não", async () => {
    await cancelLeave({ userId: 4, role: "supervisor", employeeId: 4 }, { id: 5, note: "operação" }, false);
    expect(state.cancelled.at(-1)).toEqual({ id: 5, by: 4, note: "operação" });
    state.leaves.find((l) => l.id === 2).status = "approved";
    state.closed = new Set(["2026-11"]);
    await expect(cancelLeave({ userId: 1, role: "super_admin", employeeId: 1 }, { id: 2 }, false)).rejects.toThrow(/novembro de 2026 já está fechado/);
  });
});

describe("quem vê o quê no mapa (filtro do servidor)", () => {
  const byName = (m: Awaited<ReturnType<typeof leaveMap>>) => {
    const name = new Map(m.people.map((p) => [p.id, p.fullName]));
    return m.leaves.map((l) => `${name.get(l.employeeId)}:${l.leaveType}:${l.status}${l.notes ? `:${l.notes}` : ""}`).sort();
  };
  it("colega: a sua cidade, sem extras nem parceiros; as suas (tudo) e só as FÉRIAS dos outros, sem notas", async () => {
    const m = await leaveMap(await viewer(U.rui), { year: 2026, canManageRh: false });
    expect(m.mode).toBe("employee");
    expect(m.people.map((p) => p.fullName).sort()).toEqual(["Ana Front", "Diretor Geral", "Pessoa RH", "Rui Condutor", "Supervisor Lisboa"]);
    expect(byName(m)).toEqual(["Ana Front:vacation:requested", "Rui Condutor:sick:approved:atestado", "Rui Condutor:vacation:approved"]);
  });
  it("supervisor: a sua área, com os extras que avisaram; baixas como \"ausente\" sem o motivo", async () => {
    const v = await cityScope.run({ all: false, defaultCityId: 1, cityIds: [1], projectIds: [1], missingCostCenter: false }, () => viewer(U.supLx));
    expect(v.mode).toBe("supervisor");
    const m = await leaveMap(v, { year: 2026, canManageRh: true });
    expect(m.people.map((p) => p.fullName)).not.toContain("TL Porto");
    expect(m.people.map((p) => p.fullName)).not.toContain("Parceiro Lda");
    expect(byName(m)).toEqual(["Ana Front:vacation:requested:Natal", "Rui Condutor:absent:approved", "Rui Condutor:vacation:approved", "Zé Extra:unavailable:approved:exames"]);
    // quem aprova vê o botão; o servidor volta a confirmar ao gravar
    expect(m.leaves.find((l) => l.id === 4)).toMatchObject({ canApprove: true, canCancel: true });
  });
  it("o RH (e quem vê tudo): todas as cidades, com o tipo e as notas", async () => {
    const m = await leaveMap(await viewer(U.rh), { year: 2026, canManageRh: true });
    expect(m.mode).toBe("full");
    expect(byName(m)).toEqual(["Ana Front:vacation:requested:Natal", "Rui Condutor:sick:approved:atestado", "Rui Condutor:vacation:approved", "TL Porto:vacation:approved", "Zé Extra:unavailable:approved:exames"]);
    const porto = await leaveMap(await viewer(U.rh), { year: 2026, cityKey: "porto", canManageRh: true });
    expect(byName(porto)).toEqual(["TL Porto:vacation:approved"]);
  });
  it("extra: só as suas indisponibilidades", async () => {
    const m = await leaveMap(await viewer(U.ze), { year: 2026, canManageRh: false });
    expect(m.mode).toBe("extra");
    expect(m.people.map((p) => p.fullName)).toEqual(["Zé Extra"]);
    expect(byName(m)).toEqual(["Zé Extra:unavailable:approved:exames"]);
  });
  it("leavesViewAll dá o mapa inteiro a uma conta escolhida", async () => {
    state.settings = { "rh.hrPeople": [3], "rh.leavesViewAll": [21] };
    const m = await leaveMap(await viewer(U.rui), { year: 2026, canManageRh: false });
    expect(m.mode).toBe("full");
    expect(byName(m)).toContain("TL Porto:vacation:approved");
  });
});
