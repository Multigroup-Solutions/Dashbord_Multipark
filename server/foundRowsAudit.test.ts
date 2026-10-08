/**
 * Auditoria FOUND_ROWS (8 out 2026, na sequência do #343). O mysql2 liga o
 * flag FOUND_ROWS por omissão e o drizzle(DATABASE_URL) usa essa ligação: as
 * linhas afetadas passam a ser as que o WHERE ENCONTRA, mudadas ou não. Um
 * `INSERT … ON DUPLICATE KEY UPDATE` que não muda nada dá 1 (e não 0), e um
 * `UPDATE` que encontra a linha mas lhe deixa os mesmos valores também dá 1.
 *
 * As BD falsas daqui seguem essa regra (documentação do MySQL,
 * mysql_affected_rows + CLIENT_FOUND_ROWS) para os três sítios que decidiam
 * mal por causa dela:
 *  1. CRM Pro: a ficha da conta que já existia contava como "criada";
 *  2. Converter um lead em extra: retomar uma reserva esquecida (0 → 0) não
 *     mudava a linha — dois cliques retomavam-na os dois;
 *  3. Candidatura aprovada → lead convertido: voltar a aprovar registava outra
 *     "conversão".
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as any, logs: [] as any[] }));
vi.mock("./db", async (orig) => ({ ...(await orig<typeof import("./db")>()), getDb: async () => h.db, logActivity: async (a: any) => { h.logs.push(a); } }));

import { resolveFicha } from "./crm/proSync";
import { claimLeadForConversion } from "./extrasAutomation";
import { leadConversionPending, markLeadConvertedForApplication } from "./extraLeadsSync";
import { driverApplications } from "../drizzle/schema";

const dialect = new MySqlDialect();
const render = (q: any) => {
  const r = dialect.sqlToQuery(q);
  return { sql: r.sql.replace(/\s+/g, " ").trim(), params: r.params as unknown[] };
};

beforeEach(() => { h.logs = []; h.db = null; });

// ─── 1. CRM Pro: a ficha da conta ─────────────────────────────────────────────

type FakeClient = { id: number; syncKey: string | null; status: string; mergedInto: number | null };

/** crm_clients com a regra do FOUND_ROWS (só o que resolveFicha usa). */
function fakeCrm(initial: FakeClient[] = []) {
  const clients = new Map(initial.map((c) => [c.id, { ...c }]));
  let nextId = 100;
  const sqls: string[] = [];
  const emails: Array<{ clientId: number; email: unknown }> = [];
  const phones: Array<{ clientId: number; phone: unknown }> = [];
  const bySyncKey = (k: unknown) => Array.from(clients.values()).find((c) => c.syncKey === k);
  const insert = (k: unknown) => {
    const id = nextId++;
    clients.set(id, { id, syncKey: String(k), status: "active", mergedInto: null });
    return id;
  };
  const db = {
    async execute(q: any) {
      const { sql: s, params } = render(q);
      sqls.push(s);
      if (/^SELECT status, mergedInto FROM crm_clients WHERE id = \?/.test(s)) {
        const c = clients.get(Number(params[0]));
        return [c ? [{ status: c.status, mergedInto: c.mergedInto }] : []];
      }
      if (/FROM crm_client_external_ids/.test(s) || /FROM crm_client_emails e JOIN crm_clients/.test(s)) return [[]];
      if (/^INSERT IGNORE INTO crm_clients /.test(s)) {
        if (bySyncKey(params[0])) return [{ affectedRows: 0, insertId: 0 }];
        return [{ affectedRows: 1, insertId: insert(params[0]) }];
      }
      if (/^INSERT INTO crm_clients .* ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID\(id\)$/.test(s)) {
        // O SQL antigo: num duplicado a linha fica igual → com FOUND_ROWS dá 1, como uma nova.
        const dup = bySyncKey(params[0]);
        if (dup) return [{ affectedRows: 1, insertId: dup.id }];
        return [{ affectedRows: 1, insertId: insert(params[0]) }];
      }
      if (/^SELECT id FROM crm_clients WHERE syncKey = \? LIMIT 1$/.test(s)) {
        const c = bySyncKey(params[0]);
        return [c ? [{ id: c.id }] : []];
      }
      if (/^INSERT IGNORE INTO crm_client_emails /.test(s)) { emails.push({ clientId: Number(params[0]), email: params[1] }); return [{ affectedRows: 1 }]; }
      if (/^INSERT IGNORE INTO crm_client_phones /.test(s)) { phones.push({ clientId: Number(params[0]), phone: params[1] }); return [{ affectedRows: 1 }]; }
      throw new Error(`SQL inesperado: ${s}`);
    },
  };
  return { db, clients, sqls, emails, phones };
}

