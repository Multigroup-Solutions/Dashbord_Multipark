/**
 * Migração 0675 (Jorge, 14 out 2026): acentos das categorias + "Sinistros",
 * uma vez em toda a frota, nunca dois em paralelo, por id, sem apagar.
 */
import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { CATEGORY_FIX_FLAG_0675, runMigration0675Data } from "./migrations/migration_0675";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

const dialect = new MySqlDialect();

/** BD falsa: app_settings (chave primária), expense_categories e activity_logs. */
function fakeDb(categories: Array<{ id: number; name: string }>, opts: { failOnRename?: boolean; renamedMeanwhile?: Set<number> } = {}) {
  const settings = new Map<string, string>();
  const cats = categories.map((c) => ({ ...c }));
  const logs: string[] = [];
  const db = {
    settings, cats, logs,
    async execute(q: any) {
      const { sql, params } = dialect.sqlToQuery(q);
      const text = sql.replace(/\s+/g, " ");
      if (text.startsWith("INSERT IGNORE INTO app_settings")) {
        if (settings.has(params[0] as string)) return [{ affectedRows: 0 }];
        settings.set(params[0] as string, params[1] as string);
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("UPDATE app_settings") && text.includes("'failed'")) {
        const key = params[1] as string;
        const staleBefore = params[2] as string;
        const cur = settings.get(key);
        const v = cur ? JSON.parse(cur) : null;
        if (v && (v.state === "failed" || (v.state === "running" && String(v.at) < staleBefore))) { settings.set(key, params[0] as string); return [{ affectedRows: 1 }]; }
        return [{ affectedRows: 0 }];
      }
      if (text.startsWith("UPDATE app_settings")) { settings.set(params[1] as string, params[0] as string); return [{ affectedRows: 1 }]; }
      if (text.startsWith("SELECT id, name FROM expense_categories")) return [cats.map((c) => ({ ...c }))];
      if (text.startsWith("UPDATE expense_categories")) {
        if (opts.failOnRename) throw new Error("ligação perdida");
        if (opts.renamedMeanwhile?.has(params[1] as number)) return [{ affectedRows: 0 }];
        const c = cats.find((x) => x.id === params[1] && x.name === params[2]);
        if (c) c.name = params[0] as string;
        return [{ affectedRows: c ? 1 : 0 }];
      }
      if (text.startsWith("INSERT INTO expense_categories")) { cats.push({ id: cats.length + 100, name: params[0] as string }); return [{ affectedRows: 1 }]; }
      if (text.startsWith("INSERT INTO activity_logs")) { logs.push(String(params.find((p) => typeof p === "string" && p.includes("«")))); return [{ affectedRows: 1 }]; }
      throw new Error(`SQL inesperado: ${text}`);
    },
  };
  return db;
}

describe("migração 0675 — nomes das categorias", () => {
  it("está registada em SCHEMA_MIGRATIONS", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0675");
  });
  it("corrige por id, deixa a duplicada como está, acrescenta Sinistros e marca 'done'", async () => {
    const db = fakeDb([{ id: 1, name: "Combustivel" }, { id: 2, name: "Agua" }, { id: 3, name: "Água" }, { id: 4, name: "Seguros" }]);
    const r = await runMigration0675Data(db);
    expect(r.status).toBe("applied");
    expect(db.cats.map((c) => c.name)).toEqual(["Combustível", "Agua", "Água", "Seguros", "Sinistros"]);
    expect(db.cats).toHaveLength(5); // nada apagado
    expect(db.logs).toEqual(["Nome corrigido: «Combustivel» → «Combustível»", "Categoria acrescentada: «Sinistros»"]);
    const flag = JSON.parse(db.settings.get(CATEGORY_FIX_FLAG_0675)!);
    expect(flag).toMatchObject({ state: "done", sinistrosAdded: true, skipped: [{ id: 2, from: "Agua", to: "Água" }] });
  });
  it("corre uma vez só: o segundo arranque (ou outro em paralelo) sai sem tocar em nada", async () => {
    const db = fakeDb([{ id: 1, name: "Combustivel" }]);
    const [a, b] = await Promise.all([runMigration0675Data(db), runMigration0675Data(db)]);
    expect([a.status, b.status].sort()).toEqual(["applied", "skipped"]);
    expect(db.cats.filter((c) => c.name === "Sinistros")).toHaveLength(1);
    db.cats[0].name = "Manutencao"; // criada depois: não é corrigida por esta migração
    expect((await runMigration0675Data(db)).status).toBe("skipped");
    expect(db.cats[0].name).toBe("Manutencao");
  });
  it("se falhar, fica 'failed' e o arranque seguinte volta a tentar (um só)", async () => {
    const bad = fakeDb([{ id: 1, name: "Combustivel" }], { failOnRename: true });
    await expect(runMigration0675Data(bad)).rejects.toThrow("ligação perdida");
    expect(JSON.parse(bad.settings.get(CATEGORY_FIX_FLAG_0675)!).state).toBe("failed");
    const good = fakeDb([{ id: 1, name: "Combustivel" }]);
    good.settings.set(CATEGORY_FIX_FLAG_0675, bad.settings.get(CATEGORY_FIX_FLAG_0675)!);
    expect((await runMigration0675Data(good)).status).toBe("applied");
    expect(good.cats[0].name).toBe("Combustível");
  });
  it("BD nova (sem categorias): não acrescenta Sinistros — entra com as de origem", async () => {
    const db = fakeDb([]);
    const r = await runMigration0675Data(db);
    expect(r).toMatchObject({ status: "applied", sinistrosAdded: false });
    expect(db.cats).toHaveLength(0);
  });
  it("'running' abandonado há mais de 15 min é retomado (um só); recente fica para quem está a correr", async () => {
    const t0 = new Date("2026-10-14T10:00:00.000Z");
    const db = fakeDb([{ id: 1, name: "Combustivel" }, { id: 2, name: "Sinistros" }]);
    db.settings.set(CATEGORY_FIX_FLAG_0675, JSON.stringify({ state: "running", at: t0.toISOString() }));
    expect((await runMigration0675Data(db, { now: new Date(t0.getTime() + 10 * 60_000) })).status).toBe("skipped");
    expect(db.cats[0].name).toBe("Combustivel");
    const later = new Date(t0.getTime() + 16 * 60_000);
    const [a, b] = await Promise.all([runMigration0675Data(db, { now: later }), runMigration0675Data(db, { now: later })]);
    expect([a.status, b.status].sort()).toEqual(["applied", "skipped"]);
    expect(db.cats.map((c) => c.name)).toEqual(["Combustível", "Sinistros"]); // Sinistros não se repete
    expect(JSON.parse(db.settings.get(CATEGORY_FIX_FLAG_0675)!).state).toBe("done");
  });
  it("só escreve no registo de atividade quando o UPDATE mudou mesmo a linha", async () => {
    const db = fakeDb([{ id: 1, name: "Combustivel" }, { id: 2, name: "Agua" }, { id: 3, name: "Sinistros" }], { renamedMeanwhile: new Set([2]) });
    const r = await runMigration0675Data(db);
    expect(db.logs).toEqual(["Nome corrigido: «Combustivel» → «Combustível»"]);
    expect(r.plan?.renames.map((x) => x.id)).toEqual([1]);
    expect(JSON.parse(db.settings.get(CATEGORY_FIX_FLAG_0675)!).renames).toHaveLength(1);
  });
});
