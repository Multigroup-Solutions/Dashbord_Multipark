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
    // 27b: a Ana (A) é TL; sábado (C e D) não há TL a agir → +1 nas pessoas
    const b = buildPressureDriverSlotsSql(w, ["P1"], ["A"]);
    const rows = (await q(b.sql, b.params)).map(mapPressureDriverRow);
    // 17h de Lisboa: A 16:00→16:40 e B 16:10→16:50 (40 min); 2 pessoas. 26d: a entrega
    // das 16:40 (entregue 17:05) + a recolha das 17:20 são UM serviço, sem serviço a seguir → fora.
    expect(rows).toContainEqual(expect.objectContaining({ weekday: 5, hour: 17, cycleN: 2, cycleP50: 40, driveN: 4, driveP50: 22.5, crewAvg: 2 }));
    // 26d, sábado 19h: C entrega + recolha pelo meio = 70 min até ao serviço seguinte; D sem par = 60
    expect(rows).toContainEqual(expect.objectContaining({ weekday: 6, hour: 19, cycleN: 2, cycleP50: 65, crewAvg: 3 }));
    // 18h: a recolha (recolhido 17:30 → no parque 17:45 = 15 min); sem serviço seguinte
    expect(rows).toContainEqual(expect.objectContaining({ weekday: 5, hour: 18, cycleN: 0, toParkN: 1, toParkP50: 15 }));
  });

  it("por escalão de pessoas × hora cheia", async () => {
    const bands = crewMeasureBands(DEFAULT_CREW_RULES.lisbon);
    const b = buildPressureCrewSql(w, ["P1"], bands, ["A"]);
    const rows = (await q(b.sql, b.params)).map((r) => mapPressureCrewRow("cidade_lisboa", bands, r));
    // 27b: sexta a Ana (TL) agiu → 2 pessoas (40, 40); sábado o TL não agiu → C + D + TL = 3 (70 do par, 60 sem par).
    // Hora cheia pelos que agiram (3 serviços ≥ 2 pessoas).
    expect(rows).toEqual([
      { group: "cidade_lisboa", band: 1, bandLabel: "2", busy: true, n: 2, p50: 40, p60: 40, p75: 40, p85: 40, p90: 40 },
      { group: "cidade_lisboa", band: 2, bandLabel: "3–4", busy: true, n: 2, p50: 65, p60: 66, p75: 67.5, p85: 68.5, p90: 69 },
    ]);
    // sem TL conhecido → +1 em todas as horas (sexta passa a 3)
    const b0 = buildPressureCrewSql(w, ["P1"], bands, []);
    const rows0 = (await q(b0.sql, b0.params)).map((r) => mapPressureCrewRow("cidade_lisboa", bands, r));
    expect(rows0.map((r) => [r?.bandLabel, r?.n])).toEqual([["3–4", 4]]);
  });

  it("as leituras antigas continuam a correr com a janela nova", async () => {
    const a = buildPressureSlotsSql(w, ["P1"]);
    expect((await q(a.sql, a.params)).length).toBeGreaterThan(0);
    const l = buildPressureLoadSql(w, ["P1"]);
    await expect(q(l.sql, l.params)).resolves.toBeDefined();
  });
});

// ─── 47c: dia a dia + juntar = janela inteira (Postgres a sério) ─────────────

/**
 * Prova do lote 47c: as leituras de UM dia (buildPressureDaySql /
 * buildPressureDriverDaySql), guardadas por dia e juntadas
 * (server/pressureDays.ts), dão EXATAMENTE as mesmas células, cargas, tempos
 * por condutor e escalões que as leituras antigas da janela inteira — com
 * dados aleatórios (semente fixa) com enums como na Multipark, ações repetidas,
 * reservas longas com movimentos a meio, ações perto da meia-noite, sem
 * colunas do Booking (só History) e a mudança da hora de 25 out. As leituras
 * novas correm como em produção (sem nested loops nem JIT).
 */
