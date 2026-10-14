/**
 * Tarefa 62 (Fase 1, P2d): fecho mensal da Avaliação (`evaluation.closedUntil`)
 * — o recálculo da noite e o Recalcular não escrevem dias ≤ a data; nula =
 * como hoje; o fecho não se lê → nada se grava; quem fecha = o super admin e
 * a lista `evaluation.closers` (Q10); a impressão digital das regras fixa.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  closed: { ok: true, closedUntil: null } as { ok: true; closedUntil: string | null } | { ok: false },
  inserted: 0,
  deleted: 0,
}));

vi.mock("./evaluationClose", async (original) => ({
  ...(await original<object>()),
  readEvaluationClosedUntil: async () => state.closed,
}));
vi.mock("./db", () => {
  const db = {
    select: () => ({ from: async () => [] }),
    execute: async () => [[]],
    insert: () => ({ values: (v: any[]) => ({ onDuplicateKeyUpdate: async () => { state.inserted += v.length; } }) }),
    delete: () => ({ where: async () => { state.deleted += 1; return [{ affectedRows: 0 }]; } }),
  };
  return { getDb: async () => db };
});
vi.mock("./evaluationIdentity", async (original) => {
  const real = await original<typeof import("./evaluationIdentity")>();
  const identity = real.buildEvaluationIdentity({
    employees: [{ id: 1, fullName: "Gelson Sousa", userId: 10, multiparkAgentName: null, multiparkAgentUserId: "mp-1" }],
    agentAliases: [], accountAliases: [],
  });
  return { ...real, loadEvaluationIdentity: async () => ({ identity, employees: [] }) };
});
vi.mock("./extraRates", () => ({ loadExtraRates: async () => ({}), rateFor: () => 10 }));
vi.mock("./extrasDia", () => ({ TL_WORKING_DAYS_PER_MONTH: 22 }));
vi.mock("./dayActivity", () => ({ speedThreshold: async () => 120 }));

import { recomputeRange, runEvaluationRecompute } from "./evaluationEngine";
import {
  EVALUATION_CLOSED_UNTIL_KEY, EVALUATION_CLOSERS_KEY, canCloseEvaluation, evaluationRulesFingerprint, fmtClosedUntil, isDayClosed, openFrom,
} from "../shared/evaluationClose";
import { SETTINGS, settingSuperAdminOnly, validateSetting } from "../shared/appSettings";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
const live = vi.fn(async (_s: string, _e: string) => ({
  available: true as const,
  data: { actions: [{ agentUserId: "mp-1", agentName: "Gelson Sousa", day: _s, shift: "night" as const, changeType: "CHECK_OUT", n: 1, parkingMoves: 0 }], occurrences: [] },
}));

beforeEach(() => { state.closed = { ok: true, closedUntil: null }; state.inserted = 0; state.deleted = 0; live.mockClear(); });

describe("regras puras do fecho", () => {
  it("dia fechado, 1.º dia aberto, quem fecha", () => {
    expect(isDayClosed("2026-11-30", "2026-11-30")).toBe(true);
    expect(isDayClosed("2026-12-01", "2026-11-30")).toBe(false);
    expect(isDayClosed("2026-11-01", null)).toBe(false);
    expect(openFrom("2026-11-20", "2026-12-05", "2026-11-30")).toBe("2026-12-01");
    expect(openFrom("2026-11-20", "2026-11-30", "2026-11-30")).toBeNull();
    expect(openFrom("2026-12-02", "2026-12-05", "2026-11-30")).toBe("2026-12-02");
    expect(openFrom("2026-11-20", "2026-11-25", null)).toBe("2026-11-20");
    expect(canCloseEvaluation({ id: 1, role: "super_admin" }, [])).toBe(true);
    expect(canCloseEvaluation({ id: 42, role: "admin" }, [42])).toBe(true);
    expect(canCloseEvaluation({ id: 43, role: "admin" }, [42])).toBe(false);
    expect(canCloseEvaluation(null, [42])).toBe(false);
    expect(fmtClosedUntil("2026-11-30")).toBe("30/11/2026");
  });
});

describe("definições", () => {
  it("evaluation.closedUntil: omissão nula (nada fechado), data AAAA-MM-DD, vazio = nula; só o super admin muda em Definições", () => {
    expect(SETTINGS[EVALUATION_CLOSED_UNTIL_KEY].defaultValue).toBeNull();
    expect(validateSetting(EVALUATION_CLOSED_UNTIL_KEY, "2026-11-30")).toEqual({ ok: true, value: "2026-11-30" });
    expect(validateSetting(EVALUATION_CLOSED_UNTIL_KEY, "")).toEqual({ ok: true, value: null });
    expect(validateSetting(EVALUATION_CLOSED_UNTIL_KEY, null)).toEqual({ ok: true, value: null });
    expect(validateSetting(EVALUATION_CLOSED_UNTIL_KEY, "2026-11-31").ok).toBe(false);
    expect(validateSetting(EVALUATION_CLOSED_UNTIL_KEY, "30/11/2026").ok).toBe(false);
    expect(settingSuperAdminOnly(EVALUATION_CLOSED_UNTIL_KEY)).toBe(true);
  });
  it("evaluation.closers: contas (ids), sem repetir, sem nomes no código; só o super admin muda", () => {
    expect(SETTINGS[EVALUATION_CLOSERS_KEY].defaultValue).toEqual([]);
    expect(validateSetting(EVALUATION_CLOSERS_KEY, [7, 7, 9])).toEqual({ ok: true, value: [7, 9] });
    expect(validateSetting(EVALUATION_CLOSERS_KEY, ["Cátia"]).ok).toBe(false);
    expect(settingSuperAdminOnly(EVALUATION_CLOSERS_KEY)).toBe(true);
    for (const f of ["shared/evaluationClose.ts", "server/evaluationClose.ts", "server/evaluationRouter.ts", "shared/appSettings.ts"]) expect(src(f)).not.toMatch(/C[áa]tia|Tabuada/);
  });
});

describe("recálculo com o fecho", () => {
  it("nula = como hoje: o intervalo todo", async () => {
    const r = await recomputeRange("2026-11-28", "2026-12-02", live);
    expect(live).toHaveBeenCalledWith("2026-11-28", "2026-12-02");
    expect(r.skipped).toBe(false);
  });
  it("fecho a meio do intervalo: só os dias abertos (o 1.º é o dia a seguir ao fecho)", async () => {
    state.closed = { ok: true, closedUntil: "2026-11-30" };
    const r = await recomputeRange("2026-11-28", "2026-12-02", live);
    expect(live).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledWith("2026-12-01", "2026-12-02");
    expect(r.closedUntil).toBe("2026-11-30");
  });
  it("tudo fechado: não lê, não grava, não apaga", async () => {
    state.closed = { ok: true, closedUntil: "2026-11-30" };
    const r = await recomputeRange("2026-11-01", "2026-11-30", live);
    expect(live).not.toHaveBeenCalled();
    expect(r).toMatchObject({ written: 0, removed: 0, skipped: false });
    expect(r.notice).toMatch(/Fechado até 30\/11\/2026/);
    expect(state.inserted + state.deleted).toBe(0);
  });
  it("o fecho não se leu: nada se grava (mais vale não recalcular do que mexer num mês pago)", async () => {
    state.closed = { ok: false };
    const r = await recomputeRange("2026-12-01", "2026-12-02", live);
    expect(live).not.toHaveBeenCalled();
    expect(r).toMatchObject({ written: 0, removed: 0, skipped: true });
    expect(state.inserted + state.deleted).toBe(0);
  });
  it("o cron da noite com a data a meio da janela dos 31 dias: as fatias fechadas não leem nem gravam", async () => {
    state.closed = { ok: true, closedUntil: "2026-11-30" };
    // 05/12: janela 05/11 → 05/12; fatias 05–11, 12–18, 19–25, 26/11–02/12, 03–05/12
    const r = await runEvaluationRecompute({ deadlineAt: Date.now() + 600_000, now: new Date("2026-12-05T12:00:00Z"), readLive: live });
    expect(r.done).toBe(true);
    expect(live.mock.calls).toEqual([["2026-12-01", "2026-12-02"], ["2026-12-03", "2026-12-05"]]);
    expect(r.slices.slice(0, 3).every((s) => s.written === 0 && s.removed === 0)).toBe(true);
  });
});

describe("o fecho congela as métricas, não as regras: a impressão digital das regras", () => {
  it("as regras da pontuação estão fixas (mudar = dizer a partir de que dia vale)", () => {
    const expected = JSON.stringify({
      version: 3,
      points: { movement: 2, spotChange: 1, pickupOrDelivery: 3, firstMoveAfterPickup: 5, speeding: -10, delay: -5, confirmedComplaint: -20, accidentOrDamage: -6000 },
      rules: [
        ["movement", "Movimento entre parques"], ["spotChange", "Mudança de lugar (mesma garagem)"], ["pickupOrDelivery", "Recolha ou entrega"],
        ["firstMoveAfterPickup", "1.º movimento após recolha (levar ao parque)"], ["speeding", "Excesso de velocidade"], ["delay", "Atraso ao trabalho (≥ 5 min)"],
        ["confirmedComplaint", "Reclamação confirmada"], ["accidentOrDamage", "Acidente ou dano/risco"],
      ],
      lateArrivalFromMinutes: 5,
      maxLateArrivalsPerDay: 1,
    });
    expect(evaluationRulesFingerprint(), "há meses fechados: diz a partir de que dia vale (como o withAccidentCutoff) antes de mudar as regras ou os pontos da Avaliação").toBe(expected);
  });
});
