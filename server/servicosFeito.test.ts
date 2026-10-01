import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// P1 (1 out 2026): "Feito" na página Serviços
//  - não fechava a tarefa gerada pelo serviço (ficava aberta, também no Google);
//  - não confirmava que a linha era da reserva: com a reserva de cá e a linha
//    de outra cidade, marcava-se (e "mudava-se") o serviço de outra reserva.

const state = vi.hoisted(() => ({
  lineBooking: "bk1" as string | null,
  sql: [] as string[],
  closed: [] as Array<[string, string, number]>,
  access: null as any,
}));

vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: async () => state.access }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getDb: async () => ({
    execute: async (q: any) => { state.sql.push(new MySqlDialect().sqlToQuery(q).sql); return [[]]; },
  }),
  logActivity: async () => undefined,
}));
vi.mock("./multiparkDb/serviceExtras", async (original) => ({
  ...(await original<object>()),
  serviceLineBookingId: async () => state.lineBooking,
}));
vi.mock("./multiparkDb/bookingSearch", async (original) => ({
  ...(await original<object>()),
  liveBookingByRef: async (ref: string) => (ref === "bk1" ? { id: "bk1" } : null),
}));
vi.mock("./serviceTasks", async (original) => ({
  ...(await original<object>()),
  closeServiceTaskForLine: async (b: string, l: string, u: number) => { state.closed.push([b, l, u]); return 1; },
}));

import { appRouter } from "./routers";

const caller = () => appRouter.createCaller({ user: { id: 77, role: "admin" }, req: { headers: {} }, res: {} } as any);
const national = { all: true, defaultCityId: null, cityName: null, cityIds: [], projectIds: [], missingCostCenter: false };
const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false };

beforeEach(() => {
  state.lineBooking = "bk1";
  state.sql = [];
  state.closed = [];
  state.access = national;
});

describe("services.setExtraDone", () => {
  it("linha de OUTRA reserva → recusa, sem gravar nem fechar nada", async () => {
    state.lineBooking = "bk-de-faro";
    await expect(caller().services.setExtraDone({ bookingId: "bk1", lineId: "l9", done: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.sql).toHaveLength(0);
    expect(state.closed).toHaveLength(0);
  });

  it("linha que não existe → recusa", async () => {
    state.lineBooking = null;
    await expect(caller().services.setExtraDone({ bookingId: "bk1", lineId: "l9", done: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.sql).toHaveLength(0);
  });

  it("Feito → grava e fecha a tarefa desta linha, em nome de quem marcou", async () => {
    const r = await caller().services.setExtraDone({ bookingId: "bk1", lineId: "l1", done: true });
    expect(r).toEqual({ success: true, tasksClosed: 1 });
    expect(state.sql.some((s) => s.includes("INSERT INTO service_extra_done"))).toBe(true);
    expect(state.closed).toEqual([["bk1", "l1", 77]]);
  });

  it("reabrir → grava, não mexe na tarefa", async () => {
    const r = await caller().services.setExtraDone({ bookingId: "bk1", lineId: "l1", done: false });
    expect(r).toEqual({ success: true, tasksClosed: 0 });
    expect(state.sql).toHaveLength(1);
    expect(state.closed).toHaveLength(0);
  });

  it("quem só vê a sua cidade: reserva de outra cidade → recusa", async () => {
    state.access = porto;
    state.lineBooking = "bk2";
    await expect(caller().services.setExtraDone({ bookingId: "bk2", lineId: "l1", done: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.sql).toHaveLength(0);
  });
});