describe.skipIf(!URL)("47c — dia a dia + juntar = leitura da janela inteira (PRESSURE_PG_URL)", () => {
  const EQ = `pressure_eq_${process.pid}`;
  let client: any;
  const q = async (x: { sql: string; params: unknown[] }) => (await client.query(x.sql, x.params)).rows as Record<string, unknown>[];
  const since = "2026-10-12";
  const end = "2026-11-03";
  const parks = ["G1", "G2"];
  const tl = ["A"];

  beforeAll(async () => {
    const pg = (await import("pg")).default;
    client = new pg.Client({ connectionString: URL });
    await client.connect();
    let seed = 4747;
    const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const MIN = 60_000;
    const ts = (ms: number) => `'${new Date(ms).toISOString().replace("T", " ").replace("Z", "")}'`;
    const NOW = Date.parse("2026-11-05T03:00:00Z");
    const bookings: string[] = [];
    const history: string[] = [];
    let hid = 0;
    const act = (bid: string, ct: string, at: number, uid: string) => history.push(`('h${++hid}', '${rnd() < 0.03 ? "" : uid}', '${ct}', '${bid}', ${ts(at)})`);
    for (let day = Date.parse("2026-10-05T00:00:00Z"), k = 0; day < Date.parse("2026-11-08T00:00:00Z"); day += 86_400_000) {
      for (let j = 0; j < 26; j++, k++) {
        const id = `b${k}`;
        const park = pick(["G1", "G1", "G2", "X1"]);
        const ciDate = day + Math.floor(rnd() * 24 * 60) * MIN + Math.floor(rnd() * 60_000);
        const long = rnd() < 0.1;
        const coDate = ciDate + (long ? 15 + rnd() * 15 : rnd() * 6) * 86_400_000;
        const ci = ciDate + Math.floor(rnd() * 40 * MIN);
        const co = coDate + Math.floor(rnd() * 50 * MIN);
        const status = rnd() < 0.05 ? "CANCELLED" : co < NOW ? "CHECKED_OUT" : ci < NOW ? "CHECKED_IN" : "BOOKED";
        const checkingInAt = status !== "BOOKED" && rnd() < 0.6 ? ci - (3 + rnd() * 27) * MIN : null;
        const out = status === "CHECKED_OUT" || (status === "CANCELLED" && co < NOW);
        const pendingAt = out && rnd() < 0.5 ? co - (10 + rnd() * 60) * MIN : null;
        const checkingOutAt = out && rnd() < 0.6 ? co - (5 + rnd() * 35) * MIN : null;
        const arrivedAt = out && rnd() < 0.4 ? co - rnd() * 6 * MIN : null;
        const n = (x: number | null) => (x == null ? "NULL" : ts(Math.round(x)));
        bookings.push(`('${id}', '${park}', '${status}', ${ts(ci)}, ${ts(co)}, ${ts(ciDate)}, ${ts(coDate)}, ${n(checkingInAt)}, ${n(pendingAt)}, ${n(checkingOutAt)}, ${n(arrivedAt)})`);
        if (status === "BOOKED") continue;
        const d1 = pick(["A", "B", "C", "D", "E", "F"]);
        const d2 = pick(["A", "B", "C", "D", "E", "F"]);
        if (rnd() < 0.85) act(id, "CHECKING_IN", Math.round(checkingInAt ?? ci - (5 + rnd() * 20) * MIN), d1);
        if (rnd() < 0.88) act(id, "CHECK_IN", ci, d1);
        if (rnd() < 0.04) act(id, "CHECK_IN", ci + (2 + rnd()) * 86_400_000, d1); // repetida dias depois
        if (rnd() < 0.8) act(id, "MOVEMENT", Math.round(ci + (5 + rnd() * 55) * MIN), pick(["A", "B", "C", "D", "E", "F"]));
        if (long) act(id, "MOVEMENT", Math.round(ci + rnd() * (co - ci)), pick(["B", "C", "D"])); // a meio de uma estadia longa
        if (!out) continue;
        if (rnd() < 0.7) act(id, "PENDING_CHECKOUT", Math.round(pendingAt ?? co - (20 + rnd() * 50) * MIN), "cliente");
        if (rnd() < 0.85) {
          const at = Math.round(checkingOutAt ?? co - (5 + rnd() * 35) * MIN);
          act(id, "CHECKING_OUT", at, d2);
          if (rnd() < 0.08) act(id, "CHECKING_OUT", at + 3 * MIN, d2); // repetida logo a seguir
        }
        if (rnd() < 0.9) act(id, "CHECK_OUT", co, d2);
      }
    }
    await client.query(`CREATE SCHEMA ${EQ}; SET search_path TO ${EQ}`);
    await client.query(`
      CREATE TYPE "BookingStatus" AS ENUM ('BOOKED','CHECKING_IN','CHECKED_IN','CHECKING_OUT','CHECKED_OUT','MOVING','CANCELLED','PENDING','PENDING_CHECKOUT');
      CREATE TYPE "ChangeType" AS ENUM ('CREATED','UPDATE','CHECKING_IN','CHECK_IN','MOVEMENT','PENDING_CHECKOUT','CHECKING_OUT','CHECK_OUT','CANCEL');
      CREATE TABLE "Booking" (id text PRIMARY KEY, "parkId" text NOT NULL, status "BookingStatus" NOT NULL, "checkIn" timestamp(3) NOT NULL, "checkOut" timestamp(3) NOT NULL,
        "checkInDate" timestamp(3) NOT NULL, "checkOutDate" timestamp(3) NOT NULL, "checkingInAt" timestamp(3), "pendingCheckoutAt" timestamp(3),
        "checkingOutAt" timestamp(3), "arrivedAtDeliveryAt" timestamp(3));
      CREATE INDEX ON "Booking" ("parkId", "checkInDate"); CREATE INDEX ON "Booking" ("parkId", "checkOutDate");
      CREATE TABLE "History" (id text PRIMARY KEY, "userId" text NOT NULL, "changeType" "ChangeType" NOT NULL, "bookingId" text NOT NULL, "actionTime" timestamp(3) NOT NULL);
    `);
    await client.query(`INSERT INTO "Booking" VALUES ${bookings.join(", ")}`);
    await client.query(`INSERT INTO "History" ("id", "userId", "changeType", "bookingId", "actionTime") VALUES ${history.join(", ")}`);
    await client.query("ANALYZE");
  }, 60_000);
  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${EQ} CASCADE`).catch(() => {});
    await client.end();
  });

  it("células, carga × entrega, tempos por condutor e escalões: iguais aos da janela inteira", async () => {
    const { combineDriverDays, combineGroupDays, driverDayPayloads, groupDayPayloads, windowDayList } = await import("./pressureDays");
    const { buildPressureDaySql, buildPressureDriverDaySql, pressureWindow, mapPressureLoadRow, mapPressureSlotRow } = await import("./multiparkDb/pressure");
    const w = pressureWindowSince(since, end);
    const bands = crewMeasureBands(DEFAULT_CREW_RULES.lisbon);
    // antes: a janela inteira de uma vez
    const oldSlots = (await q(buildPressureSlotsSql(w, parks))).map((r) => mapPressureSlotRow("g", w, r));
    const oldLoads = (await q(buildPressureLoadSql(w, parks))).map((r) => mapPressureLoadRow("g", r)).filter(Boolean);
    const oldDrivers = (await q(buildPressureDriverSlotsSql(w, parks, tl))).map(mapPressureDriverRow);
    const oldCrew = (await q(buildPressureCrewSql(w, parks, bands, tl))).map((r) => mapPressureCrewRow("g", bands, r)).filter(Boolean);
    expect(oldSlots.length).toBeGreaterThan(100);
    expect(oldCrew.length).toBeGreaterThan(1);
    // agora: um dia de cada vez (como em produção: sem nested loops nem JIT), guardado em JSON e juntado
    await client.query("SET enable_nestloop = off");
    await client.query("SET jit = off");
    const gd: Array<{ day: string; payload: any }> = [];
    const dd: Array<{ day: string; payload: any }> = [];
    for (const day of windowDayList(w)) {
      const r = pressureWindow(day, 1);
      gd.push({ day, payload: JSON.parse(JSON.stringify(groupDayPayloads(await q(buildPressureDaySql(w, r, parks)), [day]).get(day))) });
      dd.push({ day, payload: JSON.parse(JSON.stringify(driverDayPayloads(await q(buildPressureDriverDaySql(w, r, parks)), [day]).get(day))) });
    }
    await client.query("RESET enable_nestloop");
    await client.query("RESET jit");
    const g = combineGroupDays(gd);
    const d = combineDriverDays(dd, tl, bands);
    expect(g.slotRows.map((r) => mapPressureSlotRow("g", w, r))).toEqual(oldSlots);
    expect(g.loadRows.map((r) => mapPressureLoadRow("g", r)).filter(Boolean)).toEqual(oldLoads);
    expect(d.driverRows.map(mapPressureDriverRow)).toEqual(oldDrivers);
    expect(d.crewRows.map((r) => mapPressureCrewRow("g", bands, r)).filter(Boolean)).toEqual(oldCrew);
  }, 120_000);

  it("a leitura analítica do cliente (SET LOCAL sem nested loops/JIT) corre num Postgres só de leitura", async () => {
    const { multiparkDbQuery, closeMultiparkDb } = await import("./multiparkDb/client");
    const saved = process.env.DATABASE_URL_MULTIPARK;
    process.env.DATABASE_URL_MULTIPARK = URL;
    try {
      expect((await multiparkDbQuery<{ enable_nestloop: string }>("SHOW enable_nestloop", [], { analytics: true }))[0].enable_nestloop).toBe("off");
      expect((await multiparkDbQuery<{ jit: string }>("SHOW jit", [], { analytics: true }))[0].jit).toBe("off");
      expect((await multiparkDbQuery<{ enable_nestloop: string }>("SHOW enable_nestloop"))[0].enable_nestloop).toBe("on");
    } finally {
      await closeMultiparkDb();
      if (saved === undefined) delete process.env.DATABASE_URL_MULTIPARK; else process.env.DATABASE_URL_MULTIPARK = saved;
    }
  });
});
