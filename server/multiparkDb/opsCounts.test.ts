import { SCHEMA_MIGRATION_IDS } from "../migrations/index";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBookingTotalSql, buildOpsCountsSql, mapOpsCountRow, OPS_EVENTS, type OpsCountRow } from "./opsCounts";
import { buildServiceExtrasSql, buildServiceLineBookingSql, mapServiceExtraRow, serviceLineBookingId } from "./serviceExtras";
import { buildBookingsInWindowSql } from "./bookingSearch";
import { assertReadOnlySql } from "./client";
import { summarizeBookingStats, summarizeOpsActions } from "../opsStatsLive";
import { MIGRATION_0255_STATEMENTS } from "../migrations/migration_0255";

const root = join(__dirname, "..", "..");
const code = (f: string) => readFileSync(join(root, f), "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");
const parkInfo = new Map([["pA", { name: "Airpark Lisboa", city: "Lisboa" }], ["pB", { name: "Redpark", city: "Porto" }]]);

describe("contagens de reservas ao vivo (Painel e Operações)", () => {
  it("SQL só de leitura, com LIMIT; sem compras por acabar; canceladas pela data do cancelamento", () => {
    const q = buildOpsCountsSql({ events: OPS_EVENTS, start: "2026-08-31 23:00:00", end: "2026-09-30 23:00:00", parkIds: ["pA", "pB"] });
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toContain("LIMIT");
    expect(q.sql).toContain(`NOT IN ('CANCELLED', 'PENDING')`);
    expect(q.sql).toContain(`FROM "Cancellation" x`);
    expect(q.sql).toContain("AT TIME ZONE 'Europe/Lisbon'");
    expect(() => buildOpsCountsSql({ events: ["created"], start: "a", end: "b", parkIds: [] })).toThrow();
    expect(() => assertReadOnlySql(buildBookingTotalSql(["pA"]).sql)).not.toThrow();
    expect(mapOpsCountRow({ event: "checkin", day: "2026-09-01", park_id: "pA", n: "3", revenue: "10.005" })).toEqual({ event: "checkin", day: "2026-09-01", parkId: "pA", count: 3, revenue: 10.01 });
  });
  it("resumo de Operações: total, por cidade e por parque, com os nomes de sempre", () => {
    const rows: OpsCountRow[] = [
      { event: "created", day: "2026-09-01", parkId: "pA", count: 2, revenue: 100 },
      { event: "created", day: "2026-09-02", parkId: "pB", count: 1, revenue: 30 },
      { event: "cancelled", day: "2026-09-02", parkId: "pA", count: 1, revenue: 50 },
    ];
    const a = summarizeOpsActions(rows, parkInfo);
    expect(Object.keys(a).sort()).toEqual(["cancelation", "checkin", "checkout", "createdAll", "creation"]);
    expect(a.creation).toMatchObject({ count: 3, revenue: 130 });
    expect(a.creation.byCity[0]).toEqual({ name: "Lisboa", count: 2, revenue: 100 });
    expect(a.creation.byPark.map((p) => p.name)).toEqual(["Airpark Lisboa", "Redpark Porto"]);
    expect(a.cancelation.count).toBe(1);
    expect(a.checkin).toEqual({ count: 0, revenue: 0, byCity: [], byPark: [] });
  });
  it("painel: hoje, mês e período em dias de Lisboa; receita = entradas", () => {
    const rows: OpsCountRow[] = [
      { event: "created", day: "2026-09-29", parkId: "pA", count: 4, revenue: 200 },
      { event: "created", day: "2026-09-10", parkId: "pB", count: 1, revenue: 20 },
      { event: "checkin", day: "2026-09-29", parkId: "pA", count: 3, revenue: 90 },
      { event: "checkin", day: "2026-09-05", parkId: "pA", count: 2, revenue: 40 },
      { event: "checkout", day: "2026-09-29", parkId: "pB", count: 5, revenue: 0 },
      { event: "cancelled", day: "2026-08-30", parkId: "pA", count: 7, revenue: 0 },
    ];
    const s = summarizeBookingStats(rows, { total: 999, today: "2026-09-29", monthStart: "2026-09-01", periodFrom: "2026-09-01", periodTo: "2026-09-29", parkInfo });
    expect(s).toMatchObject({ total: 999, reservasHoje: 4, checkinHoje: 3, checkoutHoje: 5, canceladosHoje: 0, reservasMes: 5, checkinMes: 5, canceladosMes: 0, receitaHoje: 90, receitaMes: 130, receitaPeriodo: 130 });
    expect(s.byCity).toEqual([{ name: "Lisboa", bookings: 4, revenue: 200 }, { name: "Porto", bookings: 1, revenue: 20 }]);
    expect(s.byDay.map((d) => d.date)).toEqual(["2026-09-10", "2026-09-29"]);
    expect(s.byDay[1]).toMatchObject({ reservas: 4, checkins: 3, checkouts: 5 });
  });
});

