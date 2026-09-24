import { describe, expect, it } from "vitest";
import { addDays, daysInRange, lisbonDayOf, lisbonDayRangeUtc, lisbonHoursSince } from "../shared/lisbonDay";
import { aggregateSpeedHistory, buildIdentityResolver, classifyActionShift, leftoverFromShares } from "./activityHelpers";
import { splitByHolder } from "./zelloGps";
import { MIGRATION_0086_STATEMENTS } from "./migrations/migration_0086";

describe("dia de Lisboa → intervalo UTC [início, fim)", () => {
  it("verão: o dia começa às 23:00 UTC da véspera", () => {
    expect(lisbonDayRangeUtc("2026-09-23")).toMatchObject({ start: "2026-09-22 23:00:00", end: "2026-09-23 23:00:00" });
  });
  it("inverno: coincide com UTC", () => {
    expect(lisbonDayRangeUtc("2026-01-15")).toMatchObject({ start: "2026-01-15 00:00:00", end: "2026-01-16 00:00:00" });
  });
  it("mudança de hora: 23 h em março, 25 h em outubro", () => {
    const mar = lisbonDayRangeUtc("2026-03-29");
    expect(mar).toMatchObject({ start: "2026-03-29 00:00:00", end: "2026-03-29 23:00:00" });
    const oct = lisbonDayRangeUtc("2026-10-25");
    expect(oct).toMatchObject({ start: "2026-10-24 23:00:00", end: "2026-10-26 00:00:00" });
    expect((oct.endMs - oct.startMs) / 3_600_000).toBe(25);
  });
  it("intervalo de vários dias e dia de um instante UTC", () => {
    expect(lisbonDayRangeUtc("2026-09-01", "2026-09-30")).toMatchObject({ start: "2026-08-31 23:00:00", end: "2026-09-30 23:00:00" });
    expect(lisbonDayOf("2026-09-22 23:30:00")).toBe("2026-09-23");
    expect(lisbonDayOf("2026-01-15 23:30:00")).toBe("2026-01-15");
    expect(lisbonHoursSince("2026-09-23", "2026-09-23 06:00:00")).toBe(7);
    expect(daysInRange("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("turno das ações (B3)", () => {
  const night = { date: "2026-09-22", startHour: 20, endHour: 28 }; // 20h → 04h do dia 23
  it("madrugada conta no dia do turno da noite", () => {
    const at = "2026-09-23 01:30:00"; // 02:30 em Lisboa
    const r = classifyActionShift(lisbonDayOf(at), [night], (d) => lisbonHoursSince(d, at));
    expect(r).toEqual({ day: "2026-09-22", inShift: true });
  });
  it("sem turno a abrigar: fora do horário, no dia de calendário", () => {
    const at = "2026-09-23 10:00:00";
    const r = classifyActionShift(lisbonDayOf(at), [night], (d) => lisbonHoursSince(d, at));
    expect(r).toEqual({ day: "2026-09-23", inShift: false });
  });
});

describe("resto do GPS de um PDA partilhado (B1)", () => {
  it("km/horas sem ninguém com login ficam numa linha própria", () => {
    const rest = leftoverFromShares(
      { km: 30, hoursMoving: 3, hoursOnline: 8, maxSpeed: 90, violations: 4 },
      [{ km: 12, minutes: 180, movingMinutes: 60, maxSpeed: 60, violations: 1 }, { km: 10, minutes: 120, movingMinutes: 50, maxSpeed: 70, violations: 1 }],
    );
    expect(rest).toEqual({ km: 8, hoursOnline: 3, hoursMoving: 1.17, maxSpeed: 90, violations: 2 });
  });
  it("nada relevante a sobrar → null; a máxima explicada por uma parte não se repete", () => {
    expect(leftoverFromShares({ km: 10, hoursMoving: 1, hoursOnline: 2, maxSpeed: 60, violations: 0 }, [{ km: 10, minutes: 120, movingMinutes: 60, maxSpeed: 60, violations: 0 }])).toBeNull();
    expect(leftoverFromShares({ km: 11, hoursMoving: 1, hoursOnline: 2, maxSpeed: 60, violations: 0 }, [{ km: 10, minutes: 120, movingMinutes: null, maxSpeed: 60, violations: 0 }])?.maxSpeed).toBe(0);
  });
  it("pontos sem dono não entram em nenhuma parte (vão para o resto)", () => {
    const t0 = 1_790_000_000;
    const pts = [0, 60, 120, 180].map((dt, i) => ({ ts: t0 + dt, speed: 30, lat: 38.7 + i * 0.004, lon: -9.1, accurate: true }));
    const shares = splitByHolder(pts, [{ employeeId: 1, start: t0 * 1000, end: (t0 + 90) * 1000 }], 50);
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ employeeId: 1, points: 2, minutes: 1, movingMinutes: 1 });
    expect(shares[0].km).toBeCloseTo(0.44, 1); // só o 1.º segmento; os outros 2 ficam no resto
  });
});

describe("identidade: agente → pessoa (B4)", () => {
  const resolve = buildIdentityResolver(
    [
      { id: 1, fullName: "Ana Silva", multiparkAgentUserId: "u-ana", multiparkAgentName: "Ana S" },
      { id: 2, fullName: "Rui Costa", multiparkAgentUserId: null, multiparkAgentName: "Rui C" },
    ],
    [{ agentUserId: "u-ana-2", employeeId: 1, agentName: "Ana Silva 2" }, { agentUserId: "u-x", employeeId: 99, agentName: "Fora" }],
    [{ agentName: "Viagens Sol", partnerName: "Agência Sol" }],
    ["Sistema"],
  );
  it("pelo id do agente, por agente extra e pelo nome", () => {
    expect(resolve("u-ana", "outro nome")).toMatchObject({ kind: "colaborador", employeeId: 1 });
    expect(resolve("u-ana-2", null)).toMatchObject({ kind: "colaborador", employeeId: 1, key: "emp:1" });
    expect(resolve(null, "ana silva 2")).toMatchObject({ kind: "colaborador", employeeId: 1 });
    expect(resolve("zzz", " RUI C ")).toMatchObject({ kind: "colaborador", employeeId: 2 });
  });
  it("ignorados, parceiros e por ligar", () => {
    expect(resolve(null, "sistema")).toEqual({ kind: "ignorado" });
    expect(resolve(null, "Viagens Sol")).toMatchObject({ kind: "parceiro", name: "Agência Sol" });
    expect(resolve("u-x", "Fora")).toMatchObject({ kind: "por_ligar", key: "agent:fora" }); // ficha fora do âmbito
  });
});

describe("histórico de velocidade por pessoa", () => {
  it("junta partes e linhas do mesmo dia: soma km/excessos, máxima maior, média ponderada", () => {
    const days = aggregateSpeedHistory([
      { date: "2026-09-20", km: 10, maxSpeed: 50, avgSpeed: 30, points: 100, violations: 1, movingMinutes: 60, geoJsonUrl: "a" },
      { date: "2026-09-20", km: 5, maxSpeed: 70, avgSpeed: 60, points: 50, violations: 2, movingMinutes: null, geoJsonUrl: "b" },
      { date: "2026-09-21", km: 3, maxSpeed: 40, avgSpeed: 0, points: 0, violations: 0, movingMinutes: null },
    ]);
    expect(days).toEqual([
      { date: "2026-09-21", km: 3, maxSpeed: 40, avgSpeed: 0, violations: 0, hoursMoving: null, tracks: [] },
      { date: "2026-09-20", km: 15, maxSpeed: 70, avgSpeed: 40, violations: 3, hoursMoving: 1, tracks: ["a", "b"] },
    ]);
  });
});

describe("migração 0086", () => {
  it("coluna nula e idempotente", () => {
    expect(MIGRATION_0086_STATEMENTS).toEqual(["ALTER TABLE `driver_day_shares` ADD COLUMN `movingMinutes` INT NULL"]);
  });
});
