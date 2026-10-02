/**
 * Decisão do Jorge (2 out 2026): marcar um lead "Sem interesse" rejeita a
 * candidatura do site da mesma pessoa (pela sourceRef ou pelo email). Nunca
 * mexe numa aprovada nem numa já rejeitada, e não volta a fechar o lead.
 */
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as any, logs: [] as any[] }));
vi.mock("./db", async (orig) => ({ ...(await orig<typeof import("./db")>()), getDb: async () => h.db, logActivity: async (a: any) => { h.logs.push(a); } }));

import { rejectApplicationForLead } from "./extraLeadsSync";

const dialect = new MySqlDialect();
function fakeDb(apps: Array<{ id: number; status: string; fullName: string }>, affected = 1) {
  const updates: Array<{ set: any; where: string }> = [];
  const selects: string[] = [];
  const db = {
    select: () => ({ from: () => ({ where: (w: any) => { selects.push(dialect.sqlToQuery(w).sql); return { limit: async () => apps }; } }) }),
    update: () => ({ set: (set: any) => ({ where: async (w: any) => { updates.push({ set, where: dialect.sqlToQuery(w).sql }); return [{ affectedRows: affected }]; } }) }),
  };
  return { db, updates, selects };
}
const lead = { id: 9, fullName: "Ana Silva", email: "Ana@Gmail.com", sourceRef: "application:41" };

beforeEach(() => { h.logs = []; });

describe("Lead Sem interesse → candidatura rejeitada", () => {
  it("candidatura nova pela sourceRef → rejeitada e registada", async () => {
    const f = fakeDb([{ id: 41, status: "new", fullName: "Ana Silva" }]);
    h.db = f.db;
    expect(await rejectApplicationForLead(lead, 3)).toBe(41);
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].set).toMatchObject({ status: "rejected", reviewedById: 3 });
    expect(f.updates[0].where).toContain("in (?, ?)"); // só new/reviewed
    expect(h.logs[0]).toMatchObject({ action: "driver_application_status", entityId: 41 });
  });
  it("aprovada (já tem ficha) ou já rejeitada → não mexe", async () => {
    for (const status of ["approved", "rejected"]) {
      const f = fakeDb([{ id: 41, status, fullName: "Ana Silva" }]);
      h.db = f.db;
      expect(await rejectApplicationForLead(lead, 3)).toBeNull();
      expect(f.updates).toHaveLength(0);
    }
  });
  it("sem candidatura, sem sourceRef nem email → nada", async () => {
    h.db = fakeDb([]).db;
    expect(await rejectApplicationForLead(lead, 3)).toBeNull();
    expect(await rejectApplicationForLead({ id: 1, fullName: "X", email: null, sourceRef: "whatsapp:1" }, 3)).toBeNull();
  });
  it("procura pelo email normalizado quando o lead não veio do site", async () => {
    const f = fakeDb([{ id: 7, status: "reviewed", fullName: "Ana" }]);
    h.db = f.db;
    expect(await rejectApplicationForLead({ ...lead, sourceRef: null }, 3)).toBe(7);
  });
  it("erro da BD não parte a mudança do lead", async () => {
    h.db = { select: () => { throw new Error("BD em baixo"); } };
    expect(await rejectApplicationForLead(lead, 3)).toBeNull();
  });
  it("ligado no lead a lead e no lote; não passa por setApplicationStatus (sem voltas)", () => {
    const l = readFileSync(new URL("./extraLeads.ts", import.meta.url), "utf8");
    expect(l.match(/await rejectApplicationForLead\(/g)?.length).toBe(2);
    const s = readFileSync(new URL("./extraLeadsSync.ts", import.meta.url), "utf8");
    const body = s.slice(s.indexOf("export async function rejectApplicationForLead("), s.indexOf("export async function markLeadConvertedForApplication("));
    expect(body).not.toContain("setApplicationStatus(");
  });
});
