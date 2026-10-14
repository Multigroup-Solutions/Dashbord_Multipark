import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// Plano 62, P0: o diagnóstico dos tempos é SÓ do super admin e só lê.

const f = vi.hoisted(() => ({ load: vi.fn(), run: vi.fn(), sql: [] as string[] }));
vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: f.load }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({ execute: async (q: any) => { try { f.sql.push(new MySqlDialect().sqlToQuery(q).sql); } catch { /* não é SQL do drizzle */ } return [[]]; } }),
  getUserPermissionOverrides: async () => ({}),
}));
vi.mock("./sondaTempos", async (original) => ({ ...(await original<object>()), runTimesProbe: f.run }));

import { appRouter } from "./routers";
import { canRunTimesProbe } from "./sondaTemposRouter";

const caller = (role: string) => appRouter.createCaller({ user: { id: 7, role }, req: { headers: {} }, res: {} } as any);
const input = { day: "2026-10-10", cities: ["lisbon" as const] };

beforeEach(() => {
  vi.clearAllMocks();
  f.sql = [];
  f.load.mockResolvedValue({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false });
  f.run.mockResolvedValue({ day: "2026-10-10", cities: ["lisbon"], results: {}, elapsedMs: 1, truncated: false, failures: [] });
});

describe("extrasDia.timesProbe — quem pode", () => {
  it("regra pura: só o super admin", () => {
    expect(canRunTimesProbe({ role: "super_admin" })).toBe(true);
    for (const role of ["admin", "supervisor", "backoffice", "frontoffice", "team_leader", "condutor", "extra", "user"]) expect(canRunTimesProbe({ role })).toBe(false);
    expect(canRunTimesProbe(null)).toBe(false);
  });
  it("os outros papéis recebem FORBIDDEN e nada é lido", async () => {
    for (const role of ["admin", "supervisor", "backoffice", "team_leader"]) {
      await expect(caller(role).extrasDia.timesProbe(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(f.run).not.toHaveBeenCalled();
  });
  it("o super admin corre (um dia, as cidades pedidas)", async () => {
    const r = await caller("super_admin").extrasDia.timesProbe(input);
    expect(r.day).toBe("2026-10-10");
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0][0]).toEqual(input);
  });
  it("entrada inválida (mais de um dia, cidade desconhecida) é recusada", async () => {
    await expect(caller("super_admin").extrasDia.timesProbe({ day: "2026-10-10..2026-10-12", cities: ["lisbon"] } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller("super_admin").extrasDia.timesProbe({ day: "2026-10-10", cities: ["madrid"] } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.run).not.toHaveBeenCalled();
  });
});

describe("leituras à nossa BD: só SELECT", () => {
  it("chamadas, CRM e Histórico Diário não escrevem nada", async () => {
    const { defaultProbeDeps } = await vi.importActual<typeof import("./sondaTempos")>("./sondaTempos");
    const deps = defaultProbeDeps();
    await deps.calls("2026-10-10 00:00:00", "2026-10-12 00:00:00");
    await deps.crmPhones(["b1", "b2"]);
    await deps.gpsRows(["2026-10-10", "2026-10-11"]);
    expect(f.sql.length).toBe(4);
    for (const s of f.sql) {
      expect(s.trim()).toMatch(/^SELECT\b/i);
      expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE)\b/i);
    }
    // Q1: só as RECEBIDAS (atendidas e perdidas, consola e WhatsApp); as que fazemos nós não contam
    expect(f.sql[0]).toMatch(/FROM central_calls WHERE direction = 'in'/);
    expect(f.sql[0]).not.toMatch(/\bheld\s*=/);
    expect(f.sql[1]).toMatch(/FROM whatsapp_calls WHERE direction = 'in'/);
    expect(f.sql[1]).not.toMatch(/\bmissed\s*=/);
  });
});
