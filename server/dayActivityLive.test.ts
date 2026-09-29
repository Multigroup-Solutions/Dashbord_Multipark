import { describe, expect, it, vi } from "vitest";

// Sem BD: as leituras entram por `readers` (simulados)
vi.mock("./db", () => ({ getDb: async () => null }));

import { loadActivityActions, personDayActions, splitActionWindow } from "./dayActivity";
import { LIVE_ACTIONS_SINCE, type ActivityActionRow } from "./multiparkDb/activityLive";
import { lisbonDayRangeUtc } from "../shared/lisbonDay";

const row = (over: Partial<ActivityActionRow> = {}): ActivityActionRow => ({ agentUserId: "u1", agentName: "Ana", changeType: "CHECK_IN", actionTime: "2026-09-27T08:00:00.000Z", n: 1, ...over });
const cut = lisbonDayRangeUtc(LIVE_ACTIONS_SINCE).start;

describe("regressão #141: a Atividade do Dia lê as ações ao vivo", () => {
  it("corte: cópia local só antes de LIVE_ACTIONS_SINCE (Lisboa)", () => {
    expect(LIVE_ACTIONS_SINCE).toBe("2026-03-02");
    expect(cut).toBe("2026-03-02 00:00:00"); // inverno: Lisboa = UTC
    expect(splitActionWindow("2026-09-26 23:00:00", "2026-09-27 23:00:00")).toEqual({ legacy: null, live: { from: "2026-09-26 23:00:00", to: "2026-09-27 23:00:00" } });
    expect(splitActionWindow("2026-02-01 00:00:00", "2026-02-10 00:00:00")).toEqual({ legacy: { from: "2026-02-01 00:00:00", to: "2026-02-10 00:00:00" }, live: null });
    expect(splitActionWindow("2026-02-25 00:00:00", "2026-03-05 00:00:00")).toEqual({
      legacy: { from: "2026-02-25 00:00:00", to: cut }, live: { from: cut, to: "2026-03-05 00:00:00" },
    });
  });

  it("hoje: só ao vivo (a cópia local nem é lida), com o âmbito de cidade", async () => {
    const live = vi.fn(async () => ({ available: true as const, data: { rows: [row({ n: 4 })], truncated: false } }));
    const legacy = vi.fn(async () => [row({ agentName: "velho" })]);
    const r = await loadActivityActions({ from: "2026-09-26 23:00:00", to: "2026-09-27 23:00:00", cities: ["Porto"] }, { live, legacy });
    expect(r).toEqual({ rows: [row({ n: 4 })], source: "multipark", notice: null });
    expect(legacy).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledWith({ from: "2026-09-26 23:00:00", to: "2026-09-27 23:00:00", cities: ["Porto"] });
  });

  it("BD da Multipark indisponível → cópia local para tudo, com aviso", async () => {
    const live = vi.fn(async () => ({ available: false as const, code: "CONNECT_FAILED" as const, reason: "Sem ligação à BD da Multipark neste momento." }));
    const legacy = vi.fn(async () => [row()]);
    const r = await loadActivityActions({ from: "2026-09-26 23:00:00", to: "2026-09-27 23:00:00" }, { live, legacy });
    expect(r.source).toBe("copia");
    expect(r.rows).toHaveLength(1);
    expect(r.notice).toMatch(/Sem ligação.*cópia local/);
    expect(legacy).toHaveBeenCalledWith({ from: "2026-09-26 23:00:00", to: "2026-09-27 23:00:00" });
  });

  it("intervalo a atravessar o corte → misto; antes do corte → só cópia", async () => {
    const live = vi.fn(async () => ({ available: true as const, data: { rows: [row({ agentUserId: "novo" })], truncated: true } }));
    const legacy = vi.fn(async () => [row({ agentUserId: "velho" })]);
    const r = await loadActivityActions({ from: "2026-02-25 00:00:00", to: "2026-03-05 00:00:00" }, { live, legacy });
    expect(r.source).toBe("misto");
    expect(r.rows.map((x) => x.agentUserId)).toEqual(["velho", "novo"]);
    expect(r.notice).toMatch(/cortada/);
    expect(legacy).toHaveBeenCalledWith({ from: "2026-02-25 00:00:00", to: cut });

    live.mockClear();
    const old = await loadActivityActions({ from: "2026-02-01 00:00:00", to: "2026-02-02 00:00:00" }, { live, legacy });
    expect(old.source).toBe("copia");
    expect(live).not.toHaveBeenCalled();
  });

  it("gaveta de uma pessoa: ao vivo por ids/nomes; sem BD → cópia com aviso; antes do corte → cópia", async () => {
    const detail = { bookingExternalId: "b1", changeType: "CHECK_IN", actionTime: "2026-09-27T08:00:00.000Z", agentName: "Ana", licensePlate: null, bookingNumber: null, parkName: null };
    const live = vi.fn(async () => ({ available: true as const, data: [detail] }));
    const legacy = vi.fn(async () => []);
    const r = await personDayActions("2026-09-27", { userIds: ["u1"], names: ["ana"] }, { live, legacy });
    expect(r).toEqual({ rows: [detail], source: "multipark", notice: null });
    expect(live).toHaveBeenCalledWith(expect.objectContaining({ from: "2026-09-26 23:00:00", to: "2026-09-27 23:00:00", userIds: ["u1"], names: ["ana"] }));

    const down = vi.fn(async () => ({ available: false as const, code: "TIMEOUT" as const, reason: "A BD da Multipark demorou demasiado a responder." }));
    const r2 = await personDayActions("2026-09-27", { userIds: ["u1"] }, { live: down, legacy });
    expect(r2.source).toBe("copia");
    expect(r2.notice).toMatch(/demorou/);

    const r3 = await personDayActions("2026-02-10", { userIds: ["u1"] }, { live, legacy });
    expect(r3.source).toBe("copia");
    expect(live).toHaveBeenCalledTimes(1);
  });
});
