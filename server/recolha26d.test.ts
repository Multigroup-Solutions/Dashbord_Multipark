/**
 * P3 lote 26d — regra do Jorge: "um condutor só consegue fazer uma entrega em
 * X tempo, mas se tiver uma recolha aí no meio não só faz como facilita".
 *  - previsão: a recolha no mesmo terminal entre 10 min antes e 30 min depois
 *    de uma entrega não conta como carro (interruptor por cidade, desligado);
 *  - medição (Pressão): entrega + recolha pelo meio do mesmo condutor = 1
 *    serviço (o SQL corre num Postgres a sério em extrasPressure.pg.test.ts).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PAIR_PICKUPS, SETTINGS, validateSetting } from "../shared/appSettings";
import {
  PICKUP_PAIR_AFTER_MIN, PICKUP_PAIR_BEFORE_MIN, describePickupPairing, pairPickupsWithDeliveries, pairTerminal, type PairService,
} from "../shared/extrasSchedule";

const settings = vi.hoisted(() => ({ v: undefined as unknown }));
vi.mock("./appSettings", () => ({ getSetting: vi.fn(async () => settings.v) }));

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const at = (hh: number, mm = 0) => hh * 60 + mm;
const t1 = (h: number, m = 0): PairService => ({ at: at(h, m), terminal: "t1" });

describe("26d — que recolhas ficam pelo meio de uma entrega (PURA)", () => {
  it("janela: 10 min antes a 30 min depois da hora da entrega", () => {
    expect([PICKUP_PAIR_BEFORE_MIN, PICKUP_PAIR_AFTER_MIN]).toEqual([10, 30]);
    const dels = [t1(10)];
    expect([...pairPickupsWithDeliveries(dels, [t1(9, 50)])]).toEqual([0]);
    expect([...pairPickupsWithDeliveries(dels, [t1(10, 30)])]).toEqual([0]);
    expect([...pairPickupsWithDeliveries(dels, [t1(9, 49)])]).toEqual([]);
    expect([...pairPickupsWithDeliveries(dels, [t1(10, 31)])]).toEqual([]);
  });

  it("uma recolha por entrega, a mais cedo; cada recolha só uma vez", () => {
    // 2 entregas às 10:00 e 3 recolhas 10:05, 10:10, 10:20 → ficam 2 pelo meio (as primeiras)
    expect([...pairPickupsWithDeliveries([t1(10), t1(10)], [t1(10, 20), t1(10, 5), t1(10, 10)])].sort()).toEqual([1, 2]);
    // 1 entrega, 2 recolhas → só 1
    expect(pairPickupsWithDeliveries([t1(10)], [t1(10, 5), t1(10, 6)]).size).toBe(1);
    expect(pairPickupsWithDeliveries([], [t1(10)]).size).toBe(0);
  });

  it("mesmo terminal; \"Outro\" (morada, hotel, estação) nunca conta", () => {
    expect(["t1", "vip", "unknown", "t2", "other"].map(pairTerminal)).toEqual(["t1", "t1", "t1", "t2", null]);
    expect(pairPickupsWithDeliveries([t1(10)], [{ at: at(10, 5), terminal: "t2" }]).size).toBe(0);
    expect(pairPickupsWithDeliveries([{ at: at(10), terminal: "t2" }], [{ at: at(10, 5), terminal: "t2" }]).size).toBe(1);
    expect(pairPickupsWithDeliveries([{ at: at(10), terminal: null }], [{ at: at(10, 5), terminal: null }]).size).toBe(0);
  });

  it("determinístico (a mesma entrada dá sempre o mesmo par)", () => {
    const d = [t1(8), t1(8, 15), t1(9)], p = [t1(8, 20), t1(8, 5), t1(9, 25), t1(12)];
    expect([...pairPickupsWithDeliveries(d, p)]).toEqual([...pairPickupsWithDeliveries([...d].reverse(), p)]);
  });
});

describe("26d — texto na previsão", () => {
  it("ligado: quantas e o pico com/sem", () => {
    expect(describePickupPairing({ on: true, pairs: 3, peakWith: 4, peakWithout: 5 })).toBe("3 recolhas são pelo meio de uma entrega e não contam como carro (pico: 4 extras; sem esta regra seriam 5 extras).");
    expect(describePickupPairing({ on: true, pairs: 1, peakWith: 4, peakWithout: 4 })).toBe("1 recolha é pelo meio de uma entrega e não conta como carro.");
  });
  it("desligado: mostra o que mudava; sem pares → nada", () => {
    expect(describePickupPairing({ on: false, pairs: 2, peakWith: 1, peakWithout: 2 })).toBe("2 recolhas são pelo meio de uma entrega. Com a regra ligada (Definições → Parâmetros → Recolha pelo meio de uma entrega) o pico passava de 2 extras para 1 extra.");
    expect(describePickupPairing({ on: false, pairs: 2, peakWith: 3, peakWithout: 3 })).toContain("o pico não mudava");
    expect(describePickupPairing({ on: true, pairs: 0, peakWith: 3, peakWithout: 3 })).toBeNull();
    expect(describePickupPairing(null)).toBeNull();
  });
});

describe("26d — interruptor por cidade (desligado por omissão)", () => {
  it("definição viva, JSON validado", () => {
    expect(DEFAULT_PAIR_PICKUPS).toEqual({ lisbon: false, porto: false, faro: false });
    const d = SETTINGS["extras.pairPickups"];
    expect(d.defaultValue).toEqual(DEFAULT_PAIR_PICKUPS);
    expect(d.wiring).toBe("live");
    expect(d.label).toBe("Recolha pelo meio de uma entrega (por cidade)");
    expect(validateSetting("extras.pairPickups", { lisbon: true, porto: false, faro: false }).ok).toBe(true);
    expect(validateSetting("extras.pairPickups", { lisbon: "sim" }).ok).toBe(false);
  });
  it("loadPairPickups: só a cidade ligada; sem definição ou BD em baixo → desligado", async () => {
    const { loadPairPickups } = await import("./extrasDia");
    settings.v = undefined;
    expect(await loadPairPickups("lisbon")).toBe(false);
    settings.v = { lisbon: true, porto: false, faro: false };
    expect(await loadPairPickups("lisbon")).toBe(true);
    expect(await loadPairPickups("porto")).toBe(false);
  });
});

describe("26d — ligações no código", () => {
  it("previsão: pares só das reservas do dia; a recolha do par pesa 0 (no T2 fica a meia extra); a escala lê a procura escolhida", () => {
    const dia = src("server/extrasDia.ts");
    expect(dia).toContain("const pairedPickups = pairPickupsWithDeliveries(");
    expect(dia).toContain('addToSlot(hm.hour, hm.minute, r.deliveryType, "checkin", pairedPickups.has(i));');
    expect(dia).toContain("const paired = pairedPickup ? spread.map((v, i) => (i === 0 ? 0 : v)) : spread;");
    expect(dia).toContain("const demandBySlot = pairOn ? weightedPairedBySlot : weightedBySlot;");
    expect(dia).toContain("s.weightedDemand = demandBySlot[idx];");
    expect(dia).toContain("pickupPairing,");
    expect(src("client/src/pages/ExtrasDiaPage.tsx")).toContain("describePickupPairing(data.pickupPairing)");
  });

  it("medição: par = entrega + recolha do mesmo condutor até 30 min depois de entregar; só leitura", () => {
    const p = src("server/multiparkDb/pressure.ts");
    expect(p).toContain("const pairAfter = `interval '${Number(PICKUP_PAIR_AFTER_MIN)} minutes'`;");
    expect(p).toContain("jo.ct = 'CHECKING_OUT' AND jo.n1_ct = 'CHECKING_IN' AND jo.n1_at >= jo.at AND jo.n1_at <= jo.co_done + ${pairAfter}");
    expect(p).toContain("CASE WHEN jp.pair_prev THEN NULL WHEN jp.pair_next THEN");
    const fn = p.slice(p.indexOf("export function pressureDriverCtes"), p.indexOf("export function buildPressureDriverSlotsSql"));
    expect(fn).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(src("docs/ajuda/extras-dia.md")).toContain("**Recolha pelo meio de uma entrega**");
  });
});