const account = (mpClientId: string) => ({
  mpClientId, name: "Empresa Exemplo Lda", email: "frota@empresa-exemplo.pt", phone: "912345678", nif: "509999990", taxName: "Empresa Exemplo Lda", active: true,
}) as any;

describe("CRM Pro: a ficha da conta só conta como criada quando é mesmo nova", () => {
  it("conta nova → cria a ficha, com o email e o telefone da conta", async () => {
    const f = fakeCrm();
    const r = await resolveFicha(f.db, account("77"), null);
    expect(r.created).toBe(true);
    expect(f.clients.get(r.clientId!)?.syncKey).toBe("pro:77");
    expect(f.emails).toEqual([{ clientId: r.clientId, email: "frota@empresa-exemplo.pt" }]);
    expect(f.phones).toHaveLength(1);
  });

  it("a ficha da conta já existe (ligação perdida) → não é criada outra vez nem recebe de novo email/telefone", async () => {
    const f = fakeCrm([{ id: 50, syncKey: "pro:77", status: "active", mergedInto: null }]);
    const r = await resolveFicha(f.db, account("77"), null);
    expect(r).toEqual({ clientId: 50, created: false });
    expect(f.emails).toEqual([]);
    expect(f.phones).toEqual([]);
  });

  it("a ficha da conta foi junta a outra → devolve a que ficou, sem lhe pôr email/telefone principais", async () => {
    const f = fakeCrm([
      { id: 50, syncKey: "pro:77", status: "merged", mergedInto: 60 },
      { id: 60, syncKey: null, status: "active", mergedInto: null },
    ]);
    const r = await resolveFicha(f.db, account("77"), null);
    expect(r).toEqual({ clientId: 60, created: false });
    expect(f.emails).toEqual([]);
    expect(f.phones).toEqual([]);
  });

  it("duas corridas ao mesmo tempo (cron + botão) → só a primeira cria", async () => {
    const f = fakeCrm();
    const a = await resolveFicha(f.db, account("77"), null);
    const b = await resolveFicha(f.db, account("77"), null);
    expect([a.created, b.created]).toEqual([true, false]);
    expect(b.clientId).toBe(a.clientId);
    expect(f.emails).toHaveLength(1);
  });

  it("é um INSERT IGNORE (o ON DUPLICATE KEY UPDATE dava 1 num duplicado, com o FOUND_ROWS)", async () => {
    const f = fakeCrm([{ id: 50, syncKey: "pro:77", status: "active", mergedInto: null }]);
    await resolveFicha(f.db, account("77"), null);
    const ins = f.sqls.filter((s) => /INTO crm_clients /.test(s));
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatch(/^INSERT IGNORE INTO crm_clients /);
    expect(ins[0]).not.toMatch(/ON DUPLICATE KEY/);
    // a BD falsa segue a regra: o SQL antigo, num duplicado, dava 1 — "criada"
    const old = await f.db.execute(sql`INSERT INTO crm_clients (syncKey) VALUES (${"pro:77"}) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`);
    expect(old[0]).toEqual({ affectedRows: 1, insertId: 50 });
  });
});

// ─── 2. Converter um lead em extra: a reserva ─────────────────────────────────

const NOW = Date.parse("2026-10-08T10:00:00Z");
const MIN = 60_000;

/**
 * Uma linha de extra_leads com a regra do MySQL: o ON UPDATE CURRENT_TIMESTAMP
 * só corre quando a linha MUDA; com FOUND_ROWS as linhas afetadas são as que o
 * WHERE encontra. Os pedidos chegam um a seguir ao outro (o InnoDB serializa-os
 * pela linha).
 */
