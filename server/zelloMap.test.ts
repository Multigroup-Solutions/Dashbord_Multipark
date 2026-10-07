import { describe, expect, it } from "vitest";
import { hasValidMapPosition, type ZelloMapPosition } from "../shared/zelloMap";

const position = (latitude: number, longitude: number): ZelloMapPosition => ({
  username: "pda-1", displayName: "PDA 1", latitude, longitude,
  speed: 0, batteryLevel: 50, lastReportDelay: 0,
});

describe("posições do mapa GPS", () => {
  it.each([[38.77, -9.13], [41.15, -8.61], [37.02, -7.93], [40.49, -3.57], [0, 9], [9, 0], [-90, 180]])(
    "aceita coordenadas válidas (%s, %s), incluindo um eixo a zero", (lat, lng) => {
      expect(hasValidMapPosition(position(lat, lng))).toBe(true);
    },
  );
  it.each([[0, 0], [NaN, 1], [1, NaN], [Infinity, 1], [1, -Infinity], [90.1, 0], [-90.1, 0], [1, 180.1], [1, -180.1]])(
    "não envia coordenadas inválidas (%s, %s) à Google", (lat, lng) => {
      expect(hasValidMapPosition(position(lat, lng))).toBe(false);
    },
  );
});
