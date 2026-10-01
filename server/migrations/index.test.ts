import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Migrações do arranque (saíram do db.ts a 1 out 2026, P2). Antes ~20 testes
// liam o db.ts como texto para ver se a migração estava "registada"; agora é a
// lista SCHEMA_MIGRATIONS e este teste corre-a contra uma BD falsa.

const data = vi.hoisted(() => ({ calls: [] as string[], fail0215: false }));
vi.mock("./migration_0210", async (original) => ({
  ...(await original<object>()),
  runMigration0210Data: async () => { data.calls.push("0210"); return { status: "skipped", patches: [] }; },
}));
vi.mock("./migration_0215", async (original) => ({
  ...(await original<object>()),
  runMigration0215Collation: async () => { data.calls.push("0215"); if (data.fail0215) throw new Error("sem permissões"); return []; },
}));
vi.mock("./migration_0230", async (original) => ({
  ...(await original<object>()),
  runMigration0230Data: async () => { data.calls.push("0230"); return { status: "skipped", messages: 0, threads: 0, sends: 0 }; },
}));

import { SCHEMA_MIGRATIONS, SCHEMA_MIGRATION_IDS, ensureRecentSchema } from "./index";

const dir = resolve(import.meta.dirname);
const render = (q: any) => new MySqlDialect().sqlToQuery(q).sql;
/** Migrações só à mão (botões DB:NNNN / scripts/run-migration.ts) — nunca no arranque. */
const MANUAL_ONLY = ["0044", "0045", "0046", "0047", "0048", "0049"];

beforeEach(() => { data.calls = []; data.fail0215 = false; });

describe("lista das migrações do arranque", () => {
  it("ids de 4 algarismos, sem repetir, por ordem crescente (a ordem é a de aplicação)", () => {
    expect(SCHEMA_MIGRATION_IDS.length).toBeGreaterThan(90);
    for (const id of SCHEMA_MIGRATION_IDS) expect(id).toMatch(/^\d{4}$/);
    expect(new Set(SCHEMA_MIGRATION_IDS).size).toBe(SCHEMA_MIGRATION_IDS.length);
    expect([...SCHEMA_MIGRATION_IDS].sort()).toEqual([...SCHEMA_MIGRATION_IDS]);
    expect(SCHEMA_MIGRATION_IDS[0]).toBe("0050");
  });

  it("todos os ficheiros migration_NNNN estão na lista, menos os só à mão (não esquecer de registar)", () => {
    const files = readdirSync(dir).map((f) => /^migration_(\d{4})\.ts$/.exec(f)?.[1]).filter((x): x is string => !!x);
    expect(files.filter((id) => !SCHEMA_MIGRATION_IDS.includes(id)).sort()).toEqual(MANUAL_ONLY);
    for (const id of MANUAL_ONLY) expect(SCHEMA_MIGRATION_IDS).not.toContain(id);
  });

  it("cada carregador traz o SQL e os erros idempotentes DO SEU ficheiro", async () => {
    for (const [id, load] of SCHEMA_MIGRATIONS) {
      const m = await load();
      const mod = await import(`./migration_${id}.ts`);
      expect(m.statements, id).toBe(mod[`MIGRATION_${id}_STATEMENTS`]);
      expect(m.idempotentErrors, id).toBe(mod[`IDEMPOTENT_ERROR_CODES_${id}`]);
      expect(m.statements.length, id).toBeGreaterThan(0);
      expect(m.idempotentErrors).toBeInstanceOf(Set);
    }
  });

  it("o db.ts usa esta lista (já não tem as importações à mão)", () => {
    const db = readFileSync(join(dir, "..", "db.ts"), "utf8");
    expect(db).toContain('import { ensureRecentSchema } from "./migrations/index"');
    expect(db).toContain("_schemaEnsure = ensureRecentSchema(_db)");
    expect(db).not.toMatch(/import\("\.\/migrations\/migration_\d{4}"\)\.then/);
  });
});

describe("ensureRecentSchema (BD falsa)", () => {
  it("aplica todas as instruções por ordem; 'já existe' fica calado, o resto avisa e segue; depois os passos de dados", async () => {
    const all: string[] = [];
    for (const [, load] of SCHEMA_MIGRATIONS) all.push(...(await load()).statements);
    const first = (await SCHEMA_MIGRATIONS[0][1]()).statements[0];
    const firstOk = [...(await SCHEMA_MIGRATIONS[0][1]()).idempotentErrors][0];
    const ran: string[] = [];
    const db = {
      execute: async (q: any) => {
        const s = render(q);
        ran.push(s);
        // 1.ª: erro do drizzle a embrulhar o do mysql2 (código em cause.code) → calado
        if (ran.length === 1) throw Object.assign(new Error("Failed query"), { cause: { code: firstOk, message: "dup" } });
        // 2.ª: erro a sério → avisa e continua
        if (ran.length === 2) throw Object.assign(new Error("boom"), { code: "ER_PARSE_ERROR" });
        return [];
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await ensureRecentSchema(db);
      expect(ran[0]).toBe(first);
      expect(ran).toEqual(all);
      const schemaWarns = warn.mock.calls.filter((c) => c[0] === "[Schema ensure]");
      expect(schemaWarns).toHaveLength(1);
      expect(schemaWarns[0][1]).toBe("ER_PARSE_ERROR");
      expect(data.calls).toEqual(["0210", "0215", "0230"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("um passo de dados que falha avisa e não trava os seguintes", async () => {
    data.fail0215 = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await ensureRecentSchema({ execute: async () => [] });
      expect(data.calls).toEqual(["0210", "0215", "0230"]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("0215"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
