/**
 * Carga na BD da Multipark (auditoria final da fase 3): o cálculo ao vivo dos
 * tempos (tabela vazia — o trabalho noturno está desligado) faz UMA leitura
 * sequencial da History por dia. Tem de ser partilhado (cache por dia),
 * único em simultâneo (o mesmo dia não se lê duas vezes ao mesmo tempo), um
 * de cada vez por instância, com prazo, e as falhas não se repetem a cada
 * clique. A Pressão, a Semana, os tempos por condutor e a cobertura não
 * leem a Multipark.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LIVE_CACHE_OLDER_MS, LIVE_CACHE_TODAY_MS, LIVE_CACHE_YESTERDAY_MS, LIVE_FAILURE_CACHE_MS, LIVE_MIN_BUDGET_MS, LIVE_POOL_WAIT_FAILURE_CACHE_MS,
  clearServiceLiveCache, dayServiceRows, liveCacheTtlMs, serviceLiveStarted, type LiveCompute,
} from "./serviceTimesRead";
import type { ServiceRow } from "./serviceTimesAgg";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const NOW = Date.parse("2026-10-15T14:00:00Z"); // dia operacional 2026-10-15
const row = (cityKey: string): ServiceRow => ({ kind: "entrega", bookingId: `b-${cityKey}`, opDay: "2026-10-15", cityKey, terminalClass: "t1", outcome: "entregue" });

function fakeCompute(o: { delayMs?: number; ok?: boolean } = {}) {
  const calls: string[] = [];
  const compute: LiveCompute = async (date) => {
    calls.push(date);
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    return o.ok === false ? { ok: false, error: "BD da Multipark sem resposta" } : { ok: true, rows: [row("lisboa"), row("porto")], truncated: false };
  };
  return { calls, compute };
}

beforeEach(() => clearServiceLiveCache());
afterEach(() => clearServiceLiveCache());

describe("carga — cache por dia, partilhada por todos", () => {
  it("hoje 5 min, ontem 15 min, os outros 60 min", () => {
    expect(liveCacheTtlMs("2026-10-15", NOW)).toBe(LIVE_CACHE_TODAY_MS);
    expect(liveCacheTtlMs("2026-10-14", NOW)).toBe(LIVE_CACHE_YESTERDAY_MS);
    expect(liveCacheTtlMs("2026-10-01", NOW)).toBe(LIVE_CACHE_OLDER_MS);
    expect([LIVE_CACHE_TODAY_MS, LIVE_CACHE_YESTERDAY_MS, LIVE_CACHE_OLDER_MS]).toEqual([300_000, 900_000, 3_600_000]);
  });
  it("duas pessoas de cidades diferentes: UMA leitura, e cada uma só vê a sua cidade", async () => {
    const f = fakeCompute();
    const a = await dayServiceRows("2026-10-14", { cityKeys: ["lisboa"], compute: f.compute });
    const b = await dayServiceRows("2026-10-14", { cityKeys: ["porto"], compute: f.compute });
    expect(f.calls).toEqual(["2026-10-14"]);
    expect(a.rows.map((r) => r.cityKey)).toEqual(["lisboa"]);
    expect(b.rows.map((r) => r.cityKey)).toEqual(["porto"]);
    expect(a.source).toBe("ao_vivo");
  });
  it("passado o prazo da cache volta a ler; antes não", async () => {
    const f = fakeCompute();
    await dayServiceRows("2026-10-15", { cityKeys: null, compute: f.compute });
    await dayServiceRows("2026-10-15", { cityKeys: null, compute: f.compute, nowMs: Date.now() + LIVE_CACHE_TODAY_MS - 1_000 });
    expect(f.calls).toHaveLength(1);
    await dayServiceRows("2026-10-15", { cityKeys: null, compute: f.compute, nowMs: Date.now() + LIVE_CACHE_OLDER_MS + 1_000 });
    expect(f.calls).toHaveLength(2);
  });
});

describe("carga — nunca duas leituras ao mesmo tempo", () => {
  it("dez pedidos ao mesmo tempo para o mesmo dia = uma leitura", async () => {
    const f = fakeCompute({ delayMs: 30 });
    const all = await Promise.all(Array.from({ length: 10 }, () => dayServiceRows("2026-10-13", { cityKeys: null, compute: f.compute })));
    expect(f.calls).toHaveLength(1);
    expect(serviceLiveStarted()).toBe(1);
    expect(all.every((r) => r.source === "ao_vivo" && r.rows.length === 2)).toBe(true);
  });
  it("outro dia espera pela vez (um cálculo de cada vez por instância)", async () => {
    const order: string[] = [];
    let running = 0, maxRunning = 0;
    const compute: LiveCompute = async (date) => {
      running++; maxRunning = Math.max(maxRunning, running); order.push(`+${date}`);
      await new Promise((r) => setTimeout(r, 40));
      running--; order.push(`-${date}`);
      return { ok: true, rows: [], truncated: false };
    };
    await Promise.all(["2026-10-10", "2026-10-11", "2026-10-12"].map((d) => dayServiceRows(d, { cityKeys: null, compute })));
    expect(maxRunning).toBe(1);
    expect(order).toEqual(["+2026-10-10", "-2026-10-10", "+2026-10-11", "-2026-10-11", "+2026-10-12", "-2026-10-12"]);
  });
  it("sem vez dentro do prazo: indisponível com o motivo, e não lê", async () => {
    const slow = fakeCompute({ delayMs: 200 });
    const first = dayServiceRows("2026-10-10", { cityKeys: null, compute: slow.compute });
    const other = fakeCompute();
    // prazo justo: só sobra o mínimo, não há tempo para esperar a vez
    const r = await dayServiceRows("2026-10-11", { cityKeys: null, compute: other.compute, deadlineMs: LIVE_MIN_BUDGET_MS });
    expect(r.source).toBe("indisponivel");
    expect(r.reason).toMatch(/outro dia/);
    expect(other.calls).toHaveLength(0);
    await first;
  });
  it("prazo do pedido curto de mais: nem começa a leitura", async () => {
    const f = fakeCompute();
    const r = await dayServiceRows("2026-10-12", { cityKeys: null, compute: f.compute, deadlineMs: LIVE_MIN_BUDGET_MS - 1 });
    expect(r).toMatchObject({ source: "indisponivel", rows: [] });
    expect(f.calls).toHaveLength(0);
  });
});

describe("carga — falhas", () => {
  it("sem ligação livre na pool (CONNECT_FAILED): a falha fica só 5 s, não 60 s", async () => {
    expect(LIVE_POOL_WAIT_FAILURE_CACHE_MS).toBe(5_000);
    const calls: string[] = [];
    const compute: LiveCompute = async (date) => { calls.push(date); return { ok: false, error: "Sem ligação à BD da Multipark neste momento.", poolWait: true }; };
    await dayServiceRows("2026-10-09", { cityKeys: null, compute });
    await dayServiceRows("2026-10-09", { cityKeys: null, compute, nowMs: Date.now() + 2_000 });
    expect(calls).toHaveLength(1);
    await dayServiceRows("2026-10-09", { cityKeys: null, compute, nowMs: Date.now() + LIVE_POOL_WAIT_FAILURE_CACHE_MS + 500 });
    expect(calls).toHaveLength(2);
  });
  it("o cálculo ao vivo marca o CONNECT_FAILED como espera na pool (e o resto não)", async () => {
    const { computeServiceRowsLive } = await import("./serviceTimesJob");
    const { MultiparkDbError } = await import("./multiparkDb/client");
    const deps = (code: "CONNECT_FAILED" | "QUERY_FAILED") => ({
      query: async () => { throw new MultiparkDbError("timeout exceeded when trying to connect", code); },
      settings: async () => ({}) as any, now: () => NOW,
    }) as any;
    expect(await computeServiceRowsLive(deps("CONNECT_FAILED"), { from: "2026-10-09", to: "2026-10-09", deadlineAt: NOW + 30_000 })).toMatchObject({ ok: false, poolWait: true });
    expect(await computeServiceRowsLive(deps("QUERY_FAILED"), { from: "2026-10-09", to: "2026-10-09", deadlineAt: NOW + 30_000 })).toMatchObject({ ok: false, poolWait: false });
  });
  it("a Multipark em baixo: a falha fica 60 s (não se insiste a cada clique) e depois tenta outra vez", async () => {
    const f = fakeCompute({ ok: false });
    const a = await dayServiceRows("2026-10-09", { cityKeys: null, compute: f.compute });
    const b = await dayServiceRows("2026-10-09", { cityKeys: null, compute: f.compute });
    expect([a.source, b.source]).toEqual(["indisponivel", "indisponivel"]);
    expect(b.reason).toBe("BD da Multipark sem resposta");
    expect(f.calls).toHaveLength(1);
    await dayServiceRows("2026-10-09", { cityKeys: null, compute: f.compute, nowMs: Date.now() + LIVE_FAILURE_CACHE_MS + 1_000 });
    expect(f.calls).toHaveLength(2);
  });
});

describe("carga — quem lê a Multipark", () => {
  it("só o Resumo do dia, o dia do condutor e a Ficha calculam ao vivo; com o prazo do pedido", () => {
    const dash = src("server/supervisorDay.ts");
    expect(dash).toContain("deadlineMs: SUPERVISOR_DAY_BUDGET_MS - (Date.now() - t0)");
    // a leitura das reclamações dos carros que saíram: só os CHECK_OUT do dia
    expect(dash).toContain('readLiveHistory({ changeTypes: ["CHECK_OUT"], from: start, to: end');
    expect(src("server/shiftDayDetail.ts")).toContain("deadlineMs: DRIVER_DAY_LIVE_BUDGET_MS - (Date.now() - t0)");
    // a Pressão, a Semana, os tempos por condutor e a cobertura: só a nossa tabela
    for (const f of ["server/serviceTimesViews.ts", "server/driverTimes.ts"]) {
      expect(src(f), f).not.toMatch(/dayServiceRows|computeServiceRowsLive|multiparkDbQuery|readLiveHistory/);
    }
    // a Ficha: uma leitura da History DESTA reserva, só quando se abre a secção
    expect(src("server/serviceTimesBooking.ts")).toContain("buildServiceBookingHistorySql(o.bookingId)");
    expect(src("client/src/pages/BookingFilePage.tsx")).toMatch(/bookingFile\.times\.useQuery\(\{ id, \.\.\.scope \}, \{ enabled,/);
  });
});
