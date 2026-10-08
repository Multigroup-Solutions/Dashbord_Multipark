/**
 * 49h — recrutamento em 1.º contacto pela IA cria também a ficha de CANDIDATO
 * (inativa, motivo `candidato`, sem conta), e essa ficha liga-se sozinha à
 * conta Google com o MESMO email no 1.º login. Nunca duplica, nunca apaga.
 */
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRecruitmentFirstContact, type FirstContactStore } from "./recruitmentFirstContact";

const h = vi.hoisted(() => ({
  sql: [] as Array<{ sql: string; params: unknown[] }>,
  reply: (_q: string, _p: unknown[]): any[] => [],
}));

const dialect = new MySqlDialect();
const fakeDb = {
  execute: vi.fn(async (q: any) => {
    const r = dialect.sqlToQuery(q);
    h.sql.push(r);
    const rows = h.reply(r.sql, r.params);
    return [rows.length ? rows : Object.assign([], { insertId: 900, affectedRows: 1 })];
  }),
};

vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => fakeDb,
  logActivity: async () => undefined,
}));

import { createCandidateFichaForApplication, linkCandidateFichaOnLogin } from "./accountLink";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

beforeEach(() => {
  h.sql.length = 0;
  h.reply = () => [];
});

function memStore(opts: { candidate?: (row: any) => Promise<number | null> } = {}) {
  const calls: any[] = [];
  const store: FirstContactStore = {
    findActiveEmployee: async () => null,
    findLead: async () => null,
    findApplication: async () => null,
    createApplication: async () => 1,
    createLead: async () => 100,
    appendLeadNote: async () => {},
    markSources: async () => {},
    log: async () => {},
    afterLeadCreated: async () => {},
    createCandidateEmployee: async (row) => {
      calls.push(row);
      return opts.candidate ? opts.candidate(row) : 55;
    },
  };
  return { calls, store };
}
const CAND = { fullName: "Ana Sousa", phone: "912 345 678", email: "ana@sapo.pt", city: "Porto", hasLicense: true, licenseYears: 5, availability: "noites" };

describe("1.º contacto pela IA → ficha de candidato", () => {
  it("com email: cria a candidatura, a lead E a ficha de candidato (cidade e telefone)", async () => {
    const { calls, store } = memStore();
    const r = await onRecruitmentFirstContact({ channel: "email", sourceRef: "ai:mail_thread:1", candidate: CAND, projectId: 2, reason: "CV" }, store);
    expect(r).toEqual({ outcome: "created", leadId: 100, applicationId: 1, candidateEmployeeId: 55 });
    expect(calls).toEqual([{ applicationId: 1, email: "ana@sapo.pt", fullName: "Ana Sousa", phone: "+351912345678", projectId: 2 }]);
  });
  it("WhatsApp sem email: só a lead, sem ficha (a ficha precisa do email para ligar a conta)", async () => {
    const { calls, store } = memStore();
    const r = await onRecruitmentFirstContact({ channel: "whatsapp", sourceRef: "ai:whatsapp:1", candidate: { ...CAND, email: null }, projectId: null, reason: null }, store);
    expect(r).toMatchObject({ outcome: "created", applicationId: null, candidateEmployeeId: null });
    expect(calls).toHaveLength(0);
  });
  it("se a ficha falhar, a lead e a candidatura ficam (nunca parte o encaminhamento)", async () => {
    const { store } = memStore({ candidate: async () => { throw new Error("BD em baixo"); } });
    const r = await onRecruitmentFirstContact({ channel: "email", sourceRef: "ai:mail_thread:2", candidate: CAND, projectId: null, reason: null }, store);
    expect(r).toMatchObject({ outcome: "created", leadId: 100, applicationId: 1, candidateEmployeeId: null });
  });
});

