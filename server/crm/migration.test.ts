import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IDEMPOTENT_ERROR_CODES_0215, MIGRATION_0215_STATEMENTS } from "../migrations/migration_0215";

describe("migração 0215 (CRM)", () => {
  const all = MIGRATION_0215_STATEMENTS.join("\n");
  it("sem collation explícita: igual à de multipark_bookings (ligações por externalId)", () => {
    expect(all).not.toMatch(/COLLATE/i);
    expect(all).not.toMatch(/CHARSET/i);
  });
  it("só cria (nada de DROP/DELETE) e é idempotente", () => {
    expect(all).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
    for (const s of MIGRATION_0215_STATEMENTS) {
      expect(s.startsWith("CREATE TABLE IF NOT EXISTS") || s.startsWith("ALTER TABLE `multipark_bookings` ADD INDEX")).toBe(true);
    }
    expect(IDEMPOTENT_ERROR_CODES_0215.has("ER_DUP_KEYNAME")).toBe(true);
  });
  it("tem o que a carga e as fusões precisam", () => {
    expect(all).toContain("`proManual`");
    expect(all).toContain("crm_blocked_identifiers");
    expect(all).toContain("`idx_crm_suggestion_b` (`clientB`, `status`)");
    expect(all).toContain("`idx_mb_updated_id` (`updatedAt`, `id`)");
  });
  it("registada no ensureRecentSchema", () => {
    const db = readFileSync(resolve(__dirname, "..", "db.ts"), "utf8");
    expect(db).toContain('import("./migrations/migration_0215")');
  });
});
