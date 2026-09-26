import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  assertReadOnlySql, describeMultiparkDbTest, detectEngine, isMultiparkDbConfigured, MultiparkDbError, placeholder, redactSecrets, sslFromUrl,
  type MultiparkDbClient, type MultiparkDbEngine,
} from "./client";
import { loadSchemaSnapshot, renderSchemaMarkdown, type SchemaSnapshot } from "./schemaDoc";
import {
  BOOKING_QUERY, DRIVER_QUERY, MOVEMENT_QUERY, MULTIPARK_DB_MAPPED,
  bookingsByPeriodSql, byColumnSql, byIdSql, changedSinceSql, driversSql,
  mapBookingRow, mapDriverRow, mapMovementRow, toApiDate, toMysqlUtc,
  type BookingRow, type MovementRow,
} from "./queries";
import {
  apiHistoryToMovement, createApiSource, createDbSource, dbSourceReadiness, effectiveMultiparkSource, getMultiparkSourceKind, initialCursor, requestedMultiparkSource,
  MultiparkDbNotMappedError, MultiparkSourceUnsupportedError, resolveMultiparkSource,
} from "./source";
import { summarizeMovements } from "./dbSync";
import { parseBookingDate } from "../bookingRefresh";
import {
  AUTOMATION_FLAGS, CRON_JOBS, automationFlagDefault, automationFlagSuperAdminOnly, cronJobsForSource, normalizeFlagEnv,
} from "../../shared/appSettings";
import { TICK_JOBS, activeTickJobs } from "../cronSchedule";
import { integrationTestSuperAdminOnly } from "../integrationsStatus";
import { MIGRATION_0205_STATEMENTS } from "../migrations/migration_0205";

const PG_URL = "postgresql://ro_user:S3cr3t%21pw@db.multipark.example:5432/multipark?sslmode=require";

describe("URL: motor, SSL e redação", () => {
  it("deteta o motor pelo esquema", () => {
    expect(detectEngine("postgres://u:p@h/db")).toBe("postgres");
    expect(detectEngine("postgresql://u:p@h/db")).toBe("postgres");
    expect(detectEngine("mysql://u:p@h:3306/db")).toBe("mysql");
    expect(detectEngine("MARIADB://u:p@h/db")).toBe("mysql");
    expect(() => detectEngine("mongodb://u:p@h/db")).toThrow(/não suportado/);
    expect(() => detectEngine("")).toThrow(MultiparkDbError);
  });
  it("a mensagem de erro de um esquema errado não traz credenciais", () => {
    try { detectEngine("sqlserver://sa:SuperSecreta@h/db"); } catch (e: any) { expect(e.message).not.toContain("SuperSecreta"); }
  });
  it("tira URL, palavra-passe, utilizador e anfitrião das mensagens", () => {
    const msg = `falhou ${PG_URL} · password authentication failed for user "ro_user" at db.multipark.example (S3cr3t!pw)`;
    const out = redactSecrets(msg, PG_URL);
    expect(out).not.toContain("S3cr3t");
    expect(out).not.toContain("ro_user");
    expect(out).not.toContain("db.multipark.example");
    expect(out).toContain("<DATABASE_URL_MULTIPARK>");
    expect(redactSecrets("ver mysql://a:b@outra-bd:3306/x", null)).toBe("ver <url-bd>");
    expect(redactSecrets(new Error("boom"), null)).toBe("boom");
  });
  it("SSL como o URL pede (e o URL limpo não leva sslmode)", () => {
    expect(sslFromUrl(PG_URL)).toMatchObject({ ssl: { rejectUnauthorized: false } });
    expect(sslFromUrl(PG_URL).url).not.toContain("sslmode");
    expect(sslFromUrl("postgres://u:p@h/db?sslmode=verify-full").ssl).toEqual({ rejectUnauthorized: true });
    expect(sslFromUrl("postgres://u:p@h/db?sslmode=disable").ssl).toBe(false);
    expect(sslFromUrl("mysql://u:p@h/db?ssl-mode=REQUIRED").ssl).toEqual({ rejectUnauthorized: false });
    expect(sslFromUrl("postgres://u:p@localhost/db").ssl).toBe(false);
    expect(sslFromUrl("postgres://u:p@postgres.railway.internal/db").ssl).toBe(false);
    expect(sslFromUrl("postgres://u:p@h.example.com/db").ssl).toEqual({ rejectUnauthorized: false });
    expect(sslFromUrl("postgres://u:p@h.example.com/db?sslmode=require", "verify").ssl).toEqual({ rejectUnauthorized: true });
    expect(sslFromUrl("postgres://u:p@h.example.com/db", "off").ssl).toBe(false);
  });
  it("configurada só com a env", () => {
    expect(isMultiparkDbConfigured({})).toBe(false);
    expect(isMultiparkDbConfigured({ DATABASE_URL_MULTIPARK: " " })).toBe(false);
    expect(isMultiparkDbConfigured({ DATABASE_URL_MULTIPARK: PG_URL })).toBe(true);
    expect(placeholder("postgres", 2)).toBe("$2");
    expect(placeholder("mysql", 2)).toBe("?");
  });
});

