/**
 * Plano 63, passo 11 — decisões do Jorge (15 out 2026) na escala do
 * Extras-Dia, com a BD simulada:
 *  1. quem avisou que não está nesse dia sai da lista da proposta automática
 *     (loadEligibleExtras: proposta, completar e "disponíveis por escalar"),
 *     só com FERIAS_MAPA ligado;
 *  2. a linha grava QUANDO a pessoa foi posta nesse dia (personAssignedAt):
 *     na linha nova e ao trocar a pessoa ou o dia — mexer nas horas não;
 *  3. a falta de quem tinha avisado (0 pontos) não conta nas faltas (60 dias)
 *     da ordem da proposta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noticeNoShowNote } from "../shared/leaves";

const st = vi.hoisted(() => ({
  candidates: [] as any[],
  leaves: [] as any[],
  penalties: [] as any[],
  rows: new Map<number, any>(),
  inserted: [] as any[],
  patches: [] as any[],
  nextId: 77,
}));

vi.mock("./db", async () => {
  const { MySqlDialect: D } = await import("drizzle-orm/mysql-core");
  const dialect = new D();
  const paramsOf = (cond: any) => (cond ? dialect.sqlToQuery(cond).params : []);
  const isSql = (v: any) => v && typeof v === "object" && "queryChunks" in v;
  const db = {
    execute: async (q: any) => {
      const { sql: t, params } = dialect.sqlToQuery(q);
      if (t.includes("FROM employee_leaves l") && t.includes("l.employeeId IN")) {
        const ids = params.filter((p) => typeof p === "number");
        const [to, from, ...statuses] = params.filter((p) => typeof p === "string") as string[];
        return [st.leaves.filter((l) => ids.includes(l.employeeId) && l.fromDate <= to && l.toDate >= from && (!statuses.length || statuses.includes(l.status)))];
      }
      if (t.includes("FROM employee_penalties")) {
        // a BD a fazer o que a consulta pede (com ou sem a exclusão das faltas de quem avisou)
        const excludesNotice = t.includes("NOT (points = 0 AND COALESCE(notes, '') LIKE");
        const like = (params.find((p) => typeof p === "string" && p.startsWith("%") && p.endsWith("%")) as string | undefined)?.slice(1, -1) ?? "";
        const ids = params.filter((p) => typeof p === "number");
        const counts = new Map<number, number>();
        for (const p of st.penalties) {
          if (!ids.includes(p.employeeId) || p.reason !== "no_show_extra_dia" || p.status !== "confirmed" || p.clearedAt != null) continue;
          if (excludesNotice && Number(p.points) === 0 && String(p.notes ?? "").includes(like)) continue;
          counts.set(p.employeeId, (counts.get(p.employeeId) ?? 0) + 1);
        }
        return [[...counts].map(([employeeId, n]) => ({ employeeId, n }))];
      }
      return [[]];
    },
    select: () => {
      let cond: any = null;
      const chain: any = {
        from: () => chain,
        where: (c: any) => { cond = c; return chain; },
        // por id (eq(id, X).limit(1)): a linha; sem limit (a mesma pessoa no mesmo dia): nenhuma
        limit: async () => { const r = st.rows.get(Number(paramsOf(cond)[0])); return r ? [r] : []; },
        then: (ok: any, ko: any) => Promise.resolve([]).then(ok, ko),
      };
      return chain;
    },
    insert: () => ({
      values: (v: any) => ({
        $returningId: async () => {
          const id = st.nextId++;
          st.inserted.push(v);
          st.rows.set(id, { id, version: 1, notes: null, sentHomeHour: null, level: "junior", isTeamLeader: 0, ...v });
          return [{ id }];
        },
      }),
    }),
    update: () => ({
      set: (patch: any) => ({
        where: async (c: any) => {
          st.patches.push(patch);
          const row = st.rows.get(Number(paramsOf(c)[0]));
          if (row) for (const [k, v] of Object.entries(patch)) if (!isSql(v)) row[k] = v;
          return [{ affectedRows: row ? 1 : 0 }];
        },
      }),
    }),
  };
  return { getDb: async () => db, logActivity: async () => {}, getEmployeeById: async () => undefined, getEmployeeByUserId: async () => undefined };
});
vi.mock("./extrasDia", async (original) => ({ ...(await original<object>()), listDriverCandidates: async () => st.candidates }));
vi.mock("./extrasSchedule", async (original) => ({ ...(await original<object>()), markScheduleManual: async () => {} }));
vi.mock("./trainingPaths", () => ({ employeesMissingTraining: async () => new Set<number>() }));
vi.mock("./employeeCity", () => ({ resolveCitiesForEmployeeIds: async (ids: number[]) => new Map(ids.map((id) => [id, { city: "lisboa" }])) }));
vi.mock("./extraRates", async (original) => {
  const o = await original<typeof import("./extraRates")>();
  return { ...o, loadExtraRates: async () => o.DEFAULT_EXTRA_RATES };
});
vi.mock("./google/pendingSync", () => ({ scheduleGoogleShiftSync: async () => {} }));

import { loadEligibleExtras, loadScheduleCandidates, noAnswerTargets } from "./extrasSchedule";
import { upsertAssignment } from "./extrasDia";

const extra = (id: number, fullName: string) => ({ id, fullName, position: "extra", suggestedLevel: "junior", availability: { windows: [{ from: 8, to: 20 }] } });
const leave = (o: Record<string, unknown>) => ({ leaveType: "unavailable", status: "approved", hours: null, notes: null, decisionNote: null, approverUserIds: null, requestedAt: "2026-10-20 09:00:00", createdAt: "2026-10-20 09:00:00", ...o });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
  process.env.FERIAS_MAPA = "on";
  st.candidates = [extra(7, "Zé Extra"), extra(8, "Rita Extra"), extra(9, "Nuno Extra")];
  st.leaves = [
    leave({ id: 1, employeeId: 7, fromDate: "2026-11-03", toDate: "2026-11-03" }),
    leave({ id: 2, employeeId: 8, leaveType: "other", fromDate: "2026-11-03", toDate: "2026-11-03", hours: 3 }),
    leave({ id: 3, employeeId: 9, status: "cancelled", fromDate: "2026-11-03", toDate: "2026-11-03" }),
  ];
  st.penalties = [];
  st.rows = new Map();
  st.inserted = [];
  st.patches = [];
  st.nextId = 77;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.FERIAS_MAPA;
});

describe("1. a lista da proposta automática deixa de fora quem avisou que não está", () => {
  it("o \"não vou estar\" de dia inteiro sai; parte do dia e os avisos cancelados ficam", async () => {
    expect((await loadEligibleExtras("2026-11-03", "lisbon")).map((c) => c.id)).toEqual([8, 9]);
    // noutro dia, o Zé volta a entrar
    expect((await loadEligibleExtras("2026-11-04", "lisbon")).map((c) => c.id)).toEqual([7, 8, 9]);
  });
  it("com o mapa DESLIGADO nada muda: entram todos", async () => {
    delete process.env.FERIAS_MAPA;
    expect((await loadEligibleExtras("2026-11-03", "lisbon")).map((c) => c.id)).toEqual([7, 8, 9]);
  });
});

describe("(auditoria final) \"Pedir disponibilidade a quem não respondeu\" não chama quem já avisou que não está", () => {
  const noAnswer = () => st.candidates.map((c) => ({ ...c, availability: { status: "no_response" } }));
  it("o \"não vou estar\" de dia inteiro sai; parte do dia e os avisos cancelados ficam; noutro dia entra", async () => {
    expect(await noAnswerTargets("2026-11-03", "lisbon", noAnswer())).toEqual([8, 9]);
    expect(await noAnswerTargets("2026-11-04", "lisbon", noAnswer())).toEqual([7, 8, 9]);
  });
  it("com o mapa DESLIGADO nada muda: pede a todos os que não responderam", async () => {
    delete process.env.FERIAS_MAPA;
    expect(await noAnswerTargets("2026-11-03", "lisbon", noAnswer())).toEqual([7, 8, 9]);
  });
});

describe("3. a ordem: a falta de quem tinha avisado não conta", () => {
  const nota = (extraNote = "") => `Possível falta ao extras-dia em 2026-10-01 (Zé Extra, lisbon, 9h) — sem check-in no turno; confirmar com a operação${extraNote}`;
  it("uma falta normal conta; a de quem avisou antes de ser escalado (0 pontos) não", async () => {
    st.penalties = [
      { employeeId: 7, reason: "no_show_extra_dia", status: "confirmed", clearedAt: null, points: 1, notes: nota() },
      { employeeId: 7, reason: "no_show_extra_dia", status: "confirmed", clearedAt: null, points: 0, notes: `${nota(noticeNoShowNote("2026-09-28"))} · revisão: ok` },
      { employeeId: 8, reason: "no_show_extra_dia", status: "confirmed", clearedAt: null, points: 1, notes: nota() },
      { employeeId: 8, reason: "no_show_extra_dia", status: "confirmed", clearedAt: null, points: 1, notes: nota() },
    ];
    const c = await loadScheduleCandidates("2026-11-04", "lisbon");
    expect(Object.fromEntries(c.map((x) => [x.id, x.noShows]))).toEqual({ 7: 1, 8: 2, 9: 0 });
  });
  it("sem faltas de quem avisou (como com o mapa desligado, que não as cria) a contagem é a de sempre", async () => {
    delete process.env.FERIAS_MAPA;
    st.penalties = [1, 2, 3].map(() => ({ employeeId: 9, reason: "no_show_extra_dia", status: "confirmed", clearedAt: null, points: 1, notes: nota() }));
    const c = await loadScheduleCandidates("2026-11-04", "lisbon");
    expect(c.find((x) => x.id === 9)?.noShows).toBe(3);
  });
});

describe("2. a linha guarda quando ESTA pessoa foi posta NESTE dia", () => {
  const NOW = "2026-10-15 10:00:00";
  const base = { city: "lisbon" as const, shift: "morning" as const, startHour: 8, endHour: 16, status: "confirmed" as const, source: "manual" as const };
  const existing = () => st.rows.set(50, {
    id: 50, assignmentDate: "2026-11-02", city: "lisbon", employeeId: 7, personName: "Zé Extra", level: "junior", isTeamLeader: 0, shift: "morning",
    startHour: 8, endHour: 16, sentHomeHour: null, notes: null, status: "confirmed", version: 1, source: "manual", createdAt: "2026-10-01 10:00:00", personAssignedAt: null,
  });
  it("linha nova → agora", async () => {
    await upsertAssignment({ ...base, assignmentDate: "2026-11-02", employeeId: 7, personName: "Zé Extra", createdById: 1 });
    expect(st.inserted[0]).toMatchObject({ employeeId: 7, assignmentDate: "2026-11-02", personAssignedAt: NOW });
  });
  it("mexer só nas horas (ou mandar para casa) não muda a hora de escalada", async () => {
    existing();
    await upsertAssignment({ ...base, id: 50, assignmentDate: "2026-11-02", employeeId: 7, personName: "Zé Extra", startHour: 9, endHour: 17, updatedById: 1 });
    await upsertAssignment({ ...base, id: 50, assignmentDate: "2026-11-02", employeeId: 7, personName: "Zé Extra", startHour: 9, endHour: 17, sentHomeHour: 13, updatedById: 1 });
    expect(st.patches).toHaveLength(2);
    for (const p of st.patches) expect(p).not.toHaveProperty("personAssignedAt");
    expect(st.rows.get(50).personAssignedAt).toBeNull();
  });
  it("trocar a pessoa → escala nova (agora)", async () => {
    existing();
    await upsertAssignment({ ...base, id: 50, assignmentDate: "2026-11-02", employeeId: 8, personName: "Rita Extra", updatedById: 1 });
    expect(st.patches[0]).toMatchObject({ employeeId: 8, personAssignedAt: NOW });
  });
  it("mudar a linha de dia → escala nova (agora)", async () => {
    existing();
    await upsertAssignment({ ...base, id: 50, assignmentDate: "2026-11-03", employeeId: 7, personName: "Zé Extra", updatedById: 1 });
    expect(st.patches[0]).toMatchObject({ assignmentDate: "2026-11-03", personAssignedAt: NOW });
  });
});