describe("serviços extra e grupo \"Serviço\" ao vivo", () => {
  it("serviços: saída no período, sem canceladas, só leitura com LIMIT", () => {
    const q = buildServiceExtrasSql({ start: "2026-09-28 23:00:00", end: "2026-09-29 23:00:00", parkIds: ["pA"] });
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toContain(`JOIN "BookingExtraService" e`);
    expect(q.sql).toContain(`NOT IN ('CANCELLED', 'PENDING')`);
    expect(mapServiceExtraRow({ line_id: "l1", booking_id: "b1", code: "29484", price: "12.5", done: "t", park_id: "pA", client_name: "Ana" }))
      .toMatchObject({ lineId: "l1", bookingId: "b1", bookingNumber: "29484", price: 12.5, done: true, clientName: "Ana" });
  });
  it("reserva de uma linha de serviço (para o \"Feito\"): só leitura, parametrizado, LIMIT 1", async () => {
    const q = buildServiceLineBookingSql("l1'; DROP");
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toBe(`SELECT e."bookingId" AS booking_id FROM "BookingExtraService" e WHERE e."id" = $1 LIMIT 1`);
    expect(q.params).toEqual(["l1'; DROP"]);
    expect(await serviceLineBookingId("l1", async () => [{ booking_id: "b1" }] as any)).toBe("b1");
    expect(await serviceLineBookingId("l1", async () => [])).toBeNull();
  });
  it("feito guardado cá por linha (migração 0255); os feitos antigos passam uma vez", () => {
    const all = MIGRATION_0255_STATEMENTS.join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS `service_extra_done`");
    expect(all).toContain("UNIQUE KEY `uq_service_extra_done_line` (`lineId`)");
    expect(all).toContain("INSERT IGNORE INTO `service_extra_done`");
    expect(all).not.toMatch(/DROP|DELETE/i);
    expect(SCHEMA_MIGRATION_IDS).toContain("0255");
  });
  it("grupo Serviço: entradas/saídas da janela com telefone, nas cidades dadas", () => {
    const q = buildBookingsInWindowSql({ start: "2026-09-29 00:00:00", end: "2026-09-30 00:00:00", ourParkIds: ["pA"], cities: ["lisboa", "lisbon"] });
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toContain(`NULLIF(c."phoneNumber", '') IS NOT NULL`);
    expect(q.params).toEqual(expect.arrayContaining(["lisboa", "lisbon", 3000]));
  });
});

describe("a cópia deixa de ser lida no Painel, Operações, Serviços, MCP e Google", () => {
  it("leitores passados para ao vivo e releitura pela API desligada", () => {
    for (const f of ["server/opsStatsLive.ts", "server/google/contactsService.ts"]) {
      expect(code(f), f).not.toMatch(/multipark_bookings|multiparkBookings/);
    }
    // MCP: só fica o registo da ação de administração da cópia (backfill-projects)
    expect(code("server/mcpApi.ts")).not.toMatch(/\bmultiparkBookings\b|FROM multipark_bookings/);
    const db = code("server/db.ts");
    for (const fn of ["getOperationsSummary", "getMultiparkBookingStats"]) {
      const i = db.indexOf(`export async function ${fn}(`);
      expect(db.slice(i, db.indexOf("\n}\n", i)), fn).not.toMatch(/multiparkBookings/);
    }
    expect(db).not.toContain("export async function getMultiparkBookings(");
    const r = code("server/routers.ts");
    const svc = r.slice(r.indexOf("multiparkExtras: protectedProcedure"), r.indexOf("// ─── FATURAÇÃO"));
    expect(svc).toContain("readServiceExtras");
    expect(svc).not.toMatch(/multiparkBookings/);
    expect(r).not.toContain("bookingByExternalId:");
    expect(code("server/cronJobs.ts")).not.toContain("enrichBookingsBatch");
    // a cópia continua a ser gravada quando chega um webhook
    expect(code("server/multiparkWebhook.ts")).toContain("upsertMultiparkBooking");
  });
});
