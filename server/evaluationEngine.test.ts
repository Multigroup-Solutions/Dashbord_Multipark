import { beforeEach, describe, expect, it, vi } from "vitest";

// Motor da avaliação com os movimentos AO VIVO da BD da Multipark e o recurso
// à cópia local quando ela não responde. A nossa BD é uma imitação.
const state = vi.hoisted(() => ({
  executed: [] as string[],
  localHistory: [] as any[],
  inserted: 0,
  deleted: 0,
  penalties: [] as any[],
  relComplaints: [] as any[],
  relAlerts: [] as any[],
}));

function textOf(q: any): string {
  return (q?.queryChunks ?? []).map((c: any) => (Array.isArray(c?.value) ? c.value.join("") : "?")).join("");
}

vi.mock("./db", () => {
  const db = {
    select: () => ({ from: async () => [{ id: 1, position: "extra", contractType: "extra", extraLevel: 1, monthlySalary: null, projectId: 48 }] }),
    execute: async (q: any) => {
      const t = textOf(q);
      state.executed.push(t);
      if (t.includes("multipark_booking_history")) return [state.localHistory];
      if (t.includes("employee_penalties")) return [state.penalties];
      if (t.includes("d.complaintId IN")) return [state.relComplaints];
      if (t.includes("FROM speed_alerts WHERE employeeId IS NOT NULL AND id IN")) return [state.relAlerts];
      return [[]];
    },
    insert: () => ({ values: (v: any[]) => ({ onDuplicateKeyUpdate: async () => { state.inserted += v.length; } }) }),
    delete: () => ({ where: async () => { state.deleted += 1; return [{ affectedRows: 0 }]; } }),
  };
  return { getDb: async () => db };
});
vi.mock("./evaluationIdentity", async (original) => {
  const real = await original<typeof import("./evaluationIdentity")>();
  const identity = real.buildEvaluationIdentity({
    employees: [{ id: 1, fullName: "Gelson Manuel Leão Sousa", userId: 10, multiparkAgentName: null, multiparkAgentUserId: "mp-1" }],
    agentAliases: [], accountAliases: [],
  });
  return { ...real, loadEvaluationIdentity: async () => ({ identity, employees: [] }) };
});
vi.mock("./extraRates", () => ({ loadExtraRates: async () => ({}), rateFor: () => 10 }));
vi.mock("./extrasDia", () => ({ TL_WORKING_DAYS_PER_MONTH: 22 }));

import { computeRange, recomputeRange, runEvaluationRecompute } from "./evaluationEngine";

