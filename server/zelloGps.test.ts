import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: async () => null }));

import { holdersForDay, zelloAccuracyOk, zelloBattery, zelloSpeedKmh, zelloTimestamp } from "./zelloGps";
import { countSpeedViolations, processGeoJsonHistory } from "./jobs/dailyDriverCollection";

const pt = (lon: number, lat: number, props: Record<string, any>) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });

describe("velocidades do Zello (já em km/h)", () => {
  it("não multiplica por 3,6", () => {
    expect(zelloSpeedKmh({ speed: "50" })).toBe(50);
    expect(zelloSpeedKmh({ speed: -3 })).toBe(0);
    expect(zelloSpeedKmh(null)).toBe(0);
  });
  it("campos camelCase da API (com recurso aos antigos)", () => {
    expect(zelloBattery({ batteryLevel: 80 })).toBe(80);
    expect(zelloBattery({ battery_level: 60 })).toBe(60);
    expect(zelloTimestamp({ lastReport: 1700000000 })).toBe(1700000000);
  });
  it("precisão: até 100 m conta; sem valor conta", () => {
    expect(zelloAccuracyOk({ accuracy: 20 })).toBe(true);
    expect(zelloAccuracyOk({ accuracy: 500 })).toBe(false);
    expect(zelloAccuracyOk({})).toBe(true);
  });
  it("métricas do dia: velocidade máxima real e ponto impreciso ignorado", () => {
    const m = processGeoJsonHistory({
      features: [
        pt(-9.1, 38.7, { timestamp: 1000, speed: 30, accuracy: 10 }),
        pt(-9.1, 38.7, { timestamp: 1060, speed: 120, accuracy: 900 }), // impreciso
        pt(-9.1, 38.7, { timestamp: 1120, speed: 60, accuracy: 10 }),
      ],
    });
    expect(m.maxSpeed).toBe(60);
    expect(m.avgSpeed).toBe(45);
  });
  it("excessos contam em km/h", () => {
    const data = { features: [pt(0, 0, { speed: 55 }), pt(0, 0, { speed: 40 }), pt(0, 0, { speed: 70, accuracy: 300 })] };
    expect(countSpeedViolations(data, 50)).toBe(1);
  });
});

describe("quem tinha o PDA/Zello no dia", () => {
  const day = Date.parse("2026-09-20T00:00:00Z");
  const h = (n: number) => day + n * 3_600_000;
  it("PDA partilhado: fica com quem o teve mais tempo; check-in aberto conta até agora", () => {
    const m = holdersForDay(
      [
        { zello: "pda01", employeeId: 1, start: h(6), end: h(10) },
        { zello: "pda01", employeeId: 2, start: h(15), end: h(23) },
        { zello: "pda02", employeeId: 3, start: h(-5), end: null },
        { zello: null, employeeId: 4, start: h(1), end: h(2) },
      ],
      day,
      h(24),
      h(12),
    );
    expect(m.get("pda01")).toBe(2);
    expect(m.get("pda02")).toBe(3);
    expect(m.size).toBe(2);
  });
});
