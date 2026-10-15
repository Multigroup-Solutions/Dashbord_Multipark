/**
 * Auditoria do #389 — as leituras grandes da tabela dos tempos:
 *  4. ORDER BY opDay DESC (se o teto cortar, perdem-se os dias mais antigos,
 *     nunca os de hoje), `truncated` até ao ecrã, só as colunas precisas e,
 *     nos tempos por condutor, a cache guarda o resultado (não as linhas);
 *  6. a cache da Pressão leva o portão e a meta na chave (fechar o portão vale logo);
 *  7. dayServiceRows sem cidades ou com um dia futuro: nada a ler nem a calcular.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queries: [] as string[],
  /** linhas que a "BD" devolve (já pela ordem do SQL: dias mais recentes primeiro) */
  result: [] as Record<string, unknown>[],
  cities: [] as string[],
  gate: { visible: true, minCoveragePct: 0, minN: 1 } as { visible: boolean; minCoveragePct: number; minN: number },
}));

vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({
    execute: async (q: any) => {
      const text = JSON.stringify(q?.queryChunks ?? q);
      state.queries.push(text);
      if (text.includes("SELECT DISTINCT cityKey")) return [state.cities.map((c) => ({ cityKey: c }))];
      if (text.includes("SELECT id, fullName")) return [[]];
      return [state.result];
    },
  }),
}));
vi.mock("./appSettings", async (original) => ({
  ...(await original<object>()),
  getSetting: async (key: string) => (key === "serviceTimes.gpsGate" ? state.gate : null),
}));

import { DRIVER_ROW_COLUMNS, GRID_ROW_COLUMNS, clearServiceLiveCache, dayServiceRows, loadServiceRowsInfo } from "./serviceTimesRead";
import { clearDriverTimesCache, getDriverTimes } from "./driverTimes";
import { clearPressureTimesCache, getPressureTimes } from "./serviceTimesViews";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const dbRow = (opDay: string, id: number, o: Record<string, unknown> = {}) => ({
  id, opDay, kind: "entrega", bookingId: `b${id}`, cityKey: "lisboa", terminalClass: "t1", outcome: "entregue", refHour: 10,
  queueMs: 300_000, queueStatus: "medido", transitMs: 600_000, transitStatus: "medido", ourMs: 900_000, ourStatus: "medido",
  customerMs: 120_000, customerStatus: "medido", totalMs: 1_020_000, startEmployeeId: 7, ...o,
});

beforeEach(() => {
  state.queries = []; state.result = []; state.cities = []; state.gate = { visible: true, minCoveragePct: 0, minN: 1 };
  clearServiceLiveCache(); clearDriverTimesCache(); clearPressureTimesCache();
});

