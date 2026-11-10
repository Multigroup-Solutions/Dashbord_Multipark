/**
 * 6 nov 2026: "Too many connections" no MySQL — uma pool só, pequena, partilhada.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DB_POOL_MAX_DEFAULT, appPoolOptions } from "./dbPool";

describe("pool da BD da dashboard", () => {
  it("poucas ligações, as paradas fecham depressa, o URL fica como estava", () => {
    const o = appPoolOptions("mysql://u:p@host:3306/db?ssl={}", {});
    expect(o).toMatchObject({ uri: "mysql://u:p@host:3306/db?ssl={}", connectionLimit: DB_POOL_MAX_DEFAULT, maxIdle: 1, idleTimeout: 15_000, waitForConnections: true, queueLimit: 0 });
    expect(DB_POOL_MAX_DEFAULT).toBeLessThanOrEqual(5);
  });

  it("DB_POOL_MAX muda o limite; valores inválidos ficam no de omissão", () => {
    expect(appPoolOptions("x", { DB_POOL_MAX: "8" }).connectionLimit).toBe(8);
    for (const v of ["0", "-3", "abc", "500", ""]) expect(appPoolOptions("x", { DB_POOL_MAX: v }).connectionLimit).toBe(DB_POOL_MAX_DEFAULT);
  });

  it("db.ts, externalApi.ts e mcpApi.ts usam a MESMA pool (nada de drizzle(DATABASE_URL) solto)", () => {
    for (const f of ["server/db.ts", "server/externalApi.ts", "server/mcpApi.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("sharedDrizzle()");
      expect(src, f).not.toMatch(/drizzle\(\s*process\.env\.DATABASE_URL/);
    }
  });
});
