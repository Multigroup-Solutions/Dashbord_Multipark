/**
 * Plano 63, passo 11 — Extras-Dia: quem avisou "não vou estar" ANTES de ser
 * escalado fica com a falta sem pontos; quem avisou DEPOIS fica com a falta
 * normal (1 ponto). Só com FERIAS_MAPA ligado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({ rows: [] as any[], leaves: [] as any[], inserted: [] as any[], people: [] as any[] }));

vi.mock("./db", async (original) => {
  const { extrasDiaAssignments, employeePenalties, employees } = await import("../drizzle/schema");
  const dialect = new MySqlDialect();
  const db = {
    execute: async (q: any) => {
      const t = dialect.sqlToQuery(q).sql;
      if (t.includes("FROM employee_leaves")) return [state.leaves];
      return [[]];
    },
    select: () => ({
      from: (table: any) => ({
        // plano 63 (2b): o posto e o contrato de quem falta (extra 1 ponto, funcionário 0)
        where: () => (table === extrasDiaAssignments ? Promise.resolve(state.rows) : table === employees ? Promise.resolve(state.people) : { limit: async () => [] }),
      }),
    }),
    insert: (table: any) => ({
      values: async (v: any) => {
        if (table !== employeePenalties) throw new Error("tabela inesperada");
        state.inserted.push(v);
      },
    }),
  };
  return { ...(await original<object>()), getDb: async () => db };
});
vi.mock("./personIdentity", () => ({ agentIdsOfEmployee: async () => ({ agentUserIds: [] }) }));

import { detectExtraDiaNoShows } from "./rhService";
import { isNoticeNoShow } from "../shared/leaves";

const row = (o: Record<string, unknown> = {}) => ({ id: 10, employeeId: 5, personName: "Zé Extra", startHour: 9, endHour: 17, city: "lisbon", status: "confirmed", sentHomeHour: null, createdAt: "2026-11-01 10:00:00", ...o });
const aviso = (o: Record<string, unknown> = {}) => ({ employeeId: 5, leaveType: "unavailable", status: "approved", fromDate: "2026-11-02", toDate: "2026-11-02", hours: null, requestedAt: "2026-10-30 08:00:00", createdAt: "2026-10-30 08:00:00", ...o });

beforeEach(() => { state.rows = [row()]; state.leaves = []; state.inserted = []; state.people = [{ id: 5, position: "extra", contractType: "extra" }]; process.env.FERIAS_MAPA = "on"; });
afterEach(() => { delete process.env.FERIAS_MAPA; });

describe("falta ao Extras-Dia de quem avisou que não estava", () => {
  it("avisou ANTES de ser escalado → falta sem pontos, com a nota", async () => {
    state.leaves = [aviso()];
    const r = await detectExtraDiaNoShows("2026-11-02");
    expect(r.created).toBe(1);
    expect(state.inserted[0]).toMatchObject({ employeeId: 5, reason: "no_show_extra_dia", points: 0, status: "pending" });
    expect(state.inserted[0].notes).toContain("tinha avisado a 30/10 que não estava (antes de ser escalado): sem pontos");
    // (decisão 3) esta falta fica marcada como "de quem avisou": não conta para a ordem da proposta
    expect(isNoticeNoShow(state.inserted[0])).toBe(true);
  });
  it("avisou DEPOIS de ser escalado → falta normal (1 ponto)", async () => {
    state.leaves = [aviso({ requestedAt: "2026-11-01 12:00:00", createdAt: "2026-11-01 12:00:00" })];
    await detectExtraDiaNoShows("2026-11-02");
    expect(state.inserted[0]).toMatchObject({ points: 1 });
    expect(state.inserted[0].notes).not.toContain("tinha avisado");
  });
  it("sem aviso → como sempre (1 ponto)", async () => {
    await detectExtraDiaNoShows("2026-11-02");
    expect(state.inserted[0]).toMatchObject({ points: 1 });
  });
  it("com o mapa de férias desligado nada muda (1 ponto)", async () => {
    delete process.env.FERIAS_MAPA;
    state.leaves = [aviso()];
    await detectExtraDiaNoShows("2026-11-02");
    expect(state.inserted[0]).toMatchObject({ points: 1 });
  });
  it("(decisão 2) conta desde que ESTA pessoa foi posta NESTE dia: linha antiga, pessoa trocada depois do aviso → sem pontos", async () => {
    // a linha existia desde 1/10 (com outra pessoa); o Zé avisou a 30/10 e foi posto nela a 1/11
    state.rows = [row({ createdAt: "2026-10-01 10:00:00", personAssignedAt: "2026-11-01 10:00:00" })];
    state.leaves = [aviso()];
    await detectExtraDiaNoShows("2026-11-02");
    expect(state.inserted[0]).toMatchObject({ points: 0 });
    expect(state.inserted[0].notes).toContain("tinha avisado a 30/10");
  });
  it("(decisão 2) posto a 20/10, avisou a 30/10 → depois de escalado → falta normal (mesmo com a linha mais antiga)", async () => {
    state.rows = [row({ createdAt: "2026-10-01 10:00:00", personAssignedAt: "2026-10-20 10:00:00" })];
    state.leaves = [aviso()];
    await detectExtraDiaNoShows("2026-11-02");
    expect(state.inserted[0]).toMatchObject({ points: 1 });
    expect(isNoticeNoShow(state.inserted[0])).toBe(false);
  });
  it("(decisão 2) linhas antigas sem a hora da pessoa usam a criação da linha (como antes)", async () => {
    state.rows = [row({ createdAt: "2026-11-01 10:00:00", personAssignedAt: null })];
    state.leaves = [aviso()];
    await detectExtraDiaNoShows("2026-11-02");
    expect(state.inserted[0]).toMatchObject({ points: 0 });
  });
  it("(decisão 2) com o mapa desligado a hora da pessoa não muda nada (1 ponto)", async () => {
    delete process.env.FERIAS_MAPA;
    state.rows = [row({ createdAt: "2026-10-01 10:00:00", personAssignedAt: "2026-11-01 10:00:00" })];
    state.leaves = [aviso()];
    await detectExtraDiaNoShows("2026-11-02");
    expect(state.inserted[0]).toMatchObject({ points: 1 });
  });
  it("férias aprovadas antes de ser escalado (funcionário escalado) também tiram os pontos", async () => {
    state.people = [{ id: 5, position: "driver", contractType: "permanent" }];
    state.leaves = [aviso({ leaveType: "vacation", fromDate: "2026-11-01", toDate: "2026-11-06" })];
    await detectExtraDiaNoShows("2026-11-02");
    expect(state.inserted[0]).toMatchObject({ points: 0 });
    // com o 2b o funcionário já ficava com 0: a nota diz que foi pelo aviso (não "funcionário: sem pontos")
    expect(state.inserted[0].notes).toContain("tinha avisado a 30/10");
    expect(state.inserted[0].notes).not.toContain("funcionário: sem pontos");
  });
});
