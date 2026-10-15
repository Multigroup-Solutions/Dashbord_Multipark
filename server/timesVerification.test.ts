/**
 * Plano MPV (F8, §7) — "os tempos estão péssimos — é verdade?": a verificação
 * dos tempos (só o super admin, só leitura):
 *  - amostra de 30 reprodutível e repartida pelas cidades;
 *  - tabela × ficha da reserva (History) e tabela × Zello;
 *  - medianas por condutor com n (a quem pertence cada tempo);
 *  - cobertura por cidade e semana com o portão;
 *  - o relatório junta tudo, uma só leitura da History, e exporta em Markdown e CSV.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VERIFY_SAMPLE_SIZE, compareWithBooking, compareWithZello, driverMedians, pickVerificationSample, timesVerificationCsv, timesVerificationMarkdown,
  type TvSampleSource,
} from "../shared/timesVerification";
import { coverageRowOf, runTimesVerification, type VerifyDeps } from "./timesVerification";
import { buildServiceBookingsHistorySql } from "./multiparkDb/serviceRows";
import { assertReadOnlySql } from "./multiparkDb/client";
import type { ServiceEvent } from "../shared/serviceTimes";

const T0 = Date.parse("2026-10-15T10:00:00Z");
const MIN = 60_000;

const src = (over: Partial<TvSampleSource> = {}): TvSampleSource => ({
  bookingId: "b1", bookingCode: "MP-1", cityKey: "lisboa", opDay: "2026-10-15", terminalClass: "t1", startSource: "pendente",
  requestAt: T0, startedAt: T0 + 5 * MIN, arrivedAt: T0 + 20 * MIN, arrivedSource: "gps_zona", deliveredAt: T0 + 30 * MIN,
  queueMs: 5 * MIN, queueStatus: "medido", transitMs: 15 * MIN, transitStatus: "medido", customerMs: 10 * MIN, customerStatus: "medido", totalMs: 30 * MIN,
  startEmployeeId: 11, zelloUsername: "pda 12", gpsPoints: 40, gpsMaxGapS: 60, gpsPass: "final", anchorKey: "b1|h1", ...over,
});

describe("F8 — a amostra", () => {
  const rows = [
    ...Array.from({ length: 80 }, (_, i) => ({ anchorKey: `L${i}`, cityKey: "lisboa" })),
    ...Array.from({ length: 15 }, (_, i) => ({ anchorKey: `P${i}`, cityKey: "porto" })),
    ...Array.from({ length: 3 }, (_, i) => ({ anchorKey: `F${i}`, cityKey: "faro" })),
  ];
  it("30, sempre as mesmas para a mesma semente, com todas as cidades (mínimo 5 se as houver)", () => {
    const a = pickVerificationSample(rows, VERIFY_SAMPLE_SIZE, "2026-10-01|2026-10-12");
    expect(a).toHaveLength(30);
    expect(pickVerificationSample(rows, 30, "2026-10-01|2026-10-12")).toEqual(a);
    expect(pickVerificationSample(rows, 30, "outra")).not.toEqual(a);
    const n = (c: string) => a.filter((x) => x.cityKey === c).length;
    expect(n("faro")).toBe(3);
    expect(n("porto")).toBeGreaterThanOrEqual(5);
    expect(n("lisboa")).toBeGreaterThan(n("porto"));
    expect(new Set(a.map((x) => x.anchorKey)).size).toBe(30);
    expect(pickVerificationSample(rows.slice(0, 4), 30, "s")).toHaveLength(4);
    expect(pickVerificationSample([], 30, "s")).toEqual([]);
  });
});

describe("F8 — tabela × ficha da reserva e × Zello", () => {
  it("ficha: bate até 1 min; difere com o que mudou; sem entrega; não deu para ler", () => {
    const live = [{ kind: "entrega", requestAt: T0, startedAt: T0 + 5 * MIN + 20_000, deliveredAt: T0 + 30 * MIN }, { kind: "recolha", deliveredAt: null }];
    expect(compareWithBooking(src(), live)).toMatchObject({ status: "bate", startDeltaMin: -0.3 });
    const off = compareWithBooking(src(), [{ kind: "entrega", requestAt: T0 - 7 * MIN, startedAt: T0 + 5 * MIN, deliveredAt: T0 + 31 * MIN }]);
    expect(off.status).toBe("difere");
    expect(off.note).toMatch(/pendente \+7 min/);
    expect(compareWithBooking(src(), [{ kind: "entrega", requestAt: T0, startedAt: T0, deliveredAt: T0 + 3 * 3_600_000 }]).status).toBe("sem_ciclo");
    expect(compareWithBooking(src(), null).status).toBe("falhou");
    expect(compareWithBooking(src({ requestAt: null }), [{ kind: "entrega", requestAt: T0, startedAt: T0 + 5 * MIN, deliveredAt: T0 + 30 * MIN }]).note).toMatch(/a ficha tem pendente/);
  });

  it("Zello: bate com pontos a cobrir a viagem e a chegada; GPS fraco com buraco, poucos pontos ou longe da chegada", () => {
    const pts = (from: number, to: number, everyS: number) => Array.from({ length: Math.floor((to - from) / (everyS * 1000)) + 1 }, (_, i) => ({ ts: (from + i * everyS * 1000) / 1000, lat: 38.7, lon: -9.1, accurate: true }));
    expect(compareWithZello(src(), { status: "ok", points: pts(T0 + 4 * MIN, T0 + 31 * MIN, 30) })).toMatchObject({ status: "bate", maxGapS: 30 });
    const gap = compareWithZello(src(), { status: "ok", points: [...pts(T0 + 4 * MIN, T0 + 8 * MIN, 30), ...pts(T0 + 25 * MIN, T0 + 31 * MIN, 30)] });
    expect(gap.status).toBe("gps_fraco");
    expect(gap.note).toMatch(/buraco de 17 min/);
    expect(gap.nearestArrivalS).toBeGreaterThan(120);
    expect(compareWithZello(src(), { status: "ok", points: pts(T0 + 4 * MIN, T0 + 5 * MIN, 30) }).note).toMatch(/não chega à chegada/);
    expect(compareWithZello(src({ zelloUsername: null }), null).status).toBe("sem_zello");
    expect(compareWithZello(src(), { status: "missing" }).status).toBe("sem_ficheiro");
    expect(compareWithZello(src(), { status: "failed", reason: "prazo" }).note).toMatch(/sem tempo/);
    expect(compareWithZello(src(), null).status).toBe("nao_lido");
    // Pontos imprecisos não contam.
    expect(compareWithZello(src(), { status: "ok", points: pts(T0 + 4 * MIN, T0 + 31 * MIN, 30).map((p) => ({ ...p, accurate: false })) }).points).toBe(0);
  });
});

describe("F8 — medianas por condutor", () => {
  it("a quem pertence cada tempo (Cliente = quem entregou), com n; sem as canceladas; as da cidade", () => {
    const row = (emp: number, deliver: number, q: number, extra: Record<string, unknown> = {}) => ({
      kind: "entrega", opDay: "2026-10-10", cityKey: "lisboa", terminalClass: "t1", outcome: "entregue", startEmployeeId: emp, deliverEmployeeId: deliver,
      queueMs: q * MIN, queueStatus: "medido", transitMs: 10 * MIN, transitStatus: "medido", ourMs: (q + 10) * MIN, ourStatus: "medido", customerMs: 4 * MIN, customerStatus: "medido", ...extra,
    });
    const rows = [row(1, 2, 5), row(1, 2, 7), row(1, 2, 9), row(2, 1, 20), row(1, 2, 99, { outcome: "cancelado" }), row(3, 3, 1, { transitStatus: "condutor_desconhecido", queueMs: 1 * MIN })];
    const m = driverMedians(rows as any, new Map([[1, "Ana"], [2, "Rui"]]), { minN: 3 });
    const ana = m.rows.find((r) => r.employeeId === 1)!;
    expect(ana).toMatchObject({ name: "Ana", enough: true });
    expect(ana.metrics.fila).toEqual({ n: 3, p50Ms: 7 * MIN });
    expect(ana.metrics.cliente.n).toBe(1);
    expect(m.rows.find((r) => r.employeeId === 2)!.metrics.cliente.n).toBe(3);
    // O "condutor desconhecido" não fica com a Fila (mas entra na da cidade).
    expect(m.rows.find((r) => r.employeeId === 3)?.metrics.fila.n ?? 0).toBe(0);
    expect(m.cities[0]).toMatchObject({ city: "lisboa" });
    expect(m.cities[0].metrics.fila.n).toBe(5);
  });
});

describe("F8 — cobertura com o portão", () => {
  it("abria com ≥ 60 % (GPS + botão) e n ≥ 20; os motivos mais frequentes", () => {
    const w = { city: "porto", week: "2026-10-05", deliveries: 40, withCall: 0, fromPending: 0, gps: 20, button: 5, transitUnmeasured: 15, pickups: 10, pickupWithCall: 0, terminalGps: 4, terminalApp: 0, terminalUnmeasured: 6, noZello: 3, missingZones: 1, gpsPending: 0, reasons: { sem_zello: 3, sem_pontos: 9, sem_zona: 1, a: 1, b: 1 } };
    const r = coverageRowOf(w, { visible: false, minCoveragePct: 60, minN: 20 });
    expect(r).toMatchObject({ gpsPct: 50, measuredPct: 62.5, gateWouldOpen: true, terminalGpsPct: 40 });
    expect(r.topReasons[0]).toEqual({ reason: "sem_pontos", n: 9 });
    expect(r.topReasons).toHaveLength(4);
    expect(coverageRowOf({ ...w, gps: 10 }, { visible: true, minCoveragePct: 60, minN: 20 }).gateWouldOpen).toBe(false);
  });
});

describe("F8 — o relatório", () => {
  const events = (bookingId: string, base: number): ServiceEvent[] => [
    { id: `${bookingId}-1`, bookingId, type: "UPDATE", at: base, agentUserId: null, agentName: null, platform: null, lat: null, lng: null, statusFrom: "parked", statusTo: "pending_checkout" } as any,
  ];
  const deps = (o: { historyFails?: boolean } = {}) => {
    const calls = { history: 0, historyIds: [] as string[], gps: 0 };
    const d: VerifyDeps = {
      now: () => T0,
      serviceRows: async () => ({ rows: [], truncated: false }),
      settings: async () => ({ gate: { visible: false, minCoveragePct: 60, minN: 20 }, roles: [] }),
      sampleRows: async () => Array.from({ length: 40 }, (_, i) => src({ bookingId: `b${i}`, anchorKey: `b${i}|h`, cityKey: i % 4 === 0 ? "porto" : "lisboa", startEmployeeId: 11 })),
      history: async (ids) => { calls.history++; calls.historyIds = ids; if (o.historyFails) throw new Error("A base de dados da Multipark não respondeu."); return ids.flatMap((id) => events(id, T0)); },
      gps: async (req) => { calls.gps++; return new Map(req.map((r) => [`${r.zello.trim().toLowerCase()}|${r.day}`, { status: "missing" } as const])); },
      names: async () => new Map([[11, "Ana Silva"]]),
    };
    return { d, calls };
  };

  it("30 entregas, UMA leitura da History, o Zello e os nomes; exporta Markdown e CSV", async () => {
    const { d, calls } = deps();
    const r = await runTimesVerification({ today: "2026-10-18", cityKeys: null }, d);
    expect(r.sample.items).toHaveLength(30);
    expect(r.sample.available).toBe(40);
    expect(r.sample).toMatchObject({ fromDay: "2026-10-02", toDay: "2026-10-15" });
    expect(calls.history).toBe(1);
    expect(calls.historyIds).toHaveLength(30);
    expect(calls.gps).toBe(1);
    expect(r.sample.items[0].driverName).toBe("Ana Silva");
    expect(r.sample.zelloCounts.sem_ficheiro).toBe(30);
    expect(r.sample.bookingCounts.bate + r.sample.bookingCounts.difere + r.sample.bookingCounts.sem_ciclo).toBe(30);
    const md = timesVerificationMarkdown(r, { probeSummary: "RESUMO DA SONDA" });
    expect(md).toContain("## 1. Cobertura do GPS");
    expect(md).toContain("## 2. Amostra de 30 entregas");
    expect(md).toContain("## 3. Medianas por condutor");
    expect(md).toContain("RESUMO DA SONDA");
    expect(timesVerificationMarkdown(r)).toContain("Diagnóstico dos tempos");
    const csv = timesVerificationCsv(r, "amostra").split("\n");
    expect(csv).toHaveLength(31);
    expect(csv[0]).toContain("ficha_delta_entrega_min");
    expect(timesVerificationCsv(r, "condutores").split("\n")[0]).toContain("transito_n");
    expect(timesVerificationCsv(r, "cobertura").split("\n")[0]).toContain("portao_abria");
  });

  it("a History falha → a ficha fica \"não deu para ler\" com o motivo (o resto sai na mesma)", async () => {
    const { d } = deps({ historyFails: true });
    const r = await runTimesVerification({ today: "2026-10-18", cityKeys: ["lisboa"] }, d);
    expect(r.sample.bookingReadFailed).toMatch(/não respondeu/);
    expect(r.sample.bookingCounts.falhou).toBe(30);
  });

  it("a leitura da History é só de leitura, só destas reservas, numa janela; o procedimento é só do super admin", () => {
    const q = buildServiceBookingsHistorySql(["a", "b"], { fromUtc: "2026-10-01 00:00:00", toUtc: "2026-10-16 00:00:00" });
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toMatch(/h\."bookingId" IN \(\$1, \$2\)/);
    expect(q.params.slice(0, 4)).toEqual(["a", "b", "2026-10-01 00:00:00", "2026-10-16 00:00:00"]);
    const router = readFileSync(resolve(__dirname, "sondaTemposRouter.ts"), "utf8");
    expect(router).toMatch(/timesVerification: superOnly/);
    const mod = readFileSync(resolve(__dirname, "timesVerification.ts"), "utf8");
    expect(mod).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|service_times|FROM)/);
  });
});