describe("createCandidateFichaForApplication", () => {
  it("sem ficha com esse email → cria inativa, motivo candidato, sem conta, e a candidatura aponta para ela", async () => {
    const id = await createCandidateFichaForApplication({ applicationId: 7, email: " Ana@Sapo.pt ", fullName: "Ana Sousa", phone: "912345678", projectId: 2, how: "teste" });
    expect(id).toBe(900);
    const insert = h.sql.find((q) => q.sql.startsWith("INSERT INTO employees"))!;
    expect(insert.sql).toContain("'extra', 'extra', NULL");
    expect(insert.params).toContain("ana@sapo.pt");
    expect(insert.params).toContain("candidato");
    expect(insert.sql).toMatch(/, 0, \?, \?, \?\)$/); // isActive = 0 (inativa até ser aprovada)
    const upd = h.sql.find((q) => q.sql.startsWith("UPDATE driver_applications"))!;
    expect(upd.sql).toContain("employeeId IS NULL");
    expect(upd.params).toEqual([900, 7]);
  });
  it("já há ficha com esse email → não cria outra, só liga a candidatura", async () => {
    h.reply = (q) => (q.startsWith("SELECT id FROM employees") ? [{ id: 31 }] : []);
    expect(await createCandidateFichaForApplication({ applicationId: 8, email: "ana@sapo.pt", fullName: "Ana", how: "teste" })).toBe(31);
    expect(h.sql.some((q) => q.sql.startsWith("INSERT INTO employees"))).toBe(false);
    expect(h.sql.find((q) => q.sql.startsWith("UPDATE driver_applications"))!.params).toEqual([31, 8]);
  });
  it("email inválido → nada", async () => {
    expect(await createCandidateFichaForApplication({ applicationId: 9, email: "não é email", fullName: "X", how: "teste" })).toBeNull();
    expect(h.sql).toHaveLength(0);
  });
});

describe("linkCandidateFichaOnLogin (1.º login com o mesmo email)", () => {
  it("conta sem ficha + ficha de candidato sem conta com o mesmo email → liga (só se ainda estiver sem conta)", async () => {
    h.reply = (q) => (q.includes("WHERE userId IS NULL") ? [{ id: 44, fullName: "Ana Sousa" }] : []);
    expect(await linkCandidateFichaOnLogin(12, "ana@sapo.pt")).toBe(44);
    const pick = h.sql.find((q) => q.sql.includes("WHERE userId IS NULL"))!;
    expect(pick.sql).toContain("isActive = 0");
    expect(pick.params).toContain("candidato");
    const upd = h.sql.find((q) => q.sql.startsWith("UPDATE employees"))!;
    expect(upd.sql).toContain("AND userId IS NULL");
    expect(upd.params).toEqual([12, 44]);
  });
  it("a conta já tem ficha → não mexe", async () => {
    h.reply = (q) => (q.startsWith("SELECT id FROM employees WHERE userId =") ? [{ id: 3 }] : []);
    expect(await linkCandidateFichaOnLogin(12, "ana@sapo.pt")).toBeNull();
    expect(h.sql.some((q) => q.sql.startsWith("UPDATE employees"))).toBe(false);
  });
  it("sem ficha de candidato com esse email → nada", async () => {
    expect(await linkCandidateFichaOnLogin(12, "ana@sapo.pt")).toBeNull();
    expect(h.sql.some((q) => q.sql.startsWith("UPDATE employees"))).toBe(false);
  });
});

describe("ligado no login e nunca apaga", () => {
  it("o callback OAuth chama a ligação da ficha de candidato (best-effort)", () => {
    const o = src("server/_core/oauth.ts");
    expect(o).toContain("linkCandidateFichaOnLogin(account.id, email)");
  });
  it("sem DELETE no código novo", () => {
    const a = src("server/accountLink.ts");
    const part = a.slice(a.indexOf("export async function createCandidateFichaForApplication"), a.indexOf("/** Candidatura → ficha de candidato"));
    expect(part).not.toMatch(/\bDELETE\b/i);
  });
});