describe("guarda só de leitura", () => {
  const ok = [
    "SELECT 1",
    "  select * from bookings where id = $1;",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "SHOW server_version",
    "EXPLAIN SELECT * FROM t",
    "-- comentário\nSELECT 1",
    "/* bloco */ SELECT 'delete from x; drop table y' AS texto",
    `SELECT "updatedAt", "createdAt" FROM "Booking" WHERE "status" = 'CANCELLED'`,
    "SELECT to_char(x, 'YYYY-MM-DD HH24:MI:SS.US') FROM t",
  ];
  for (const q of ok) it(`aceita: ${q.replace(/\s+/g, " ").slice(0, 50)}`, () => expect(() => assertReadOnlySql(q)).not.toThrow());

  const bad = [
    "INSERT INTO t VALUES (1)",
    "update t set a = 1",
    "DELETE FROM t",
    "DROP TABLE t",
    "TRUNCATE t",
    "ALTER TABLE t ADD c int",
    "CREATE TABLE t (a int)",
    "GRANT ALL ON t TO x",
    "SELECT 1; DELETE FROM t",
    "SELECT 1; SELECT 2",
    "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
    "SELECT * FROM t FOR UPDATE",
    "SELECT * FROM t FOR NO KEY UPDATE",
    "SELECT * FROM t FOR SHARE",
    "SELECT * INTO novo FROM t",
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    "EXPLAIN ANALYZE SELECT 1",
    "SELECT 'a--b'; DROP TABLE t",
    "SELECT 1--1\n; DROP TABLE t",
    "SELECT 'it''s'; DELETE FROM t",
    "SELECT '\\'; DROP TABLE t; --'",
    "SELECT $$x$$",
    "SELECT /*! DROP TABLE t */ 1",
    "SELECT nextval('s')",
    "SELECT set_config('a', 'b', false)",
    "SELECT pg_terminate_backend(1)",
    "SET ROLE admin",
    "BEGIN",
    "COMMIT",
    "CALL p()",
    "",
    "   ",
  ];
  for (const q of bad) {
    it(`recusa: ${JSON.stringify(q).slice(0, 50)}`, () => {
      expect(() => assertReadOnlySql(q)).toThrow(MultiparkDbError);
      try { assertReadOnlySql(q); } catch (e: any) { expect(e.code).toBe("NOT_READ_ONLY"); }
    });
  }
});

/** Cliente falso: passa cada consulta pela guarda e devolve linhas de catálogo vazias. */
function fakeClient(engine: MultiparkDbEngine, seen: string[] = [], rows: (sql: string) => any[] = () => []): MultiparkDbClient {
  return {
    engine,
    async query(sql: string) { assertReadOnlySql(sql); seen.push(sql); return rows(sql) as any; },
    async readOnlyCheck() { return true; },
    async close() {},
  };
}

