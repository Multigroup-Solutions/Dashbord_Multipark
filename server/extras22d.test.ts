/**
 * P3 lote 22d — fase 1 da capacidade aprendida dos extras (Jorge, 3 out):
 * medir, não mexer na escala.
 *  - a Pressão mede desde abril (6 meses) e a janela só cresce;
 *  - nas cidades: condutor por carro, na estrada, até ao parque, pessoas por hora;
 *  - por escalão de pessoas (os da tabela máxima) × hora cheia;
 *  - p75 em Lisboa, p60 no Porto e em Faro (Definições).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertReadOnlySql } from "./multiparkDb/client";
import {
  buildPressureChunks, buildPressureCrewSql, buildPressureDriverSlotsSql, crewBandCase, mapPressureCrewRow, mapPressureDriverRow,
  pressureWindow, pressureWindowSince,
} from "./multiparkDb/pressure";
import { mapStoredRow } from "./extrasPressure";
import { mapParks } from "./multiparkDb/dayBookings";
import {
  MAX_CYCLE_MINUTES, PRESSURE_SINCE_DEFAULT, crewBandOf, crewMeasureBands, cycleAt, slotCycleAt, type PressureSlot,
} from "../shared/extrasPressure";
import { DEFAULT_CREW_RULES, DEFAULT_TIMES_PERCENTILE, SETTINGS, timesPercentileSchema } from "../shared/appSettings";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0430_STATEMENTS } from "./migrations/migration_0430";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("janela desde abril, a acumular", () => {
  it("de 3 abr até ontem; cresce com os dias", () => {
    expect(PRESSURE_SINCE_DEFAULT).toBe("2026-04-03");
    const w = pressureWindowSince(PRESSURE_SINCE_DEFAULT, "2026-10-02");
    expect(w.startDay).toBe("2026-04-03");
    expect(Object.values(w.weekdayDays).reduce((a, b) => a + b, 0)).toBe(183);
    const later = pressureWindowSince(PRESSURE_SINCE_DEFAULT, "2027-04-02");
    expect(later.startDay).toBe("2026-04-03");
    expect(Object.values(later.weekdayDays).reduce((a, b) => a + b, 0)).toBe(365);
  });
  it("início depois do fim ou inválido → recurso seguro", () => {
    expect(pressureWindowSince("2026-12-01", "2026-10-02")).toEqual(pressureWindow("2026-10-02"));
    expect(pressureWindowSince("lixo", "2026-10-02").startDay).toBe(PRESSURE_SINCE_DEFAULT);
    expect(pressureWindowSince(null, "2026-10-02").startDay).toBe(PRESSURE_SINCE_DEFAULT);
  });
  it("definições: desde quando e percentil por cidade (p75 Lisboa, p60 Porto e Faro)", () => {
    expect(SETTINGS["extras.timesSince"].defaultValue).toBe("2026-04-03");
    expect(SETTINGS["extras.timesPercentile"].defaultValue).toEqual({ lisbon: 75, porto: 60, faro: 60 });
    expect(DEFAULT_TIMES_PERCENTILE).toEqual({ lisbon: 75, porto: 60, faro: 60 });
    expect(timesPercentileSchema.safeParse({ lisbon: 70, porto: 60, faro: 60 }).success).toBe(false);
    expect(timesPercentileSchema.safeParse({ lisbon: 85, porto: 50, faro: 90 }).success).toBe(true);
  });
});

describe("escalões de pessoas = os da tabela máxima", () => {
  it("Lisboa 1 · 2 · 3–4 · 5–6 · 7+ com o máximo de cada um", () => {
    const b = crewMeasureBands(DEFAULT_CREW_RULES.lisbon);
    expect(b.map((x) => x.label)).toEqual(["1", "2", "3–4", "5–6", "7+"]);
    expect(b.map((x) => x.maxMinutes)).toEqual([null, 75, 60, 45, 30]);
    expect([1, 2, 3, 4, 5, 7, 12].map((n) => crewBandOf(b, n).label)).toEqual(["1", "2", "3–4", "3–4", "5–6", "7+", "7+"]);
  });
  it("Porto e Faro medem também com 2 (o mínimo da escala é 3, mas mede-se o que aconteceu)", () => {
    const b = crewMeasureBands(DEFAULT_CREW_RULES.porto);
    expect(b.map((x) => `${x.label}:${x.maxMinutes}`)).toEqual(["1:null", "2:45", "3+:30"]);
  });
  it("CASE do escalão em SQL (só constantes nossas)", () => {
    const sql = crewBandCase("crew.n", crewMeasureBands(DEFAULT_CREW_RULES.lisbon));
    expect(sql).toBe("CASE WHEN crew.n >= 2 AND crew.n <= 2 THEN 1 WHEN crew.n >= 3 AND crew.n <= 4 THEN 2 WHEN crew.n >= 5 AND crew.n <= 6 THEN 3 WHEN crew.n >= 7 THEN 4 ELSE 0 END");
  });
});

describe("leituras por condutor (BD da Multipark, só leitura)", () => {
  const w = pressureWindowSince(PRESSURE_SINCE_DEFAULT, "2026-10-02");
  it("células: parametrizado, percentis no Postgres, mesmo condutor, sem repetidos", () => {
    const { sql, params } = buildPressureDriverSlotsSql(w, ["p1", "p2"]);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain('b."parkId" IN ($1, $2)');
    expect(sql).toContain("lead(js.at) OVER (PARTITION BY js.uid ORDER BY js.at, js.bid)");
    expect(sql).toContain("DISTINCT ON (ha.bid, ha.ct)");
    expect(sql).toContain(`jb.gap <= ${MAX_CYCLE_MINUTES}`);
    for (const q of ["0.5", "0.6", "0.75", "0.85", "0.9"]) expect(sql).toContain(`percentile_cont(${q}) WITHIN GROUP (ORDER BY jw.cycle)`);
    expect(sql).toContain("count(DISTINCT ha.uid)");
    expect(sql).toContain("AT TIME ZONE 'Europe/Lisbon'");
    expect(sql).toContain("<> 'CANCELLED'");
    expect(params).toContain("p1");
    expect(params).toContain(w.start);
  });
  it("escalões: hora cheia = serviços começados ≥ pessoas", () => {
    const { sql } = buildPressureCrewSql(w, ["p1"], crewMeasureBands(DEFAULT_CREW_RULES.lisbon));
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain("(COALESCE(hj.jobs, 0) >= GREATEST(COALESCE(crew.n, 1), 1)) AS busy");
    expect(sql).toContain("WHERE jw.cycle IS NOT NULL");
  });
  it("linhas → células e escalões", () => {
    expect(mapPressureDriverRow({ wd: 5, hr: 18, cy_n: "30", cy_p50: 35.04, cy_p60: 38, cy_p75: 44.25, cy_p85: 50, cy_p90: 55, dr_n: 12, dr_p50: 20, dr_p75: 25, dr_p90: 31, tp_n: 9, tp_p50: 8, tp_p75: 11, crew_avg: "3.44" }))
      .toMatchObject({ weekday: 5, hour: 18, cycleN: 30, cycleP50: 35, cycleP75: 44.3, driveP75: 25, toParkP50: 8, crewAvg: 3.4 });
    expect(mapPressureDriverRow({ wd: 9, hr: 1 })).toBeNull();
    const bands = crewMeasureBands(DEFAULT_CREW_RULES.lisbon);
    expect(mapPressureCrewRow("cidade_lisboa", bands, { band: 2, busy: "t", n: "40", p50: 35, p60: 38, p75: 44, p85: 50, p90: 55 }))
      .toEqual({ group: "cidade_lisboa", band: 2, bandLabel: "3–4", busy: true, n: 40, p50: 35, p60: 38, p75: 44, p85: 50, p90: 55 });
    expect(mapPressureCrewRow("cidade_lisboa", bands, { band: 9, busy: false, n: 1 })).toBeNull();
  });
  it("percentil escolhido por cidade", () => {
    const r = { p50: 30, p60: 33, p75: 40, p85: 47, p90: 52 };
    expect(cycleAt(r, 75)).toBe(40);
    expect(cycleAt(r, 60)).toBe(33);
    const s = { cycleP50: 30, cycleP60: 33, cycleP75: 40, cycleP85: 47, cycleP90: 52 } as PressureSlot;
    expect(slotCycleAt(s, 85)).toBe(47);
  });
  it("só as cidades têm o passo por condutor, no fim (as células da cidade já existem)", () => {
    const parks = mapParks([
      { id: "p1", name: "Airpark Lisboa", city: "Lisboa", firebaseBrand: "airpark", listingType: "OWN", status: "ACTIVE" },
      { id: "p9", name: "Outro", city: "Braga", firebaseBrand: null, listingType: "MARKETPLACE", status: "ACTIVE" },
    ] as any);
    const chunks = buildPressureChunks(parks);
    const drivers = chunks.filter((c) => c.kind === "driver");
    expect(drivers.every((c) => c.key.startsWith("cidade_"))).toBe(true);
    expect(chunks.findIndex((c) => c.kind === "driver")).toBeGreaterThan(chunks.findIndex((c) => c.key === "marketplace"));
  });
});

describe("guardar e mostrar", () => {
  it("migração 0430 só acrescenta colunas", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0430");
    expect(MIGRATION_0430_STATEMENTS.every((s) => s.startsWith("ALTER TABLE `ops_pressure_stats` ADD COLUMN"))).toBe(true);
    expect(MIGRATION_0430_STATEMENTS.join(" ")).toContain("`cycleP60`");
  });
  it("linha guardada 'crew' → escalão; célula traz os campos por condutor", () => {
    expect(mapStoredRow({ parkGroup: "cidade_porto", kind: "crew", loadBucket: 2, rush: 1, bandLabel: "3+", cycleN: 12, cycleP50: "28.0", cycleP60: "30.5", cycleP75: null, cycleP85: null, cycleP90: null }).crew)
      .toEqual({ group: "cidade_porto", band: 2, bandLabel: "3+", busy: true, n: 12, p50: 28, p60: 30.5, p75: null, p85: null, p90: null });
    expect(mapStoredRow({ parkGroup: "cidade_porto", kind: "slot", weekday: 5, hour: 18, days: 26, cycleN: 7, cycleP60: "31.0", driveN: 5, driveP75: "22.0", crewAvg: "3.5" }).slot)
      .toMatchObject({ cycleN: 7, cycleP60: 31, driveP75: 22, crewAvg: 3.5 });
  });
  it("a rota passa a tabela e os percentis; o cron passa desde quando e a tabela", () => {
    const route = src("server/routers.ts").split("pressure: protectedProcedure")[1].split("}),")[0];
    expect(route).toContain('getSetting("extras.timesPercentile")');
    expect(route).toContain('getSetting("extras.crewRules")');
    const cron = src("server/cronJobs.ts").split("export async function extrasPressureCron")[1].split("\n}\n")[0];
    expect(cron).toContain('getSetting("extras.timesSince")');
    expect(cron).toContain("since, crewRules");
  });
  it("ecrã: métricas novas nas cidades e o cartão ao lado da tabela máxima (a escala não muda)", () => {
    const tab = src("client/src/pages/extrasDia/PressureTab.tsx");
    expect(tab).toContain("Por carro p{pct}");
    expect(tab).toContain("Na estrada p75");
    expect(tab).toContain("<CrewCard");
    expect(tab).toContain("Máximo = a tabela das Definições");
    expect(tab).toContain("a escala continua a usar a tabela máxima");
    expect(src("server/extrasDia.ts")).not.toContain("ops_pressure_stats");
  });
});
