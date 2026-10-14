/**
 * Tarefa 62 (Q8, Jorge: "não vem: marca-se falta"): quem tem horário fixo e
 * não picou a entrada fica como "possível falta" na lista que já existe (RH →
 * Possíveis faltas), atrás do interruptor RH_FALTAS_HORARIO (desligado por
 * omissão). Sem pontos de penalização; idempotente; fora a escala, as
 * férias/baixas e quem mexeu em carros.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({
  schedules: [] as any[],
  leaves: [] as any[],
  escala: [] as number[],
  checkIns: new Set<number>(),
  agents: new Map<number, string[]>(),
  moves: new Map<string, number>(),
  inserted: [] as any[],
}));

vi.mock("./db", async (original) => {
  const { extrasDiaAssignments, timeRecords, employeePenalties } = await import("../drizzle/schema");
  const dialect = new MySqlDialect();
  const db = {
    execute: async (q: any) => {
      const t = dialect.sqlToQuery(q).sql;
      if (t.includes("FROM schedules s JOIN employees e")) return [state.schedules];
      if (t.includes("FROM employee_leaves")) return [state.leaves];
      return [[]];
    },
    select: () => ({
      from: (table: any) => ({
        where: (cond: any) => {
          if (table === extrasDiaAssignments) return Promise.resolve(state.escala.map((employeeId) => ({ employeeId })));
          if (table === timeRecords) {
            const emp = Number(dialect.sqlToQuery(cond).params[0]);
            return { limit: async () => (state.checkIns.has(emp) ? [{ id: 1 }] : []) };
          }
          return Promise.resolve([]);
        },
      }),
    }),
    insert: (table: any) => ({
      values: async (v: any) => {
        if (table !== employeePenalties) throw new Error("tabela inesperada");
        if (state.inserted.some((x) => x.employeeId === v.employeeId && x.reason === v.reason && x.relatedId === v.relatedId)) throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
        state.inserted.push(v);
      },
    }),
  };
  return { ...(await original<object>()), getDb: async () => db };
});
vi.mock("./personIdentity", () => ({ agentIdsOfEmployee: async (id: number) => ({ agentUserIds: state.agents.get(id) ?? [] }) }));
vi.mock("./multiparkDb/movements", () => ({
  getAgentMovementSummaries: async (o: { userIds: string[] }) => ({ available: true, data: o.userIds.map((u) => ({ agentUserId: u, total: state.moves.get(u) ?? 0 })) }),
}));

import { FIXED_NO_SHOW_NOTE_PREFIX, FIXED_SCHEDULE_NO_SHOWS_FLAG, detectFixedScheduleNoShows, fixedNoShowRelatedId } from "./rhService";
import { AUTOMATION_FLAGS, automationFlagDefault, automationFlagSuperAdminOnly } from "../shared/appSettings";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
// 2 nov 2026 é segunda-feira (weekday 1)
const sched = (employeeId: number, o: Record<string, unknown> = {}) => ({ employeeId, weekday: 1, startTime: "09:00", endTime: "18:00", isWorkDay: 1, contractStart: null, contractEnd: null, ...o });

beforeEach(() => {
  state.schedules = []; state.leaves = []; state.escala = []; state.checkIns = new Set(); state.agents = new Map(); state.moves = new Map(); state.inserted = [];
});

describe("interruptor", () => {
  it("RH_FALTAS_HORARIO está no catálogo, desligado por omissão e só o super admin o muda", () => {
    expect(FIXED_SCHEDULE_NO_SHOWS_FLAG).toBe("RH_FALTAS_HORARIO");
    expect(AUTOMATION_FLAGS.some((f) => f.name === FIXED_SCHEDULE_NO_SHOWS_FLAG)).toBe(true);
    expect(automationFlagDefault(FIXED_SCHEDULE_NO_SHOWS_FLAG)).toBe(false);
    expect(automationFlagSuperAdminOnly(FIXED_SCHEDULE_NO_SHOWS_FLAG)).toBe(true);
  });
  it("a manutenção diária só corre a deteção com o interruptor ligado", () => {
    const c = src("server/cronJobs.ts");
    const block = c.slice(c.indexOf('await step("rh-no-shows"'), c.indexOf('await step("purge-deliveries"'));
    expect(block).toMatch(/if \(isFeatureEnabled\(FIXED_SCHEDULE_NO_SHOWS_FLAG, \{ defaultEnabled: automationFlagDefault\(FIXED_SCHEDULE_NO_SHOWS_FLAG\) \}\)\) \{\s+const f = await detectFixedScheduleNoShows\(yesterday\);/);
  });
});

describe("detectFixedScheduleNoShows", () => {
  it("horário de segunda sem entrada → possível falta PENDENTE, sem pontos, uma por pessoa e dia", async () => {
    state.schedules = [sched(2)];
    const r = await detectFixedScheduleNoShows("2026-11-02");
    expect(r).toMatchObject({ scanned: 1, created: 1, alreadyPending: 0, multiparkRead: true });
    expect(state.inserted[0]).toMatchObject({ employeeId: 2, reason: "other", status: "pending", points: 0, relatedId: fixedNoShowRelatedId("2026-11-02") });
    expect(fixedNoShowRelatedId("2026-11-02")).toBe(20261102);
    expect(state.inserted[0].notes.startsWith(FIXED_NO_SHOW_NOTE_PREFIX)).toBe(true);
    expect(state.inserted[0].notes).toContain("horário 09:00–18:00");
    // idempotente
    expect(await detectFixedScheduleNoShows("2026-11-02")).toMatchObject({ created: 0, alreadyPending: 1 });
  });
  it("fora: com entrada, na escala do Extras-Dia, de férias, dia livre, fora do contrato, com movimentos na Multipark", async () => {
    state.schedules = [sched(2), sched(3), sched(4), sched(5, { weekday: 2 }), sched(6, { contractEnd: "2026-10-31" }), sched(7)];
    state.checkIns = new Set([2]);
    state.escala = [3];
    state.leaves = [{ employeeId: 4, fromDate: "2026-11-01", toDate: "2026-11-07" }];
    state.agents.set(7, ["mp-7"]);
    state.moves.set("mp-7", 4);
    const r = await detectFixedScheduleNoShows("2026-11-02");
    expect(r.scanned).toBe(3); // 2, 3 e 7 (4 de férias, 5 folga, 6 fora do contrato)
    expect(r.skipped).toEqual({ escala: 1, check_in: 1, multipark: 1 });
    expect(r.created).toBe(0);
    expect(state.inserted).toEqual([]);
  });
  it("só funcionários: os extras regem-se pela escala (e têm a sua deteção)", () => {
    expect(src("server/rhService.ts")).toMatch(/WHERE e\.isActive = 1 AND s\.isWorkDay = 1\s+AND COALESCE\(e\.position, ''\) <> 'extra' AND COALESCE\(e\.contractType, ''\) <> 'extra'/);
  });
  it("a lista mostra 'Falta (horário fixo)'", () => {
    expect(src("client/src/pages/RhDashboardPage.tsx")).toContain('"Falta (horário fixo)"');
  });
});
