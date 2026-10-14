/**
 * Plano 62, P6 — migração 0685 (`service_times`): só cria, idempotente, a
 * mesma tabela do drizzle/schema.ts, registada no fim da lista por ordem.
 */
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { IDEMPOTENT_ERROR_CODES_0685, MIGRATION_0685_STATEMENTS } from "./migrations/migration_0685";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { serviceTimes } from "../drizzle/schema";

describe("migração 0685 — service_times", () => {
  it("CREATE TABLE IF NOT EXISTS, idempotente, sem DROP/DELETE/ALTER de dados", () => {
    expect(MIGRATION_0685_STATEMENTS).toHaveLength(1);
    const sql = MIGRATION_0685_STATEMENTS[0];
    expect(sql.startsWith("CREATE TABLE IF NOT EXISTS `service_times` (")).toBe(true);
    expect(sql).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|ALTER)\b/i);
    expect([...IDEMPOTENT_ERROR_CODES_0685]).toEqual(["ER_TABLE_EXISTS_ERROR"]);
    expect(sql).toContain("UNIQUE KEY `uq_service_times_cycle` (`kind`, `bookingId`, `anchorHistoryId`)");
    expect(sql).toContain("KEY `idx_service_times_day_city` (`kind`, `opDay`, `cityKey`)");
    expect(sql).toContain("KEY `idx_service_times_driver_day` (`startEmployeeId`, `opDay`)");
  });

  it("Q7: cada tempo guarda o seu condutor, com índice (condutor, dia) para as médias por período", () => {
    const sql = MIGRATION_0685_STATEMENTS[0];
    for (const col of ["startEmployeeId", "deliverEmployeeId", "driverEmployeeId", "checkInEmployeeId", "p2EmployeeId", "parkedEmployeeId"]) {
      expect(sql, col).toContain(`\`${col}\` INT NULL`);
      expect(sql, col).toContain("` (`" + col + "`, `opDay`)");
    }
  });

  it("nunca coordenadas nem telefones (privacidade)", () => {
    expect(MIGRATION_0685_STATEMENTS[0]).not.toMatch(/`(lat|lng|lon|latitude|longitude|phone[A-Za-z]*|email|clientName)`/i);
  });

  it("as colunas da migração = as do drizzle/schema.ts", () => {
    const fromSql = [...MIGRATION_0685_STATEMENTS[0].matchAll(/`([A-Za-z0-9]+)` (?:INT|VARCHAR|DATETIME|DATE|TINYINT|CHAR)/g)].map((m) => m[1]).sort();
    const fromDrizzle = getTableConfig(serviceTimes).columns.map((c) => c.name).sort();
    expect(fromSql).toEqual(fromDrizzle);
    const idx = getTableConfig(serviceTimes).indexes.map((i) => i.config.name).sort();
    expect(idx).toEqual([
      "idx_service_times_anchor", "idx_service_times_checkin_day", "idx_service_times_day_city", "idx_service_times_deliver_day", "idx_service_times_driver_day",
      "idx_service_times_p2_day", "idx_service_times_parked_day", "idx_service_times_pickup_driver_day", "uq_service_times_cycle",
    ]);
  });

  it("registada no fim, por ordem crescente (quem juntar com a 0680 resolve por ordem)", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0685");
    expect([...SCHEMA_MIGRATION_IDS].sort()).toEqual([...SCHEMA_MIGRATION_IDS]);
    expect(SCHEMA_MIGRATION_IDS[SCHEMA_MIGRATION_IDS.length - 1] >= "0685").toBe(true);
  });
});