describe("ferramenta do esquema (só estrutura)", () => {
  it("todas as consultas de catálogo passam na guarda (Postgres e MySQL)", async () => {
    for (const engine of ["postgres", "mysql"] as const) {
      const seen: string[] = [];
      const snap = await loadSchemaSnapshot(fakeClient(engine, seen));
      expect(seen.length).toBeGreaterThanOrEqual(5);
      expect(snap.engine).toBe(engine);
      // Nunca lê tabelas de dados: só catálogos do motor.
      for (const q of seen) expect(q).toMatch(/pg_|information_schema|current_setting|VERSION\(\)/i);
    }
  });
  it("junta colunas, chaves, índices e enums (Postgres)", async () => {
    const snap = await loadSchemaSnapshot(fakeClient("postgres", [], (sql) => {
      if (sql.includes("server_version")) return [{ v: "16.2" }];
      if (sql.includes("reltuples")) return [{ s: "public", t: "Booking", rows: 1234.4 }];
      if (sql.includes("format_type")) return [{ s: "public", t: "Booking", col: "id", type: "text", nullable: false, def: null, note: null }, { s: "public", t: "Booking", col: "status", type: '"BookingStatus"', nullable: true, def: null, note: null }];
      if (sql.includes("pg_constraint")) return [{ s: "public", t: "Booking", name: "Booking_pkey", kind: "p", cols: "{id}", rs: null, rt: null, rcols: "{}" }, { s: "public", t: "Booking", name: "Booking_parkId_fkey", kind: "f", cols: ["parkId"], rs: "public", rt: "Park", rcols: ["id"] }];
      if (sql.includes("pg_index")) return [{ s: "public", t: "Booking", name: "Booking_updatedAt_idx", uniq: false, prim: false, cols: ["\"updatedAt\""] }];
      if (sql.includes("pg_enum")) return [{ s: "public", name: "BookingStatus", label: "BOOKED" }, { s: "public", name: "BookingStatus", label: "CHECKED_IN" }];
      return [];
    }));
    expect(snap.version).toBe("16.2");
    const t = snap.tables[0];
    expect(t).toMatchObject({ name: "Booking", approxRows: 1234, primaryKey: ["id"] });
    expect(t.foreignKeys[0]).toMatchObject({ columns: ["parkId"], refTable: "Park", refColumns: ["id"] });
    expect(snap.enums[0].values).toEqual(["BOOKED", "CHECKED_IN"]);
    const md = renderSchemaMarkdown(snap);
    expect(md).toContain("## Booking");
    expect(md).toContain("BOOKED");
    expect(md).toContain("parkId → Park(id)");
    expect(md).toContain("Sem dados");
  });
  it("o markdown só tem estrutura (nada de linhas)", () => {
    const snap: SchemaSnapshot = { engine: "mysql", version: "8.0", generatedAt: "2026-09-26T00:00:00Z", enums: [], tables: [{ schema: "mp", name: "bookings", approxRows: null, columns: [{ name: "email", type: "varchar(320)", nullable: true, defaultValue: null, comment: "email | do cliente" }], primaryKey: [], foreignKeys: [], indexes: [] }] };
    const md = renderSchemaMarkdown(snap);
    expect(md).toContain("| email | `varchar(320)` | sim |");
    expect(md).toContain("email \\| do cliente");
    expect(md).toContain("MySQL 8.0");
  });
  it("resumo do teste de ligação: só ligado, motor+versão, só leitura, latência, n.º de tabelas", () => {
    expect(describeMultiparkDbTest({ connected: true, engine: "postgres", version: "16.2", readOnly: true, latencyMs: 42, tables: 37 }))
      .toBe("Ligado · PostgreSQL 16.2 · só leitura confirmada · 42 ms · 37 tabela(s)");
    expect(describeMultiparkDbTest({ connected: true, engine: "mysql", version: "8.0", readOnly: false, latencyMs: 5, tables: 1 })).toContain("NÃO ficou só de leitura");
    expect(describeMultiparkDbTest({ connected: false, engine: null, version: null, readOnly: false, latencyMs: 5, tables: null, error: "timeout" })).toBe("Sem ligação: timeout");
  });
});