function fakeLead(row: { id: number; employeeId: number | null; updatedAtMs: number }) {
  const r = { ...row };
  const sqls: string[] = [];
  const db = {
    async execute(q: any) {
      const { sql: s, params } = render(q);
      sqls.push(s);
      const m = /^UPDATE extra_leads SET (.+?) WHERE id = \? AND \(employeeId IS NULL OR \(employeeId = 0 AND updatedAt < NOW\(\) - INTERVAL 10 MINUTE\)\)$/.exec(s);
      if (!m) throw new Error(`SQL inesperado: ${s}`);
      const found = Number(params[0]) === r.id && (r.employeeId == null || (r.employeeId === 0 && r.updatedAtMs < NOW - 10 * MIN));
      if (!found) return [{ affectedRows: 0 }];
      const setsUpdatedAt = /\bupdatedAt = NOW\(\)/.test(m[1]);
      const changed = r.employeeId !== 0 || (setsUpdatedAt && r.updatedAtMs !== NOW);
      r.employeeId = 0;
      if (changed) r.updatedAtMs = NOW; // SET explícito ou ON UPDATE (só porque mudou)
      return [{ affectedRows: 1 }]; // FOUND_ROWS: encontrou → 1, mudasse ou não
    },
  };
  return { db, row: r, sqls };
}

describe("Converter um lead em extra: só um clique fica com a reserva", () => {
  it("lead sem ficha → o primeiro clique reserva, o segundo não", async () => {
    const f = fakeLead({ id: 9, employeeId: null, updatedAtMs: NOW - 60 * MIN });
    expect(await claimLeadForConversion(f.db, 9)).toBe(true);
    expect(await claimLeadForConversion(f.db, 9)).toBe(false);
    expect(f.row.employeeId).toBe(0);
  });

  it("reserva esquecida há mais de 10 min → dois cliques seguidos: só o primeiro a retoma", async () => {
    const f = fakeLead({ id: 9, employeeId: 0, updatedAtMs: NOW - 30 * MIN });
    expect(await claimLeadForConversion(f.db, 9)).toBe(true);
    expect(f.row.updatedAtMs).toBe(NOW);
    expect(await claimLeadForConversion(f.db, 9)).toBe(false);
  });

  it("sem a hora no SET (o SQL de antes) os dois retomavam — é o erro do FOUND_ROWS", async () => {
    const f = fakeLead({ id: 9, employeeId: 0, updatedAtMs: NOW - 30 * MIN });
    const old = () => f.db.execute(sql`UPDATE extra_leads SET employeeId = 0
      WHERE id = ${9} AND (employeeId IS NULL OR (employeeId = 0 AND updatedAt < NOW() - INTERVAL 10 MINUTE))`);
    expect((await old())[0].affectedRows).toBe(1);
    expect((await old())[0].affectedRows).toBe(1);
  });

  it("reserva recente (< 10 min) ou lead já com ficha → não", async () => {
    expect(await claimLeadForConversion(fakeLead({ id: 9, employeeId: 0, updatedAtMs: NOW - 2 * MIN }).db, 9)).toBe(false);
    expect(await claimLeadForConversion(fakeLead({ id: 9, employeeId: 31, updatedAtMs: NOW - 60 * MIN }).db, 9)).toBe(false);
  });

  it("convertLeadToExtra reserva por aqui (e liberta a reserva se falhar)", () => {
    const src = readFileSync(new URL("./extrasAutomation.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export async function convertLeadToExtra("), src.indexOf("// ─── Orquestração do cron"));
    expect(body).toContain("await claimLeadForConversion(db, leadId)");
    expect(body).not.toMatch(/set\(\{ employeeId: 0 \}\)/);
    expect(body).toMatch(/set\(\{ employeeId: null \}\)\.where\(and\(eq\(extraLeads\.id, leadId\), eq\(extraLeads\.employeeId, 0\)\)\)/);
  });
});

// ─── 3. Candidatura aprovada → lead convertido ────────────────────────────────

type LeadRow = { id: number; fullName: string; email: string | null; phoneE164: string | null; sourceRef: string | null; status: string; employeeId: number | null; convertedAt: string | null; projectId: number | null; archivedAt: string | null };