const liveOk = vi.fn(async (_s: string, _e: string) => ({
  available: true as const,
  data: {
    actions: [
      { agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", shift: "night" as const, changeType: "MOVEMENT", n: 2, parkingMoves: 1, lateDeliveries: 0 },
      { agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", shift: "night" as const, changeType: "CHECK_OUT", n: 1, parkingMoves: 0, lateDeliveries: 1 },
    ],
    occurrences: [{ agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", n: 1 }],
  },
}));
const liveDown = vi.fn(async () => ({ available: false as const, reason: "Sem ligação à BD da Multipark neste momento." }));

beforeEach(() => {
  state.executed = [];
  state.inserted = 0;
  state.deleted = 0;
  state.penalties = [];
  state.relComplaints = [];
  state.relAlerts = [];
  state.localHistory = [
    { bookingExternalId: "B1", historyId: "1", changeType: "CHECK_IN", actionTime: "2026-09-24 14:30:00", agentUserId: "mp-1", agentName: "Gelson Sousa" },
    { bookingExternalId: "B1", historyId: "2", changeType: "MOVEMENT", actionTime: "2026-09-24 14:50:00", agentUserId: "mp-1", agentName: "Gelson Sousa" },
  ];
  liveOk.mockClear();
  liveDown.mockClear();
});

describe("computeRange — movimentos da BD da Multipark", () => {
  it("usa as contagens vivas e não lê a cópia local", async () => {
    const out = await computeRange("2026-09-24", "2026-09-24", liveOk);
    expect(liveOk).toHaveBeenCalledWith("2026-09-24", "2026-09-24");
    expect(out.source).toBe("multipark");
    expect(out.notice).toBeNull();
    expect(state.executed.some((t) => t.includes("multipark_booking_history"))).toBe(false);
    // o resto (ponto, escala, ocorrências nossas, velocidade, penalizações) continua a vir da nossa BD
    expect(state.executed.some((t) => t.includes("time_records"))).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].metrics).toMatchObject({ actions: 3, movements: 2, parkingMoves: 1, entregas: 1, lateServices: 1, delays: 1, incidentsReported: 1 });
  });

  it("sem BD da Multipark: calcula com a cópia local e devolve o aviso", async () => {
    const out = await computeRange("2026-09-24", "2026-09-24", liveDown);
    expect(out.source).toBe("copia");
    expect(out.notice).toContain("Sem ligação à BD da Multipark");
    expect(out.notice).toContain("cópia local");
    expect(state.executed.some((t) => t.includes("multipark_booking_history"))).toBe(true);
    expect(out.rows[0].metrics).toMatchObject({ actions: 2, recolhas: 1, movements: 1, parkingMoves: 1, incidentsReported: 0 });
  });

  it("um erro inesperado na leitura viva também cai na cópia local (não rebenta)", async () => {
    const out = await computeRange("2026-09-24", "2026-09-24", async () => { throw new Error("boom"); });
    expect(out.source).toBe("copia");
    expect(out.notice).toContain("boom");
    expect(out.rows[0].metrics.actions).toBe(2);
  });
});

describe("cron evaluation-recompute", () => {
  it("lê ao vivo em cada fatia de 7 dias e diz a fonte", async () => {
    const r = await runEvaluationRecompute({ deadlineAt: Date.now() + 600_000, now: new Date("2026-09-25T12:00:00Z"), readLive: liveOk });
    expect(r.done).toBe(true);
    // 42a: o último mês (31 dias) = 5 fatias de 7 dias (a última com 3)
    expect(r.slices).toHaveLength(5);
    expect(liveOk).toHaveBeenCalledTimes(5);
    expect(r.slices.every((s) => s.source === "multipark")).toBe(true);
    expect(liveOk.mock.calls[0]).toEqual(["2026-08-26", "2026-09-01"]);
    expect(liveOk.mock.calls[4]).toEqual(["2026-09-23", "2026-09-25"]);
  });

  it("sem prazo para outra fatia: pára e devolve de onde continuar", async () => {
    const r = await runEvaluationRecompute({ deadlineAt: Date.now() + 1_000, now: new Date("2026-09-25T12:00:00Z"), readLive: liveDown });
    expect(r.slices).toHaveLength(1);
    expect(r.done).toBe(false);
    expect(r.nextOffset).toBe(7);
    expect(r.slices[0]).toMatchObject({ source: "copia" });
  });
});

describe("BD da Multipark em baixo: o recálculo não estraga o que está gravado", () => {
  it("não grava nem apaga nada e diz porquê", async () => {
    const r = await recomputeRange("2026-09-24", "2026-09-24", liveDown);
    expect(r).toMatchObject({ skipped: true, written: 0, removed: 0, source: "copia" });
    expect(r.notice).toContain("Nada foi gravado");
    expect(state.inserted).toBe(0);
    expect(state.deleted).toBe(0);
  });
  it("o cron também não (todas as fatias)", async () => {
    const r = await runEvaluationRecompute({ deadlineAt: Date.now() + 600_000, now: new Date("2026-09-25T12:00:00Z"), readLive: liveDown });
    expect(r.slices.every((x) => x.written === 0 && x.removed === 0)).toBe(true);
    expect(state.inserted).toBe(0);
    expect(state.deleted).toBe(0);
  });
  it("com a BD da Multipark grava como sempre", async () => {
    const r = await recomputeRange("2026-09-24", "2026-09-24", liveOk);
    expect(r).toMatchObject({ skipped: false, written: 1, source: "multipark" });
    expect(state.inserted).toBe(1);
  });
});

describe("penalização que aponta para uma reclamação/alerta de outra fatia", () => {
  it("não volta a contar a reclamação nem o excesso de velocidade", async () => {
    state.penalties = [
      { employeeId: 1, points: 2, reason: "complaint_investigation", relatedId: 70, createdAt: "2026-09-24 13:00:00" },
      { employeeId: 1, points: 1, reason: "speeding", relatedId: 50, createdAt: "2026-09-24 13:00:00" },
    ];
    state.relComplaints = [{ complaintId: 70, employeeId: 1, penaltyPoints: 2, status: "closed" }];
    state.relAlerts = [{ id: 50, employeeId: 1 }];
    const out = await computeRange("2026-09-24", "2026-09-24", liveOk);
    expect(out.rows[0].metrics).toMatchObject({ complaints: 0, speedingEvents: 0, penaltyPoints: 3 });
  });
  it("sem reclamação confirmada noutro dia, a penalização conta como antes", async () => {
    state.penalties = [{ employeeId: 1, points: 2, reason: "complaint_investigation", relatedId: 71, createdAt: "2026-09-24 13:00:00" }];
    state.relComplaints = [{ complaintId: 71, employeeId: 1, penaltyPoints: 0, status: "closed" }];
    const out = await computeRange("2026-09-24", "2026-09-24", liveOk);
    expect(out.rows[0].metrics.complaints).toBe(1);
  });
});
