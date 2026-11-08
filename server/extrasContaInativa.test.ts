/**
 * Conta desativada (Utilizadores) com a ficha ainda ativa: não se pede
 * disponibilidade (Jorge, 8 nov 2026 — "estão inativos mas continuam a receber
 * emails"). A ficha só acompanha a conta desde o #309 e só na cidade de quem
 * desativa, por isso há contas inativas com fichas ativas.
 */
import { createRequire } from "node:module";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

let where: any;
const chain: any = {
  select: () => chain,
  from: () => chain,
  where: (c: any) => { where = c; return chain; },
  orderBy: async () => [],
};
vi.mock("./db", () => ({ getDb: async () => chain }));
vi.mock("./rhDocuments", () => ({ licenceStatusMap: async () => new Map() }));

const { accountNotDeactivated, listActiveEmployeesByIds, listActiveExtras } = await import("./extrasAvailability");
const { listDriverCandidates } = await import("./extrasDia");

const render = (c: any) => new MySqlDialect().sqlToQuery(c).sql;
// node:sqlite pelo require: o vite não conhece este módulo no import.
const sqlite: any = (() => { try { return createRequire(import.meta.url)("node:sqlite"); } catch { return null; } })();

describe("quem recebe o pedido de disponibilidade", () => {
  beforeEach(() => { where = undefined; });

  it("a lista de todos os extras deixa de fora a conta desativada", async () => {
    await listActiveExtras();
    expect(render(where)).toContain(render(accountNotDeactivated()));
  });
  it("os escolhidos à mão e o lembrete também", async () => {
    await listActiveEmployeesByIds([1, 2]);
    expect(render(where)).toContain(render(accountNotDeactivated()));
  });
});

describe("quem pode entrar na escala", () => {
  beforeEach(() => { where = undefined; });

  it("a lista da escala (proposta, preenchimento, 'faltam responder' e seletor à mão) também", async () => {
    await listDriverCandidates();
    expect(render(where)).toContain(render(accountNotDeactivated()));
  });
});

describe.skipIf(!sqlite)("regra da conta desativada (SQL real)", () => {
  const survivors = (setup: string) => {
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(`CREATE TABLE employees (id INTEGER, userId INTEGER);
      CREATE TABLE users (id INTEGER, isActive INTEGER, loginMethod TEXT);
      CREATE TABLE employee_accounts (employeeId INTEGER, userId INTEGER);
      ${setup}`);
    const rows = db.prepare(`SELECT id FROM employees WHERE ${render(accountNotDeactivated())} ORDER BY id`).all();
    db.close();
    return rows.map((r: any) => Number(r.id));
  };

  it("conta inativa fica de fora (o caso do print)", () => {
    expect(survivors(`INSERT INTO employees VALUES (1, 10); INSERT INTO users VALUES (10, 0, 'google');`)).toEqual([]);
  });
  it("sem conta continua a receber: quem ainda não entrou é a maioria dos extras novos", () => {
    expect(survivors(`INSERT INTO employees VALUES (1, NULL);`)).toEqual([1]);
  });
  it("conta ativa continua a receber", () => {
    expect(survivors(`INSERT INTO employees VALUES (1, 10); INSERT INTO users VALUES (10, 1, 'google');`)).toEqual([1]);
  });
  it("outra conta ativa da mesma ficha mantém a pessoa (a mesma regra do employeesFollowingAccount)", () => {
    expect(survivors(`INSERT INTO employees VALUES (1, 10); INSERT INTO users VALUES (10, 0, 'google'), (11, 1, 'google');
      INSERT INTO employee_accounts VALUES (1, 11);`)).toEqual([1]);
  });
  it("outra conta também inativa não salva", () => {
    expect(survivors(`INSERT INTO employees VALUES (1, 10); INSERT INTO users VALUES (10, 0, 'google'), (11, 0, 'google');
      INSERT INTO employee_accounts VALUES (1, 11);`)).toEqual([]);
  });
  it("conta junta a outra (merged_into_) não é pessoa desativada", () => {
    expect(survivors(`INSERT INTO employees VALUES (1, 10); INSERT INTO users VALUES (10, 0, 'merged_into_99');`)).toEqual([1]);
  });
  it("loginMethod vazio numa conta inativa continua a ser conta desativada", () => {
    expect(survivors(`INSERT INTO employees VALUES (1, 10); INSERT INTO users VALUES (10, 0, NULL);`)).toEqual([]);
  });
  it("só mexe na ficha certa", () => {
    expect(survivors(`INSERT INTO employees VALUES (1, 10), (2, 20), (3, NULL);
      INSERT INTO users VALUES (10, 0, 'google'), (20, 1, 'google');`)).toEqual([2, 3]);
  });
});