const APP = { id: 41, email: "ana@gmail.com", phone: null, fullName: "Ana Silva", status: "approved", employeeId: 31 };
const openLead = (): LeadRow => ({ id: 9, fullName: "Ana Silva", email: "ana@gmail.com", phoneE164: null, sourceRef: "application:41", status: "contacted", employeeId: null, convertedAt: null, projectId: null, archivedAt: null });
const convertedLead = (): LeadRow => ({ ...openLead(), status: "converted", employeeId: 31, convertedAt: "2026-10-01 09:00:00", projectId: 3 });

/**
 * `read` é o que a função lê; `stored` é a linha na BD quando o UPDATE corre
 * (diferem numa corrida). O UPDATE segue o FOUND_ROWS: conta o que o WHERE
 * encontra — a condição de "muda alguma coisa" só conta se estiver no WHERE.
 */
function fakeApproval(read: LeadRow, stored: LeadRow = read) {
  const row = { ...stored };
  const updates: Array<{ set: any; where: string }> = [];
  const db = {
    select: () => ({
      from: (t: unknown) => ({
        where: () => ({ limit: async () => (t === driverApplications ? [APP] : [read]) }),
      }),
    }),
    update: () => ({
      set: (set: any) => ({
        where: async (w: any) => {
          const where = render(w).sql;
          updates.push({ set, where });
          const guarded = /<> 'converted'/.test(where);
          const found = row.id === read.id && (row.employeeId == null || row.employeeId === set.employeeId) && (!guarded || leadConversionPending(row));
          if (!found) return [{ affectedRows: 0 }];
          Object.assign(row, { status: "converted", employeeId: set.employeeId, convertedAt: row.convertedAt ?? "2026-10-08 10:00:00", projectId: row.projectId ?? 3, sourceRef: row.sourceRef ?? "application:41" });
          return [{ affectedRows: 1 }];
        },
      }),
    }),
  };
  return { db, row, updates };
}

describe("Candidatura aprovada → lead convertido: uma conversão regista-se uma vez", () => {
  it("lead aberto → fica convertido e ligado à ficha, com um registo", async () => {
    const f = fakeApproval(openLead());
    h.db = f.db;
    expect(await markLeadConvertedForApplication(41, 31, 3, 7)).toBe(9);
    expect(f.row).toMatchObject({ status: "converted", employeeId: 31 });
    expect(h.logs).toEqual([expect.objectContaining({ action: "extra_lead_convert", entityId: 9 })]);
  });

  it("voltar a aprovar (lead já convertido para esta ficha) → não escreve nem regista outra conversão", async () => {
    const f = fakeApproval(convertedLead());
    h.db = f.db;
    expect(await markLeadConvertedForApplication(41, 31, 3, 7)).toBeNull();
    expect(f.updates).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it("duas aprovações ao mesmo tempo: a que chega depois encontra o lead já convertido → 0 linhas, sem registo", async () => {
    const f = fakeApproval(openLead(), convertedLead());
    h.db = f.db;
    expect(await markLeadConvertedForApplication(41, 31, 3, 7)).toBeNull();
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].where).toMatch(/<> 'converted'/);
    expect(h.logs).toEqual([]);
  });

  it("convertido mas sem centro de custos → completa e regista", async () => {
    const f = fakeApproval({ ...convertedLead(), projectId: null });
    h.db = f.db;
    expect(await markLeadConvertedForApplication(41, 31, 3, 7)).toBe(9);
    expect(f.row.projectId).toBe(3);
    expect(h.logs).toHaveLength(1);
  });

  it("lead ligado a outra ficha → não mexe", async () => {
    const f = fakeApproval({ ...convertedLead(), employeeId: 99 });
    h.db = f.db;
    expect(await markLeadConvertedForApplication(41, 31, 3, 7)).toBeNull();
    expect(f.updates).toEqual([]);
  });

  it("leadConversionPending: só não há nada a fazer com tudo preenchido", () => {
    expect(leadConversionPending(convertedLead())).toBe(false);
    expect(leadConversionPending(openLead())).toBe(true);
    expect(leadConversionPending({ ...convertedLead(), sourceRef: null })).toBe(true);
    expect(leadConversionPending({ ...convertedLead(), convertedAt: null })).toBe(true);
    expect(leadConversionPending({ ...convertedLead(), status: "declined" })).toBe(true);
  });
});
