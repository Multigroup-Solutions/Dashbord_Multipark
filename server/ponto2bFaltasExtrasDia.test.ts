/**
 * Plano 63, passo 2b (decidido: as faltas dos funcionários nunca bloqueiam):
 * a possível falta de um FUNCIONÁRIO escalado no Extras-Dia vale 0 pontos.
 *   - extra (posto ou contrato "extra") → 1 ponto (3 confirmados bloqueiam, como sempre);
 *   - condutor com salário (funcionário) → 0 pontos, nunca bloqueia;
 *   - TL (linha de TL) → nada (continua sem possível falta).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({
  rows: [] as any[],
  people: new Map<number, { position: string; contractType: string | null }>(),
  inserted: [] as any[],
  blocked: new Map<number, number>(),
}));

vi.mock("./db", async (original) => {
  const { extrasDiaAssignments, timeRecords, employeePenalties, employees } = await import("../drizzle/schema");
  const dialect = new MySqlDialect();
  const params = (cond: any) => (cond ? dialect.sqlToQuery(cond).params : []);
  const resultFor = (table: any, cols: any, cond: any): any[] => {
    const p = params(cond);
    if (table === extrasDiaAssignments) return state.rows;
    if (table === timeRecords) return [];
    if (table === employees) {
      if (cols && "position" in cols) return p.map(Number).filter((id) => state.people.has(id)).map((id) => ({ id, ...state.people.get(id)! }));
      const id = Number(p[0]);
      return [{ blockedByDocs: 0, blockedByPenalties: state.blocked.get(id) ?? 0, blockedManually: 0, loginBlockedReason: null }];
    }
    if (table === employeePenalties) {
      if (cols && "total" in cols) {
        const emp = Number(p[0]);
        return [{ total: state.inserted.filter((x) => x.employeeId === emp && x.status === "confirmed" && !x.clearedAt).reduce((n, x) => n + Number(x.points), 0) }];
      }
      return state.inserted.filter((x) => x.id === Number(p[0]));
    }
    return [];
  };
  const db = {
    execute: async () => [[]],
    select: (cols?: any) => ({
      from: (table: any) => ({
        where: (cond: any) => {
          const r = () => resultFor(table, cols, cond);
          return { limit: async () => r(), then: (ok: any, ko: any) => Promise.resolve(r()).then(ok, ko) };
        },
      }),
    }),
    insert: (table: any) => ({
      values: async (v: any) => {
        if (table !== employeePenalties) throw new Error("tabela inesperada");
        if (state.inserted.some((x) => x.employeeId === v.employeeId && x.reason === v.reason && x.relatedId === v.relatedId)) throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
        state.inserted.push({ ...v, id: state.inserted.length + 1 });
        return [{ insertId: state.inserted.length }];
      },
    }),
    update: (table: any) => ({
      set: (patch: any) => ({
        where: async (cond: any) => {
          const id = Number(params(cond)[0]);
          if (table === employeePenalties) Object.assign(state.inserted.find((x) => x.id === id) ?? {}, patch);
          if (table === employees && "blockedByPenalties" in patch) state.blocked.set(id, Number(patch.blockedByPenalties));
        },
      }),
    }),
  };
  return { ...(await original<object>()), getDb: async () => db };
});
vi.mock("./personIdentity", () => ({ agentIdsOfEmployee: async () => ({ agentUserIds: [] }) }));
vi.mock("./multiparkDb/movements", () => ({ getAgentMovementSummaries: async () => ({ available: true, data: [] }) }));

import { detectExtraDiaNoShows, extraDiaNoShowPoints, reviewPenalty } from "./rhService";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
const line = (id: number, employeeId: number, personName: string) => ({ id, employeeId, personName, startHour: 8, endHour: 16, city: "lisbon", status: "confirmed", sentHomeHour: null });
const reviewer = { id: 9, role: "supervisor" };

beforeEach(() => {
  state.rows = []; state.people = new Map(); state.inserted = []; state.blocked = new Map();
});

describe("pontos de uma possível falta ao Extras-Dia (tabela do plano)", () => {
  it("extra → 1; condutor com salário (funcionário) → 0", () => {
    expect(extraDiaNoShowPoints({ position: "extra", contractType: "extra" })).toBe(1);
    expect(extraDiaNoShowPoints({ position: "extra", contractType: null })).toBe(1);
    // condutor com ficha de extra (contrato "extra") continua extra
    expect(extraDiaNoShowPoints({ position: "driver", contractType: "extra" })).toBe(1);
    expect(extraDiaNoShowPoints({ position: "driver", contractType: "permanent" })).toBe(0);
    expect(extraDiaNoShowPoints({ position: "senior_driver", contractType: "fixed_term" })).toBe(0);
    expect(extraDiaNoShowPoints({ position: "backoffice", contractType: "permanent" })).toBe(0);
    // sem a ficha lida: como antes
    expect(extraDiaNoShowPoints(null)).toBe(1);
  });

  it("deteção: o extra fica com 1 ponto, o condutor com salário com 0 (e a nota diz porquê)", async () => {
    state.rows = [line(11, 1, "Ana Extra"), line(12, 2, "Rui Condutor")];
    state.people.set(1, { position: "extra", contractType: "extra" });
    state.people.set(2, { position: "driver", contractType: "permanent" });
    const r = await detectExtraDiaNoShows("2026-11-02");
    expect(r).toMatchObject({ scanned: 2, created: 2 });
    const byEmp = new Map(state.inserted.map((x) => [x.employeeId, x]));
    expect(byEmp.get(1)).toMatchObject({ reason: "no_show_extra_dia", points: 1, status: "pending", relatedId: 11 });
    expect(byEmp.get(1).notes).not.toContain("sem pontos");
    expect(byEmp.get(2)).toMatchObject({ reason: "no_show_extra_dia", points: 0, status: "pending", relatedId: 12 });
    expect(byEmp.get(2).notes).toContain("funcionário: sem pontos");
  });

  it("TL: nada — as linhas de TL continuam fora da deteção", () => {
    const s = src("server/rhService.ts");
    const fn = s.slice(s.indexOf("export async function detectExtraDiaNoShows"), s.indexOf("// ─── Tarefa 62 (Q8)"));
    expect(fn).toContain("eq(extrasDiaAssignments.isTeamLeader, 0)");
  });

  it("confirmadas: 3 faltas de um funcionário nunca bloqueiam; 3 de um extra bloqueiam (como sempre)", async () => {
    state.people.set(1, { position: "extra", contractType: "extra" });
    state.people.set(2, { position: "driver", contractType: "permanent" });
    for (const [i, day] of ["2026-11-02", "2026-11-03", "2026-11-04"].entries()) {
      state.rows = [line(20 + i, 1, "Ana Extra"), line(30 + i, 2, "Rui Condutor")];
      await detectExtraDiaNoShows(day);
    }
    for (const p of state.inserted) await reviewPenalty(p.id, "confirmed", reviewer);
    expect(state.inserted.filter((x) => x.employeeId === 2).map((x) => x.points)).toEqual([0, 0, 0]);
    expect(state.blocked.get(2)).toBe(0);
    expect(state.blocked.get(1)).toBe(1);
  });
});
