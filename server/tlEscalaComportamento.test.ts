/**
 * TL da escala do Extras-Dia (Jorge, 14 out 2026) — testes de COMPORTAMENTO
 * com a BD simulada: só contas com permissões de Team Leader entram como TL,
 * na lista (listDriverCandidates forTeamLeader) e ao guardar (upsertAssignment).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableName } from "drizzle-orm";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  overrides: new Map<number, Record<string, "grant" | "deny">>(),
  writes: 0,
}));

// BD simulada: select().from(t).where(...).limit()/orderBy() devolve as linhas da
// tabela; os where feitos só de `col = ?` (com and) filtram, o resto não filtra.
// Qualquer escrita (insert/update) para com WRITE_REACHED — chegar lá = aceite.
const dialect = new MySqlDialect();
function filterRows(rows: any[], cond: any): any[] {
  if (!cond) return rows;
  let q: { sql: string; params: unknown[] };
  try { q = dialect.sqlToQuery(cond); } catch { return rows; }
  const parts = q.sql.replace(/^\(|\)$/g, "").split(" and ");
  const eqs = parts.map((p) => /^`\w+`\.`(\w+)` = \?$/.exec(p.trim()));
  if (eqs.some((m) => !m) || eqs.length !== q.params.length) return rows;
  return rows.filter((r) => eqs.every((m, i) => r[m![1]] === q.params[i]));
}
const fakeDb = {
  select: () => {
    let rows: any[] = [];
    const chain: any = {
      from: (t: any) => { rows = state.tables[getTableName(t)] ?? []; return chain; },
      where: (c: any) => { rows = filterRows(rows, c); return chain; },
      orderBy: () => chain,
      limit: (n: number) => { rows = rows.slice(0, n); return chain; },
      then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
    };
    return chain;
  },
  insert: () => { state.writes++; throw new Error("WRITE_REACHED"); },
  update: () => { state.writes++; throw new Error("WRITE_REACHED"); },
};

vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => fakeDb,
  getUserPermissionOverrides: async (userId: number) => state.overrides.get(userId) ?? {},
  listPermissionAssignments: async () =>
    [...state.overrides.entries()].flatMap(([userId, o]) =>
      Object.entries(o).map(([permission, mode]) => ({ userId, permission, mode, userName: null, userEmail: null }))),
}));
vi.mock("./rhDocuments", async (original) => ({
  ...(await original<object>()),
  licenceStatusMap: async () => new Map(),
}));

import { listDriverCandidates, upsertAssignment } from "./extrasDia";

const emp = (id: number, fullName: string, position: string, userId: number | null) =>
  ({ id, fullName, position, extraLevel: null, isActive: 1, photoUrl: null, userId, projectId: 49 });
const user = (id: number, role: string, isActive = 1) => ({ id, role, isActive });

beforeEach(() => {
  state.writes = 0;
  state.overrides = new Map();
  state.tables = {
    employees: [
      emp(1, "Tânia TL", "extra", 101),          // conta team_leader (posto da ficha "extra" não interessa)
      emp(2, "Eduardo Extra", "extra", 102),     // conta extra, sem permissão
      emp(3, "Paula Promovida", "extra", 103),   // conta extra COM a permissão
      emp(4, "Rui Sem Conta", "team_leader", null), // posto TL na ficha mas sem conta
      emp(5, "Sofia Supervisora", "supervisor", 105),
      emp(6, "Dário Desativado", "team_leader", 106), // conta desativada
      emp(7, "Nuno Negado", "team_leader", 107),  // TL com a permissão negada
      emp(8, "Carlos Condutor", "driver", 108),
    ],
    users: [user(101, "team_leader"), user(102, "extra"), user(103, "extra"), user(105, "supervisor"), user(106, "team_leader", 0), user(107, "team_leader"), user(108, "condutor")],
    extras_dia_assignments: [],
  };
  state.overrides.set(103, { "extras_dia.team_leader": "grant" });
  state.overrides.set(107, { "extras_dia.team_leader": "deny" });
});

const tlInput = (employeeId: number, personName: string, extra: Record<string, unknown> = {}) => ({
  assignmentDate: "2026-10-15", city: "lisbon" as const, shift: "morning" as const,
  employeeId, personName, isTeamLeader: true, startHour: 7, endHour: 15, status: "confirmed" as const, ...extra,
});

describe("listDriverCandidates({ forTeamLeader }) — só contas com permissões de TL", () => {
  it("traz TL e acima e o extra com a permissão; tira extras, condutores, sem conta, desativados e negados", async () => {
    const list = await listDriverCandidates(undefined, { forTeamLeader: true });
    expect(list.map((c) => c.fullName).sort()).toEqual(["Paula Promovida", "Sofia Supervisora", "Tânia TL"]);
  });
  it("sem forTeamLeader continua a trazer toda a gente ativa (extras e condutores iguais)", async () => {
    const list = await listDriverCandidates();
    expect(list).toHaveLength(8);
  });
});

describe("upsertAssignment — o servidor recusa um TL sem permissões", () => {
  it("linha nova: extra sem permissão é recusado e nada se grava", async () => {
    await expect(upsertAssignment(tlInput(2, "Eduardo Extra"))).rejects.toThrow(/Eduardo Extra não pode ser Team Leader: a conta não tem permissões de Team Leader/);
    expect(state.writes).toBe(0);
  });
  it("linha nova: extra COM a permissão de TL é aceite", async () => {
    await expect(upsertAssignment(tlInput(3, "Paula Promovida"))).rejects.toThrow("WRITE_REACHED");
  });
  it("linha nova: conta team_leader é aceite mesmo com posto \"extra\" na ficha", async () => {
    await expect(upsertAssignment(tlInput(1, "Tânia TL"))).rejects.toThrow("WRITE_REACHED");
  });
  it("conta desativada, sem conta e permissão negada são recusados", async () => {
    await expect(upsertAssignment(tlInput(6, "Dário Desativado"))).rejects.toThrow(/conta no dashboard está desativada/);
    await expect(upsertAssignment(tlInput(4, "Rui Sem Conta"))).rejects.toThrow(/não tem conta no dashboard/);
    await expect(upsertAssignment(tlInput(7, "Nuno Negado"))).rejects.toThrow(/foi retirada à conta/);
    expect(state.writes).toBe(0);
  });
  it("trocar a pessoa de um TL já escalado volta a verificar (a nova pessoa tem de poder)", async () => {
    state.tables.extras_dia_assignments = [{ id: 50, assignmentDate: "2026-10-15", city: "lisbon", shift: "morning", employeeId: 1, isTeamLeader: 1, startHour: 7, endHour: 15 }];
    await expect(upsertAssignment(tlInput(2, "Eduardo Extra", { id: 50 }))).rejects.toThrow(/não pode ser Team Leader/);
    expect(state.writes).toBe(0);
  });
  it("uma linha de condutor que passa a TL também é verificada", async () => {
    state.tables.extras_dia_assignments = [{ id: 51, assignmentDate: "2026-10-15", city: "lisbon", shift: "morning", employeeId: 8, isTeamLeader: 0, startHour: 7, endHour: 15 }];
    await expect(upsertAssignment(tlInput(8, "Carlos Condutor", { id: 51 }))).rejects.toThrow(/Carlos Condutor não pode ser Team Leader/);
  });
  it("TL já escalado que só muda as horas não é revalidado (não se parte a escala)", async () => {
    state.tables.extras_dia_assignments = [{ id: 52, assignmentDate: "2026-10-15", city: "lisbon", shift: "morning", employeeId: 2, isTeamLeader: 1, startHour: 7, endHour: 15 }];
    await expect(upsertAssignment(tlInput(2, "Eduardo Extra", { id: 52, startHour: 8, endHour: 16 }))).rejects.toThrow("WRITE_REACHED");
  });
  it("condutores (não TL) não passam por esta regra", async () => {
    await expect(upsertAssignment({ ...tlInput(2, "Eduardo Extra"), isTeamLeader: false, level: "junior" })).rejects.toThrow("WRITE_REACHED");
  });
});
