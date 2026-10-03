/**
 * 22d — o SQL da Pressão por condutor a correr num Postgres A SÉRIO, com uma
 * Multipark falsa onde se sabem os resultados certos. Só corre com
 * PRESSURE_PG_URL (ex.: postgres://pg@localhost:5499/postgres); sem ela fica
 * saltado (o CI não tem Postgres). Trabalha num schema temporário que apaga
 * no fim — nunca contra a BD da Multipark.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPressureCrewSql, buildPressureDriverSlotsSql, buildPressureLoadSql, buildPressureSlotsSql,
  mapPressureCrewRow, mapPressureDriverRow, pressureWindowSince,
} from "./multiparkDb/pressure";
import { crewMeasureBands } from "../shared/extrasPressure";
import { DEFAULT_CREW_RULES } from "../shared/appSettings";

const URL = process.env.PRESSURE_PG_URL;
const SCHEMA = `pressure_test_${process.pid}`;

describe.skipIf(!URL)("Pressão por condutor num Postgres real (PRESSURE_PG_URL)", () => {
  let client: any;
  const q = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows as Record<string, unknown>[];

  beforeAll(async () => {
    const pg = (await import("pg")).default;
    client = new pg.Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}`);
    await client.query(`
      CREATE TABLE "Park" (id text PRIMARY KEY, name text, city text);
      CREATE TABLE "Booking" (id text PRIMARY KEY, "parkId" text, status text, "checkIn" timestamp(3), "checkOut" timestamp(3),
        "checkInDate" timestamp(3), "checkOutDate" timestamp(3), "checkingInAt" timestamp(3), "pendingCheckoutAt" timestamp(3),
        "checkingOutAt" timestamp(3), "arrivedAtDeliveryAt" timestamp(3));
      CREATE TABLE "History" (id text PRIMARY KEY, "userId" text NOT NULL, "changeType" text NOT NULL, "bookingId" text NOT NULL,
        "actionTime" timestamp(3) NOT NULL, "agentName" text);
      INSERT INTO "Park" VALUES ('P1', 'Airpark', 'Lisboa');
      INSERT INTO "Booking" (id, "parkId", status, "checkInDate", "checkOutDate") VALUES
        ('bk1','P1','CHECKED_OUT','2026-08-30','2026-09-04'), ('bk2','P1','CHECKED_OUT','2026-08-30','2026-09-04'),
        ('bk3','P1','CHECKED_IN','2026-09-04','2026-09-12'), ('bk4','P1','CHECKED_OUT','2026-08-31','2026-09-04'),
        ('bk5','P1','CHECKED_OUT','2026-08-31','2026-09-04'), ('bk6','P1','CANCELLED','2026-08-31','2026-09-04'),
        ('bk7','P1','CHECKED_OUT','2026-08-31','2026-09-05'), ('bk8','P1','CHECKED_IN','2026-09-05','2026-09-12'),
        ('bk9','P1','CHECKED_OUT','2026-08-31','2026-09-05'), ('bk10','P1','CHECKED_OUT','2026-08-31','2026-09-05'),
        ('bk11','P1','CHECKED_IN','2026-09-05','2026-09-12');
      -- Sexta 4 set (verão: Lisboa = UTC+1). A: 2 entregas + 1 recolha; B: 2 entregas (+ 1 cancelada que não conta).
      INSERT INTO "History" VALUES
        ('h1','A','CHECKING_OUT','bk1','2026-09-04 16:00:00','Ana'), ('h13','A','CHECKING_OUT','bk1','2026-09-04 16:05:00','Ana'),
        ('h2','A','CHECK_OUT','bk1','2026-09-04 16:25:00','Ana'), ('h3','A','CHECKING_OUT','bk2','2026-09-04 16:40:00','Ana'),
        ('h4','A','CHECK_OUT','bk2','2026-09-04 17:05:00','Ana'), ('h5','A','CHECKING_IN','bk3','2026-09-04 17:20:00','Ana'),
        ('h6','A','CHECK_IN','bk3','2026-09-04 17:30:00','Ana'), ('h7','A','MOVEMENT','bk3','2026-09-04 17:45:00','Ana'),
        ('h8','B','CHECKING_OUT','bk4','2026-09-04 16:10:00','Bruno'), ('h9','B','CHECK_OUT','bk4','2026-09-04 16:30:00','Bruno'),
        ('h10','B','CHECKING_OUT','bk5','2026-09-04 16:50:00','Bruno'), ('h11','B','CHECK_OUT','bk5','2026-09-04 17:10:00','Bruno'),
        ('h12','B','CHECKING_OUT','bk6','2026-09-04 16:20:00','Bruno'),
      -- 26d, sábado 5 set. C: entrega 18:00 (entregue 18:20) + recolha 18:30 (10 min depois → PAR) e
      -- entrega 19:10 → o par conta como um serviço de 70 min. D: entrega 18:00 (entregue 18:20) e
      -- recolha só às 19:00 (40 min depois → não é par) → 60 min.
        ('h20','C','CHECKING_OUT','bk7','2026-09-05 18:00:00','Carla'), ('h21','C','CHECK_OUT','bk7','2026-09-05 18:20:00','Carla'),
        ('h22','C','CHECKING_IN','bk8','2026-09-05 18:30:00','Carla'), ('h23','C','CHECK_IN','bk8','2026-09-05 18:40:00','Carla'),
        ('h24','C','CHECKING_OUT','bk9','2026-09-05 19:10:00','Carla'),
        ('h25','D','CHECKING_OUT','bk10','2026-09-05 18:00:00','Duarte'), ('h26','D','CHECK_OUT','bk10','2026-09-05 18:20:00','Duarte'),
        ('h27','D','CHECKING_IN','bk11','2026-09-05 19:00:00','Duarte');
    `);
  });
  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await client.end();
  });

  const w = pressureWindowSince("2026-09-01", "2026-09-10");

  it("por hora: condutor por carro, na estrada, até ao parque e pessoas", async () => {
    const b = buildPressureDriverSlotsSql(w, ["P1"]);
    const rows = (await q(b.sql, b.params)).map(mapPressureDriverRow);
    // 17h de Lisboa: A 16:00→16:40 e B 16:10→16:50 (40 min); 2 pessoas. 26d: a entrega
    // das 16:40 (entregue 17:05) + a recolha das 17:20 são UM serviço, sem serviço a seguir → fora.
    expect(rows).toContainEqual(expect.objectContaining({ weekday: 5, hour: 17, cycleN: 2, cycleP50: 40, driveN: 4, driveP50: 22.5, crewAvg: 2 }));
    // 26d, sábado 19h: C entrega + recolha pelo meio = 70 min até ao serviço seguinte; D sem par = 60
    expect(rows).toContainEqual(expect.objectContaining({ weekday: 6, hour: 19, cycleN: 2, cycleP50: 65 }));
    // 18h: a recolha (recolhido 17:30 → no parque 17:45 = 15 min); sem serviço seguinte
    expect(rows).toContainEqual(expect.objectContaining({ weekday: 5, hour: 18, cycleN: 0, toParkN: 1, toParkP50: 15 }));
  });

  it("por escalão de pessoas × hora cheia", async () => {
    const bands = crewMeasureBands(DEFAULT_CREW_RULES.lisbon);
    const b = buildPressureCrewSql(w, ["P1"], bands);
    const rows = (await q(b.sql, b.params)).map((r) => mapPressureCrewRow("cidade_lisboa", bands, r));
    // sexta (40, 40) + sábado (70 do par, 60 sem par)
    expect(rows).toEqual([{ group: "cidade_lisboa", band: 1, bandLabel: "2", busy: true, n: 4, p50: 50, p60: 56, p75: 62.5, p85: 65.5, p90: 67 }]);
  });

  it("as leituras antigas continuam a correr com a janela nova", async () => {
    const a = buildPressureSlotsSql(w, ["P1"]);
    expect((await q(a.sql, a.params)).length).toBeGreaterThan(0);
    const l = buildPressureLoadSql(w, ["P1"]);
    await expect(q(l.sql, l.params)).resolves.toBeDefined();
  });
});
