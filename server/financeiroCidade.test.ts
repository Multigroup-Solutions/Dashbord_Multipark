import { beforeEach, describe, expect, it, vi } from "vitest";

// FM02 (P1, 1 out 2026): sem centro escolhido, o motor financeiro e o caixa
// somavam TUDO (nacional) mesmo a quem só vê a sua cidade (ex.: um supervisor
// com "ver totais financeiros"). Agora vale o alcance de cidade do pedido.

const state = vi.hoisted(() => ({ seen: [] as Array<number[] | null | undefined> }));

vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({
    select: () => ({ from: async () => [
      { id: 48, name: "Multipark", parentId: null, level: "group" },
      { id: 50, name: "Porto", parentId: 48, level: "city" },
      { id: 65, name: "Parque Porto", parentId: 50, level: "project" },
    ] }),
  }),
  resolveProjectIds: async (id: number) => (id === 50 ? [50, 65] : [id]),
}));
vi.mock("./finance/rates", async (original) => ({
  ...(await original<object>()),
  resolveFinanceRates: async () => ({ rates: { vatOn: () => 0.23, tsuOn: () => 0.2375 }, vatAtEnd: 0.23, tsuAtEnd: 0.2375, vatPeriods: [], tsuPeriods: [] }),
}));
// Sentinela: a primeira leitura (reservas ao vivo) regista os centros e pára o cálculo.
vi.mock("./finance/liveBookings", async (original) => ({
  ...(await original<object>()),
  loadLiveBookingAgg: async (_kind: string, _range: unknown, projectIds?: number[] | null) => {
    state.seen.push(projectIds);
    throw new Error("STOP");
  },
}));

import { cityScope } from "./cityScope";
import { computeFinance } from "./finance/engine";
import { computeCash } from "./finance/cash";
import { financeProjectIds } from "./finance/scope";

const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false } as any;
const nowhere = { ...porto, cityIds: [], projectIds: [] } as any;
const period = { from: "2026-09-01", to: "2026-09-30", today: "2026-10-01" };

beforeEach(() => { state.seen = []; });

describe("financeProjectIds", () => {
  it("com centro: esse centro e descendentes; sem centro: o alcance do pedido; sem pedido/nacional: tudo", async () => {
    expect(await financeProjectIds(50)).toEqual([50, 65]);
    expect(await cityScope.run(porto, () => financeProjectIds())).toEqual([50, 65]);
    expect(await financeProjectIds()).toBeUndefined();
    expect(await cityScope.run({ ...porto, all: true }, () => financeProjectIds())).toBeUndefined();
  });
});

describe("motor financeiro e caixa respeitam a cidade sem centro escolhido", () => {
  it("computeFinance sem projectId, pedido do Porto → só os centros do Porto (antes: tudo)", async () => {
    await expect(cityScope.run(porto, () => computeFinance(period))).rejects.toThrow("STOP");
    expect(state.seen[0]).toEqual([50, 65]);
  });

  it("computeFinance sem pedido (crons, relatórios) → nacional, como antes", async () => {
    await expect(computeFinance(period)).rejects.toThrow("STOP");
    expect(state.seen[0]).toBeUndefined();
  });

  it("alcance sem nenhum centro → resultado vazio, sem ler nada", async () => {
    const r = await cityScope.run(nowhere, () => computeFinance(period));
    expect(state.seen).toHaveLength(0);
    expect(r.revenue.produced).toBe(0);
    expect(r.scope.projectIds).toEqual([]);
  });

  it("computeCash sem projectId, pedido do Porto → só os centros do Porto", async () => {
    await expect(cityScope.run(porto, () => computeCash(period))).rejects.toThrow("STOP");
    expect(state.seen.every((ids) => JSON.stringify(ids) === "[50,65]")).toBe(true);
  });
});
