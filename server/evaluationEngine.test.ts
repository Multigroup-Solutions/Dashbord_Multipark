import { beforeEach, describe, expect, it, vi } from "vitest";

// Motor da avaliação com os movimentos AO VIVO da BD da Multipark e o recurso
// à cópia local quando ela não responde. A nossa BD é uma imitação.
const state = vi.hoisted(() => ({
  executed: [] as string[],
  localHistory: [] as any[],
  inserted: 0,
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
      return [[]];
    },
    insert: () => ({ values: (v: any[]) => ({ onDuplicateKeyUpdate: async () => { state.inserted += v.length; } }) }),
    delete: () => ({ where: async () => [{ affectedRows: 0 }] }),
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

import { computeRange, runEvaluationRecompute } from "./evaluationEngine";

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
    expect(r.slices).toHaveLength(4);
    expect(liveOk).toHaveBeenCalledTimes(4);
    expect(r.slices.every((s) => s.source === "multipark")).toBe(true);
    expect(liveOk.mock.calls[0]).toEqual(["2026-08-29", "2026-09-04"]);
  });

  it("sem prazo para outra fatia: pára e devolve de onde continuar", async () => {
    const r = await runEvaluationRecompute({ deadlineAt: Date.now() + 1_000, now: new Date("2026-09-25T12:00:00Z"), readLive: liveDown });
    expect(r.slices).toHaveLength(1);
    expect(r.done).toBe(false);
    expect(r.nextOffset).toBe(7);
    expect(r.slices[0]).toMatchObject({ source: "copia" });
  });
});