describe("4 — os dias mais recentes primeiro, com o aviso do corte", () => {
  it("o SQL lê do mais recente para trás (opDay DESC) e pede uma linha a mais", async () => {
    await loadServiceRowsInfo({ fromDay: "2026-04-01", toDay: "2026-10-13", cityKeys: ["lisboa"], limit: 3 });
    expect(state.queries[0]).toContain("ORDER BY opDay DESC, id DESC LIMIT ");
    expect(state.queries[0]).toMatch(/LIMIT "\]\},\{[^]*?"queryChunks":\[\{"value":\["4"\]\}\]/);
    expect(src("server/serviceTimesRead.ts")).not.toContain("ORDER BY opDay, id LIMIT");
  });
  it("cortado: ficam os dias mais recentes, por ordem crescente, e truncated = true", async () => {
    state.result = [dbRow("2026-10-13", 9), dbRow("2026-10-12", 8), dbRow("2026-10-11", 7), dbRow("2026-10-10", 6)];
    const r = await loadServiceRowsInfo({ fromDay: "2026-10-01", toDay: "2026-10-13", cityKeys: ["lisboa"], limit: 3 });
    expect(r.truncated).toBe(true);
    expect(r.rows.map((x) => x.opDay)).toEqual(["2026-10-11", "2026-10-12", "2026-10-13"]);
  });
  it("sem corte: truncated = false", async () => {
    state.result = [dbRow("2026-10-13", 2), dbRow("2026-10-12", 1)];
    const r = await loadServiceRowsInfo({ fromDay: "2026-10-01", toDay: "2026-10-13", cityKeys: null, limit: 3 });
    expect(r).toMatchObject({ truncated: false });
    expect(r.rows.map((x) => x.opDay)).toEqual(["2026-10-12", "2026-10-13"]);
  });
  it("só as colunas pedidas (as contas por condutor não leem instantes, garagens nem notas)", async () => {
    await loadServiceRowsInfo({ fromDay: "2026-10-01", toDay: "2026-10-13", cityKeys: null, columns: DRIVER_ROW_COLUMNS });
    const q = state.queries[0];
    expect(q).toContain("startEmployeeId");
    for (const c of ["requestAt", "deliveredAt", "firstGarage", "flags", "paramsHash", "bookingCode"]) expect(q, c).not.toContain(c);
    expect(GRID_ROW_COLUMNS).toContain("refHour");
    expect(GRID_ROW_COLUMNS).not.toContain("startEmployeeId");
  });
  it("tempos por condutor: uma leitura por cidade; a cache guarda o resultado (não as linhas) e leva o portão na chave", async () => {
    state.cities = ["lisboa", "porto"];
    state.result = [dbRow("2026-10-13", 1)];
    const a = await getDriverTimes({ employeeId: 7, refDay: "2026-10-13", cityKeys: null, isSuperAdmin: false });
    const reads = () => state.queries.filter((q) => q.includes("FROM service_times") && !q.includes("DISTINCT")).length;
    expect(reads()).toBe(2);
    expect(a).toMatchObject({ available: true, truncated: false });
    await getDriverTimes({ employeeId: 7, refDay: "2026-10-13", cityKeys: null, isSuperAdmin: false });
    expect(reads()).toBe(2); // da cache
    state.gate = { visible: false, minCoveragePct: 60, minN: 20 };
    await getDriverTimes({ employeeId: 7, refDay: "2026-10-13", cityKeys: null, isSuperAdmin: false });
    expect(reads()).toBe(4); // portão mudou: conta outra vez
    const f = src("server/driverTimes.ts");
    expect(f).toContain("value: DriverTimesResult");
    expect(f).not.toMatch(/cache\.set\(key, \{ at: Date\.now\(\), rows/);
  });
});

describe("6 — Pressão: fechar o portão vale logo (a chave da cache leva o portão e a meta)", () => {
  it("aberto mostra o Trânsito; fechado a seguir, o admin já não o recebe", async () => {
    state.result = Array.from({ length: 30 }, (_, i) => dbRow("2026-10-13", i + 1));
    const open = await getPressureTimes({ from: "2026-10-07", to: "2026-10-13", cityKeys: ["lisboa"], isSuperAdmin: false });
    const g1 = Object.values(open.groups)[0];
    expect(g1.hidden.transito).toBeUndefined();
    state.gate = { visible: false, minCoveragePct: 60, minN: 20 };
    const closed = await getPressureTimes({ from: "2026-10-07", to: "2026-10-13", cityKeys: ["lisboa"], isSuperAdmin: false });
    expect(Object.values(closed.groups)[0].hidden.transito).toBe("Em calibração");
    expect(closed.truncated).toBe(false);
  });
});

describe("7 — dayServiceRows: sem cidades ou dia futuro, nada a ler nem a calcular", () => {
  it("sem cidades no âmbito: nem a tabela, nem o cálculo ao vivo", async () => {
    const compute = vi.fn();
    const r = await dayServiceRows("2026-10-13", { cityKeys: [], nowMs: Date.parse("2026-10-14T10:00:00Z"), compute });
    expect(r).toMatchObject({ source: "tabela", rows: [], reason: "sem cidades no teu acesso" });
    expect(compute).not.toHaveBeenCalled();
    expect(state.queries).toHaveLength(0);
  });
  it("um dia que ainda não começou: nada", async () => {
    const compute = vi.fn();
    const r = await dayServiceRows("2026-10-20", { cityKeys: null, nowMs: Date.parse("2026-10-14T10:00:00Z"), compute });
    expect(r).toMatchObject({ source: "tabela", rows: [], reason: "o dia ainda não começou" });
    expect(compute).not.toHaveBeenCalled();
    expect(state.queries).toHaveLength(0);
  });
  it("hoje continua a calcular ao vivo quando a tabela está vazia", async () => {
    const compute = vi.fn(async () => ({ ok: true as const, rows: [], truncated: false }));
    const r = await dayServiceRows("2026-10-14", { cityKeys: null, nowMs: Date.parse("2026-10-14T10:00:00Z"), compute });
    expect(r.source).toBe("ao_vivo");
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