describe("consultas (queries.ts): SQL gerado", () => {
  const since = { at: "2026-09-26 10:00:00.123456", id: "bk_1" };
  it("cursor inicial (sem id): só a data, inclusive", () => {
    const q = changedSinceSql("postgres", BOOKING_QUERY, { at: "2026-09-23 12:00:00.000000", id: "" }, 50);
    expect(q.params).toEqual(["2026-09-23 12:00:00.000000"]);
    expect(q.sql).toContain(">= $1");
    expect(q.sql).not.toContain("$2");
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
  });
  it("incremental por (updatedAt, id), com os parâmetros certos por motor", () => {
    const pg = changedSinceSql("postgres", BOOKING_QUERY, since, 200);
    expect(pg.params).toEqual([since.at, since.id]);
    expect(pg.sql).toContain("$1");
    expect(pg.sql).toContain("to_char(");
    expect(pg.sql).toMatch(/LIMIT 200$/);
    const my = changedSinceSql("mysql", MOVEMENT_QUERY, since, 5000);
    expect(my.params).toEqual([since.at, since.at, since.id]);
    expect(my.sql).toContain("DATE_FORMAT(");
    expect(my.sql).toMatch(/LIMIT 1000$/);
  });
  it("todas as consultas geradas passam na guarda", () => {
    for (const engine of ["postgres", "mysql"] as const) {
      for (const q of [
        changedSinceSql(engine, BOOKING_QUERY, since, 10), changedSinceSql(engine, MOVEMENT_QUERY, since, 10),
        byIdSql(engine, BOOKING_QUERY, BOOKING_QUERY.cursorId, "x"), byColumnSql(engine, MOVEMENT_QUERY, "h.TODO_bookingId", "x"),
        bookingsByPeriodSql(engine, "2026-09-01", "2026-09-30", "checkin"), driversSql(),
      ]) expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    }
  });
  it("período inclusivo (até ao dia seguinte exclusivo)", () => {
    expect(bookingsByPeriodSql("postgres", "2026-09-01", "2026-09-30", "creation").params).toEqual(["2026-09-01 00:00:00", "2026-10-01 00:00:00"]);
  });
  it("cada alias tem expressão definida (ou null explícito)", () => {
    for (const q of [BOOKING_QUERY, MOVEMENT_QUERY, DRIVER_QUERY]) {
      for (const v of Object.values(q.columns)) expect(v === null || typeof v === "string").toBe(true);
    }
  });
});

// Linhas-exemplo com os ALIASES dos marcadores (o que a consulta devolve depois de mapeada).
const BOOKING_FIXTURE: BookingRow = {
  id: "cm0abc123", booking_number: "AP-10001", status: "CHECKED_IN",
  check_in: new Date("2026-07-10T08:30:00Z"), check_out: "2026-07-17 21:15:00", check_in_time: null, check_out_time: null,
  created_at: new Date("2026-07-01T12:00:00Z"), updated_at: new Date("2026-07-10T08:31:02.500Z"), cancelled_at: null, cancel_reason: null,
  park_id: "park_lis_air", park_name: "Airpark", park_city: "Lisboa", parking_type: "COVERED", vehicle_type: "CAR",
  client_first_name: "Ana", client_last_name: "Silva", client_email: "ana@example.com", client_phone: "+351900000000", client_nif: "123456789",
  license_plate: "AA00BB", vehicle_brand: "Renault", vehicle_model: "Clio", vehicle_color: "Branco",
  currency: null, total_price: "49.90", parking_price: 39.9, delivery_charges: "10.00", extras_total: 0, discount: null, remaining_to_pay: "0", total_paid: "49.90", payment_method: "MBWAY",
  delivery_service: 1, delivery_type: "VALET", delivery_address: "Terminal 1", pickup_address: null,
  arrival_flight: "TP1234", departure_flight: null, return_flight: "TP1235", departing_flight: null,
  remarks: "Cadeira de bebé", notes: null, origin: "website", origin_url: "https://airpark.pt/?gclid=abc",
  partner_id: "partner_77", partner_name: "Unknown User", campaign_id: "cmp_1", campaign_name: "Verão", discount_code: "VERAO10", pro: "f", allocation: "10123",
  cash_validated_by_name: null, driver_validated_by_name: "Rui", cashier_closed_by_name: null,
  extra_services: '[{"id":"x1","name":"Lavagem","price":15,"done":false}]',
  cursor_at: "2026-07-10 08:31:02.500000",
};

