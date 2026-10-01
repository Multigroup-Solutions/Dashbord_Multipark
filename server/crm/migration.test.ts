import { SCHEMA_MIGRATION_IDS } from "../migrations/index";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { IDEMPOTENT_ERROR_CODES_0215, MIGRATION_0215_STATEMENTS, runMigration0215Collation } from "../migrations/migration_0215";
import { MIGRATION_0220_STATEMENTS } from "../migrations/migration_0220";

describe("migração 0215 (CRM)", () => {
  const all = MIGRATION_0215_STATEMENTS.join("\n");
  it("sem collation explícita: igual à de multipark_bookings (ligações por externalId)", () => {
    expect(all).not.toMatch(/COLLATE/i);
    expect(all).not.toMatch(/CHARSET/i);
  });
  it("só cria (nada de DROP/DELETE) e é idempotente", () => {
    expect(all).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
    for (const s of MIGRATION_0215_STATEMENTS) {
      expect(/^(CREATE TABLE IF NOT EXISTS|ALTER TABLE `multipark_bookings` ADD INDEX|ALTER TABLE `crm_\w+` ADD (COLUMN|INDEX))/.test(s)).toBe(true);
    }
    expect(IDEMPOTENT_ERROR_CODES_0215.has("ER_DUP_KEYNAME")).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0215.has("ER_DUP_FIELDNAME")).toBe(true);
  });
  it("tabelas da 1.ª versão ganham a coluna e os índices novos", () => {
    expect(all).toContain("ALTER TABLE `crm_clients` ADD COLUMN `proManual`");
    expect(all).toContain("ALTER TABLE `crm_merge_suggestions` ADD INDEX `idx_crm_suggestion_b`");
  });
  it("collation: converte só as tabelas crm_* diferentes da de multipark_bookings.externalId", async () => {
    const run: string[] = [];
    const db = {
      execute: async (q: any) => {
        const text = new MySqlDialect().sqlToQuery(q).sql;
        if (text.includes("information_schema.COLUMNS")) return [[{ cs: "utf8mb4", coll: "utf8mb4_0900_ai_ci" }]];
        if (text.includes("information_schema.TABLES")) return [[{ t: "crm_clients", c: "utf8mb4_unicode_ci" }, { t: "crm_client_emails", c: "utf8mb4_0900_ai_ci" }]];
        run.push(text);
        return [[]];
      },
    };
    expect(await runMigration0215Collation(db)).toEqual(["crm_clients"]);
    expect(run).toEqual(["ALTER TABLE `crm_clients` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"]);
  });
  it("collation: nome estranho vindo da BD não entra no SQL", async () => {
    const db = { execute: async (q: any) => (new MySqlDialect().sqlToQuery(q).sql.includes("COLUMNS") ? [[{ cs: "utf8mb4", coll: "x; DROP TABLE y" }]] : [[]]) };
    expect(await runMigration0215Collation(db)).toEqual([]);
  });
  it("tem o que a carga e as fusões precisam", () => {
    expect(all).toContain("`proManual`");
    expect(all).toContain("crm_blocked_identifiers");
    expect(all).toContain("`idx_crm_suggestion_b` (`clientB`, `status`)");
    expect(all).toContain("`idx_mb_updated_id` (`updatedAt`, `id`)");
  });
  it("registada no ensureRecentSchema", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0215");
    expect(SCHEMA_MIGRATION_IDS).toContain("0220");
  });
});

describe("migração 0220 (CRM Pro)", () => {
  const all = MIGRATION_0220_STATEMENTS.join("\n");
  it("só cria tabelas, sem collation explícita (o passo da 0215 acerta todas as crm_*)", () => {
    expect(all).not.toMatch(/COLLATE|CHARSET|\bDROP\b|\bDELETE\b/i);
    for (const s of MIGRATION_0220_STATEMENTS) expect(s.startsWith("CREATE TABLE IF NOT EXISTS `crm_pro_")).toBe(true);
    expect(all).toContain("UNIQUE KEY `uq_crm_pro_ledger_source` (`kind`, `sourceId`)");
    expect(all).toContain("UNIQUE KEY `uq_crm_pro_mp_client` (`mpClientId`)");
  });
  it("o passo da collation apanha as crm_pro_* (e só tabelas da lista)", async () => {
    const run: string[] = [];
    const db = {
      execute: async (q: any) => {
        const text = new MySqlDialect().sqlToQuery(q).sql;
        if (text.includes("information_schema.COLUMNS")) return [[{ cs: "utf8mb4", coll: "utf8mb4_0900_ai_ci" }]];
        if (text.includes("information_schema.TABLES")) return [[{ t: "crm_pro_ledger", c: "utf8mb4_general_ci" }, { t: "crm_contacts", c: "latin1_swedish_ci" }, { t: "crm_x; DROP", c: "latin1_swedish_ci" }]];
        run.push(text);
        return [[]];
      },
    };
    expect(await runMigration0215Collation(db)).toEqual(["crm_pro_ledger"]);
    expect(run).toEqual(["ALTER TABLE `crm_pro_ledger` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"]);
  });
});