describe("mapeamento (queries.ts) com linhas-exemplo", () => {
  it("reserva → formato da API (/bookings/:id)", () => {
    const { booking, cursor } = mapBookingRow(BOOKING_FIXTURE, "utc");
    expect(cursor).toEqual({ at: "2026-07-10 08:31:02.500000", id: "cm0abc123" });
    expect(booking).toMatchObject({
      id: "cm0abc123", bookingNumber: "AP-10001", status: "CHECKED_IN",
      checkIn: "2026-07-10T08:30:00.000Z", checkOut: "2026-07-17T21:15:00.000Z", checkInTime: "08:30", checkOutTime: "21:15",
      park: { id: "park_lis_air", name: "Airpark", city: "Lisboa" }, parkName: "Airpark", parkingType: "COVERED",
      client: { firstName: "Ana", lastName: "Silva", email: "ana@example.com", phoneNumber: "+351900000000", nif: "123456789" },
      vehicle: { licensePlate: "AA00BB", brand: "Renault", model: "Clio", color: "Branco", type: "CAR", vehicleType: "CAR" },
      pricing: { currency: "EUR", totalPrice: 49.9, parkingPrice: 39.9, deliveryCharges: 10, extraServicesTotal: 0, remainingToPay: 0, totalPaid: 49.9, paymentMethod: "MBWAY" },
      deliveryService: true, deliveryType: "VALET", flightInfo: { arrivalFlight: "TP1234" }, returnFlight: "TP1235",
      remarks: "Cadeira de bebé", origin: "website", originUrl: "https://airpark.pt/?gclid=abc",
      partnerId: "partner_77", campaignId: "cmp_1", campaignName: "Verão", discountCode: "VERAO10", pro: false, allocation: "10123",
      driverValidatedByName: "Rui",
    });
    expect(booking.extraServices).toEqual([{ id: "x1", name: "Lavagem", price: 15, done: false }]);
    expect("discount" in (booking.pricing ?? {})).toBe(false); // null não vira 0
    expect("cancelledAt" in booking).toBe(false);
    // O bookingToRecord/bookingDetailCore lê estas datas com o parseBookingDate:
    expect(parseBookingDate(booking.checkIn)).toBe("2026-07-10 08:30:00");
    expect(parseBookingDate(booking.updatedAt)).toBe("2026-07-10 08:31:02");
  });
  it("DATE_MODE lisbon_wallclock: hora de Lisboa escrita como no report da API", () => {
    const { booking } = mapBookingRow(BOOKING_FIXTURE, "lisbon_wallclock");
    expect(booking.checkIn).toBe("2026-07-10 09:30:00"); // verão: UTC+1
    expect(booking.checkInTime).toBe("09:30");
    expect(parseBookingDate(booking.checkIn)).toBe("2026-07-10 09:30:00");
    expect(toApiDate(new Date("2026-01-10T08:30:00Z"), "lisbon_wallclock")).toBe("2026-01-10 08:30:00"); // inverno: UTC
  });
  it("reserva sem id → erro (nunca grava uma linha sem chave)", () => {
    expect(() => mapBookingRow({ ...BOOKING_FIXTURE, id: null })).toThrow();
  });
  it("movimento → linha do histórico", () => {
    const row: MovementRow = {
      id: "h_1", booking_id: "cm0abc123", change_type: "CHECK_IN", action_time: new Date("2026-07-10T08:30:05Z"),
      agent_user_id: "u_9", agent_name: null, agent_first_name: "Rui", agent_last_name: "Costa", agent_email: "Rui@Multipark.pt",
      remarks: null, modified_fields: { garagem: "G2", lugar: "114", km: "45210" }, platform: "PDA", cursor_at: "2026-07-10 08:30:05.000000",
    };
    const { movement, cursor } = mapMovementRow(row);
    expect(movement).toEqual({
      id: "h_1", bookingId: "cm0abc123", changeType: "CHECK_IN", actionTime: "2026-07-10 08:30:05",
      agentUserId: "u_9", agentName: "Rui Costa", agentEmail: "rui@multipark.pt", remarks: null,
      modifiedFields: '{"garagem":"G2","lugar":"114","km":"45210"}', platform: "PDA",
    });
    expect(cursor).toEqual({ at: "2026-07-10 08:30:05.000000", id: "h_1" });
    expect(() => mapMovementRow({ id: "h_2" })).toThrow();
  });
  it("condutor → multipark_agents (sem telefone)", () => {
    expect(mapDriverRow({ id: 42, first_name: "Rui", last_name: "Costa", email: " RUI@multipark.pt ", role: "DRIVER", active: "t", updated_at: "2026-07-01 10:00:00" }))
      .toEqual({ id: "42", name: "Rui Costa", email: "rui@multipark.pt", role: "DRIVER", active: true, parkId: null, city: null, updatedAt: "2026-07-01 10:00:00" });
    expect(mapDriverRow({ id: "u", full_name: "Equipa Faro", active: 0 })).toMatchObject({ name: "Equipa Faro", active: false });
  });
  it("datas: texto sem fuso é UTC; lixo → null", () => {
    expect(toMysqlUtc("2026-07-10 08:30:00")).toBe("2026-07-10 08:30:00");
    expect(toMysqlUtc("2026-07-10")).toBe("2026-07-10 00:00:00");
    expect(toMysqlUtc("não é data")).toBeNull();
    expect(toMysqlUtc(null)).toBeNull();
  });
  it("resumo dos movimentos: último check-in/out e garagem/lugar/km (como o histórico da API)", () => {
    const base = { bookingId: "b", remarks: null, platform: null, agentEmail: null };
    const s = summarizeMovements([
      { ...base, id: "3", changeType: "CHECK_OUT", actionTime: "2026-07-17 21:00:00", agentUserId: "u2", agentName: "Bia", modifiedFields: '{"km": "45300"}' },
      { ...base, id: "1", changeType: "CHECK_IN", actionTime: "2026-07-10 08:30:00", agentUserId: "u1", agentName: "Rui", modifiedFields: '{"garagem":"G2","lugar":"114","km":"45210"}' },
      { ...base, id: "2", changeType: "MOVEMENT", actionTime: "2026-07-11 10:00:00", agentUserId: "u3", agentName: "Zé", modifiedFields: "não-json" },
    ]);
    expect(s).toEqual({ checkinAgentName: "Rui", checkinAgentUserId: "u1", checkoutAgentName: "Bia", checkoutAgentUserId: "u2", currentGarage: "G2", currentSpot: "114", lastKnownMileage: 45300 });
    expect(summarizeMovements([])).toEqual({});
  });
});

describe("fontes (source.ts)", () => {
  it("DbSource recusa-se a correr enquanto estiver por mapear", async () => {
    expect(MULTIPARK_DB_MAPPED).toEqual({ bookings: false, movements: false, drivers: false });
    let calls = 0;
    const src = createDbSource(async () => { calls++; return fakeClient("postgres"); });
    await expect(src.listBookingsChangedSince({ at: "2026-01-01 00:00:00", id: "" }, 10)).rejects.toThrow(MultiparkDbNotMappedError);
    await expect(src.listMovements({ at: "2026-01-01 00:00:00", id: "" }, 10)).rejects.toThrow(/por mapear/);
    await expect(src.listDrivers()).rejects.toThrow(/por mapear/);
    await expect(src.getBooking("x")).rejects.toThrow(/por mapear/);
    await expect(src.listBookingsByPeriod("2026-01-01", "2026-01-02", "creation")).rejects.toThrow(/por mapear/);
    expect(calls).toBe(0); // nem sequer abre a ligação
  });
  it("ApiSource: o que a API não tem lança SOURCE_UNSUPPORTED", async () => {
    const api = createApiSource();
    expect(api.kind).toBe("api");
    await expect(api.listBookingsChangedSince({ at: "", id: "" }, 1)).rejects.toThrow(MultiparkSourceUnsupportedError);
    await expect(api.listMovements({ at: "", id: "" }, 1)).rejects.toThrow(MultiparkSourceUnsupportedError);
    await expect(api.listDrivers()).rejects.toThrow(MultiparkSourceUnsupportedError);
  });
  it("histórico da API → movimento (mesmo formato do DbSource)", () => {
    expect(apiHistoryToMovement("b1", { id: "h1", changeType: "CHECK_OUT", actionTime: "17/07/2026, 21:00", agentName: "Bia", userId: "u2", user: { id: "u2", firstName: "B", lastName: "C", email: "Bia@X.pt" }, modifiedFields: '{"km":1}', platform: "PDA" }))
      .toEqual({ id: "h1", bookingId: "b1", changeType: "CHECK_OUT", actionTime: "2026-07-17 21:00:00", agentUserId: "u2", agentName: "Bia", agentEmail: "bia@x.pt", remarks: null, modifiedFields: '{"km":1}', platform: "PDA" });
    expect(apiHistoryToMovement("b1", {} as any)).toBeNull();
  });
  it("cursor inicial: N dias para trás, texto UTC com µs", () => {
    expect(initialCursor(Date.parse("2026-09-26T12:00:00Z"), 3)).toEqual({ at: "2026-09-23 12:00:00.000000", id: "" });
  });
});

describe("interruptor MULTIPARK_SOURCE (omissão = API → nada muda em produção)", () => {
  it("omissão: api", async () => {
    expect(resolveMultiparkSource(undefined, null)).toBe("api");
    expect(resolveMultiparkSource("", undefined)).toBe("api");
    expect(resolveMultiparkSource("qualquer", null)).toBe("api");
    expect(await getMultiparkSourceKind({})).toBe("api");
    expect(automationFlagDefault("MULTIPARK_SOURCE")).toBe(false);
  });
  it("env db/api e sobreposição das Definições (que ganha)", async () => {
    expect(resolveMultiparkSource("db", null)).toBe("db");
    expect(resolveMultiparkSource("DB", null)).toBe("db");
    expect(resolveMultiparkSource("on", null)).toBe("db");
    expect(resolveMultiparkSource("api", null)).toBe("api");
    expect(resolveMultiparkSource("db", false)).toBe("api");
    expect(resolveMultiparkSource("api", true)).toBe("db");
    expect(await requestedMultiparkSource({ MULTIPARK_SOURCE: "db" })).toBe("db");
    expect(await requestedMultiparkSource({ MULTIPARK_SOURCE: "api" })).toBe("api");
  });
  it("pedir a BD sem env ou por mapear continua na API (nunca desliga o sync sem substituto)", async () => {
    expect(await getMultiparkSourceKind({ MULTIPARK_SOURCE: "db" })).toBe("api");
    expect(await getMultiparkSourceKind({ MULTIPARK_SOURCE: "db", DATABASE_URL_MULTIPARK: PG_URL })).toBe("api"); // ainda por mapear
    expect(dbSourceReadiness({})).toMatch(/DATABASE_URL_MULTIPARK/);
    expect(dbSourceReadiness({ DATABASE_URL_MULTIPARK: PG_URL })).toMatch(/por mapear/);
    expect(dbSourceReadiness({ DATABASE_URL_MULTIPARK: PG_URL }, { bookings: true, movements: true })).toBeNull();
    expect(effectiveMultiparkSource("db", null)).toEqual({ source: "db", reason: null });
    expect(effectiveMultiparkSource("db", "x")).toMatchObject({ source: "api" });
    expect(effectiveMultiparkSource("api", null)).toEqual({ source: "api", reason: null });
  });
  it("no catálogo das automações: desligado por omissão e só super_admin", () => {
    const f = AUTOMATION_FLAGS.find((x) => x.name === "MULTIPARK_SOURCE");
    expect(f).toMatchObject({ defaultEnabled: false, superAdminOnly: true });
    expect(automationFlagSuperAdminOnly("MULTIPARK_SOURCE")).toBe(true);
    expect(automationFlagSuperAdminOnly("EXTRAS_AUTOMATION")).toBe(false);
    expect(normalizeFlagEnv("MULTIPARK_SOURCE", "db")).toBe("on");
    expect(normalizeFlagEnv("MULTIPARK_SOURCE", "api")).toBe("off");
    expect(normalizeFlagEnv("EXTRAS_AUTOMATION", "db")).toBe("db");
    expect(normalizeFlagEnv("MULTIPARK_SOURCE", undefined)).toBeUndefined();
  });
  it("agendador com a fonte = API: exatamente os trabalhos de antes", () => {
    const before = ["mail-sync", "multipark-deliveries", "ai-comms", "google-pending", "google-sync", "extras-schedule", "multipark-sync", "extras-auto", "identity-sweep", "multipark-future", "zello-sameday", "google-watch-renew", "daily-ops", "rh-docs-weekly", "ops-briefing", "evaluation-recompute", "google-ads", "google-ads-monthly", "meta-ads", "meta-ads-monthly", "web-analytics"];
    expect(activeTickJobs(TICK_JOBS, "api").map((j) => j.key)).toEqual(before);
    const db = activeTickJobs(TICK_JOBS, "db").map((j) => j.key);
    expect(db).toContain("multipark-db-sync");
    expect(db).toContain("multipark-deliveries"); // a fila do webhook fica até o Jorge a desligar
    expect(db).not.toContain("multipark-sync");
    expect(db).not.toContain("multipark-future");
    const spec = TICK_JOBS.find((j) => j.key === "multipark-db-sync")!;
    expect(spec.cadence).toEqual({ kind: "interval", minutes: 5 });
    expect(spec.maxMs).toBeLessThan(50_000);
  });
  it("Estado do sistema: com a API, a lista de crons é a mesma", () => {
    expect(cronJobsForSource("api")).toBe(CRON_JOBS);
    const db = cronJobsForSource("db");
    expect(db.find((j) => j.name === "multipark-db-sync")?.intervalMinutes).toBe(5);
    expect(db.find((j) => j.name === "multipark-sync")?.intervalMinutes).toBeNull();
    expect(CRON_JOBS.find((j) => j.name === "multipark-db-sync")?.intervalMinutes).toBeNull();
  });
  it("teste de ligação só para super_admin", () => {
    expect(integrationTestSuperAdminOnly("multipark_db")).toBe(true);
    expect(integrationTestSuperAdminOnly("database")).toBe(false);
  });
});

describe("migração 0205", () => {
  it("idempotente e registada no fim do ensureRecentSchema", () => {
    for (const s of MIGRATION_0205_STATEMENTS) expect(s).toMatch(/^CREATE TABLE IF NOT EXISTS `multipark_(agents|db_cursors)`/);
    const dbTs = fs.readFileSync(path.join(__dirname, "..", "db.ts"), "utf8");
    const i205 = dbTs.indexOf("migration_0205");
    expect(i205).toBeGreaterThan(dbTs.indexOf("migration_0200"));
  });
});
