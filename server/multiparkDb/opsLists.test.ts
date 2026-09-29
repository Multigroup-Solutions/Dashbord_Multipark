import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { assertReadOnlySql } from "./client";
import { ParamList } from "./read";
import {
  OPS_AGG_LIMIT, OPS_LIST_PAGE_MAX, buildOpsAggSql, buildOpsListSql, buildSource, channelPredicate, getMultiparkOpsList,
  mapAggRow, mapOpsListRow, opsBounds, searchPredicate, statePredicate,
} from "./opsLists";
import {
  OPS_LIST_KINDS, deltaVs, isOpsListState, matchPreset, opsDone, presetRange, previousRange, rangeDays, summarizeOps,
  type OpsAggRow, type OpsListKind, type OpsParkInfo,
} from "../../shared/opsLists";
import { classifyPark } from "../../shared/multiparkParks";

const ENV = "DATABASE_URL_MULTIPARK";
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV]; queryMock.mockReset(); });
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv; });

/** Maior `$n` usado no SQL (tem de bater com o n.º de parâmetros). */
const maxPlaceholder = (sql: string) => Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));

const spec = (kind: OpsListKind, extra: Partial<Parameters<typeof buildSource>[0]> = {}) => ({
  kind, parkIds: ["p1", "p2"], ourParkIds: ["p1"], ...extra,
});

describe("período", () => {
  it("dias inclusive; inválido → 0", () => {
    expect(rangeDays("2026-09-27", "2026-09-27")).toBe(1);
    expect(rangeDays("2026-09-01", "2026-09-30")).toBe(30);
    expect(rangeDays("2026-09-30", "2026-09-01")).toBe(0);
    expect(rangeDays("27/09/2026", "2026-09-30")).toBe(0);
  });
  it("período anterior com a mesma duração", () => {
    expect(previousRange("2026-09-27", "2026-09-27")).toEqual({ from: "2026-09-26", to: "2026-09-26" });
    expect(previousRange("2026-09-01", "2026-09-30")).toEqual({ from: "2026-08-02", to: "2026-08-31" });
  });
  it("atalhos: Hoje, Ontem, Amanhã, 7 dias e Este mês (a partir de hoje em Lisboa)", () => {
    const t = "2026-09-27";
    expect(presetRange("hoje", t)).toEqual({ from: t, to: t });
    expect(presetRange("ontem", t)).toEqual({ from: "2026-09-26", to: "2026-09-26" });
    expect(presetRange("amanha", t)).toEqual({ from: "2026-09-28", to: "2026-09-28" });
    expect(presetRange("7dias", t)).toEqual({ from: "2026-09-21", to: t });
    expect(presetRange("mes", t)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(presetRange("mes", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(matchPreset(t, t, t)).toBe("hoje");
    expect(matchPreset("2026-09-01", "2026-09-30", t)).toBe("mes");
    expect(matchPreset("2026-09-02", "2026-09-30", t)).toBeNull();
  });
  it("limites UTC: verão começa às 23:00 da véspera; o anterior vem junto", () => {
    const b = opsBounds("2026-09-27", "2026-09-27");
    expect(b.start).toBe("2026-09-26 23:00:00");
    expect(b.end).toBe("2026-09-27 23:00:00");
    expect(b.prevStart).toBe("2026-09-25 23:00:00");
    expect(b.prevFrom).toBe("2026-09-26");
    const w = opsBounds("2026-01-01", "2026-01-31");
    expect(w.start).toBe("2026-01-01 00:00:00");
    expect(w.end).toBe("2026-02-01 00:00:00");
    expect(w.prevFrom).toBe("2025-12-01");
  });
  it("máximo 62 dias; período invertido → erro", () => {
    expect(opsBounds("2026-08-01", "2026-10-01").days).toBe(62);
    expect(() => opsBounds("2026-08-01", "2026-10-02")).toThrow(/62/);
    expect(() => opsBounds("2026-09-30", "2026-09-01")).toThrow();
  });
  it("estados válidos por lista", () => {
    expect(isOpsListState("reservas", "cancelled")).toBe(true);
    expect(isOpsListState("entradas", "cancelled")).toBe(false);
    expect(isOpsListState("cancelados", "refund")).toBe(true);
  });
});

describe("SQL (só leitura, parametrizado, com índices)", () => {
  const bounds = opsBounds("2026-09-01", "2026-09-30");

  it("cada lista filtra pela sua data, com o pré-filtro nas colunas indexadas", () => {
    const p = new ParamList();
    const r = buildSource(spec("reservas"), p, bounds.start, bounds.end, true);
    expect(r).toContain(`b."createdAt" >= `);
    expect(r).not.toContain("CANCELLED");

    const e = buildSource(spec("entradas"), new ParamList(), bounds.start, bounds.end, true);
    expect(e).toContain(`b."checkInDate" >= `);
    expect(e).toContain(`b."checkIn" < `);
    expect(e).toContain(`b."status"::text <> `);

    const s = buildSource(spec("saidas"), new ParamList(), bounds.start, bounds.end, true);
    expect(s).toContain(`b."checkOutDate" >= `);

    const c = buildSource(spec("cancelados"), new ParamList(), bounds.start, bounds.end, true);
    expect(c).toContain(`"Cancellation" cx`);
    expect(c).toContain(`cx."createdAt" >= `);
    expect(c).toContain("UNION ALL");
    expect(c).toContain(`b."updatedAt" >= `);
    expect(c).toContain("NOT EXISTS");
  });

  it("pré-filtro com 1 dia de folga de cada lado", () => {
    const p = new ParamList();
    buildSource(spec("entradas"), p, "2026-09-26 23:00:00", "2026-09-27 23:00:00", false);
    expect(p.values).toContain("2026-09-25 23:00:00");
    expect(p.values).toContain("2026-09-28 23:00:00");
  });

  it("valores como parâmetros (nunca no texto); sem parques → erro", () => {
    const p = new ParamList();
    const sql = buildSource(spec("reservas", { parkIds: ["p'; DROP"], ourParkIds: [], search: "O'Brien" }), p, bounds.start, bounds.end, true);
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("O'Brien");
    expect(p.values).toContain("p'; DROP");
    expect(() => buildSource(spec("reservas", { parkIds: [] }), new ParamList(), bounds.start, bounds.end, true)).toThrow();
  });

  it("canal: as mesmas regras do classificador", () => {
    const p = new ParamList();
    const m = channelPredicate("marketplace", ["p1"], p);
    expect(m).toContain(`NOT (b."parkId" IN (`);
    expect(m).toContain(`b."origin"::text = `);
    expect(p.values).toContain("MARKETPLACE");
    const par = channelPredicate("parceiro", ["p1"], new ParamList());
    expect(par).toContain(`NULLIF(b."partnerId", '') IS NOT NULL`);
    expect(par).toContain(`b."paymentSource"`);
    const d = channelPredicate("direto", [], new ParamList());
    expect(d).toContain("NOT (FALSE)");
    expect(d).toContain("AND NOT (NULLIF");
  });

  it("estado por lista", () => {
    expect(statePredicate("reservas", "active", new ParamList(), false)).toContain("<>");
    expect(statePredicate("entradas", "done", new ParamList(), false)).toContain("IN (");
    expect(statePredicate("saidas", "pending", new ParamList(), false)).toContain("<>");
    expect(statePredicate("cancelados", "refund", new ParamList(), true)).toBe(`cx."refund"`);
    expect(statePredicate("cancelados", "refund", new ParamList(), false)).toBe("FALSE");
    expect(statePredicate("reservas", "all", new ParamList(), false)).toBeNull();
  });

  it("pesquisa: n.º, id, nome, email e matrícula sem traços", () => {
    const p = new ParamList();
    const s = searchPredicate(" aa-00-bb ", p);
    expect(s).toContain("regexp_replace");
    expect(p.values).toContain("%AA00BB%");
    expect(p.values).toContain("aa-00-bb");
    const one = new ParamList();
    expect(searchPredicate("a", one)).not.toContain("regexp_replace");
  });

  it("todas as consultas passam a guarda de só-leitura e os $n batem certo", () => {
    for (const kind of OPS_LIST_KINDS) {
      for (const extra of [{}, { search: "MP123", state: "done", channel: "parceiro" as const }]) {
        const a = buildOpsAggSql(spec(kind, extra), bounds);
        const l = buildOpsListSql(spec(kind, extra), bounds, 200, 400);
        for (const q of [a, l]) {
          expect(() => assertReadOnlySql(q.sql)).not.toThrow();
          expect(maxPlaceholder(q.sql)).toBe(q.params.length);
        }
        expect(a.sql).toContain("GROUP BY");
        expect(a.params).toContain(OPS_AGG_LIMIT);
        expect(l.sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
        expect(l.params).toContain(201);
        expect(l.params).toContain(400);
      }
    }
  });

  it("o agregado lê o período anterior junto; sem filtro de canal", () => {
    const a = buildOpsAggSql(spec("reservas", { channel: "direto" }), bounds);
    expect(a.params).toContain(bounds.prevStart);
    expect(a.params).toContain(bounds.start);
    expect(a.sql).not.toContain("MARKETPLACE");
    const l = buildOpsListSql(spec("reservas", { channel: "direto" }), bounds, 50, 0);
    expect(l.params).toContain("MARKETPLACE");
    expect(l.params).not.toContain(bounds.prevStart);
  });

  it("quem cancelou (History) só nos cancelados; teto da página", () => {
    expect(buildOpsListSql(spec("cancelados"), bounds, 10, 0).sql).toContain(`"History" h`);
    expect(buildOpsListSql(spec("reservas"), bounds, 10, 0).sql).not.toContain("History");
    expect(buildOpsListSql(spec("reservas"), bounds, 99_999, 0).params).toContain(OPS_LIST_PAGE_MAX + 1);
    expect(buildOpsAggSql(spec("cancelados"), bounds).sql).toContain(`cx."cancellationType"`);
  });
});

describe("linhas", () => {
  const lisboa = { name: "Airpark Lisboa", cityName: "Lisboa", ...classifyPark({ name: "Airpark", city: "Lisboa" }) };
  it("mapeia a linha com canal, valores e cancelamento", () => {
    const r = mapOpsListRow("cancelados", {
      id: "b1", code: "MP1", status: "CANCELLED", event_at: "2026-09-27 10:00:00", approx_date: false, park_id: "p1",
      client_first_name: "Ana", client_last_name: "Silva", plate: "AA-00-BB", price: "50", paid: "20", partner_id: "pt1",
      partner_name: "Parkos", partner_type: "AGGREGATOR", origin: "API", parking_type: "COVERED",
      cancelled_at: "2026-09-27 10:00:00", cancel_type: "Cliente Cancelou", cancel_obs: "Voo cancelado", cancel_refund: true,
      cancel_refunded: "t", cancel_refunded_amount: "20", cancelled_by: "Rui",
    }, lisboa);
    expect(r).toMatchObject({
      code: "MP1", eventAt: "2026-09-27T10:00:00.000Z", clientName: "Ana Silva", toPay: 30, channel: "parceiro",
      channelBadge: "Parceiro · Parkos", groupLabel: "Airpark Lisboa", approxDate: false,
    });
    expect(r.cancellation).toMatchObject({ type: "Cliente Cancelou", refund: true, refunded: true, refundedAmount: 20, by: "Rui" });
  });
  it("fora dos cancelados não há bloco de cancelamento; parque desconhecido → Marketplace", () => {
    const r = mapOpsListRow("reservas", { id: "b2", status: "BOOKED", park_id: "zz", approx_date: true }, undefined);
    expect(r.cancellation).toBeNull();
    expect(r.approxDate).toBe(false);
    expect(r.channel).toBe("marketplace");
  });
  it("agregado: números como texto (bigint) → números", () => {
    expect(mapAggRow({ park_id: "p1", cur: "t", status: "BOOKED", n: "12", value: "345.5", has_partner: false })).toMatchObject({ current: true, count: 12, value: 345.5, hasPartner: false });
  });
});

describe("contadores", () => {
  const parks: OpsParkInfo[] = [
    { id: "p1", name: "Airpark Lisboa", cityName: "Lisboa", key: "airpark_lisboa", label: "Airpark Lisboa", ours: true },
    { id: "p9", name: "Top Parking", cityName: "Lisboa", key: "marketplace", label: "Marketplace", ours: false },
  ];
  const row = (o: Partial<OpsAggRow>): OpsAggRow => ({
    parkId: "p1", current: true, status: "BOOKED", origin: "API", paymentSource: null, hasPartner: false, reason: null,
    count: 1, value: 10, paid: 0, toPay: 10, approx: 0, refund: 0, refunded: 0, ...o,
  });

  it("Reservas: não canceladas × canceladas; valores só das não canceladas; comparação", () => {
    const s = summarizeOps("reservas", [
      row({ count: 10, value: 500, paid: 300, toPay: 200 }),
      row({ status: "CANCELLED", count: 2, value: 80 }),
      row({ current: false, count: 8 }),
      row({ parkId: "p9", count: 3, value: 90 }),
    ], parks);
    expect(s).toMatchObject({ total: 15, prevTotal: 8, active: 13, cancelled: 2, cancelledValue: 80, value: 590, paid: 300 });
    expect(s.byChannel.find((c) => c.channel === "direto")).toMatchObject({ count: 12, prevCount: 8 });
    expect(s.byChannel.find((c) => c.channel === "marketplace")).toMatchObject({ count: 3 });
    expect(s.byPark[0]).toMatchObject({ parkId: "p1", count: 12, prevCount: 8 });
    expect(s.byGroup.map((g) => g.key)).toEqual(["airpark_lisboa", "marketplace"]);
  });

  it("filtro de canal: totais só desse canal, botões com os três", () => {
    const s = summarizeOps("reservas", [row({ count: 4 }), row({ hasPartner: true, count: 6 }), row({ parkId: "p9", count: 1 })], parks, "parceiro");
    expect(s.total).toBe(6);
    expect(s.byChannel.map((c) => c.count)).toEqual([4, 6, 1]);
  });

  it("Recolhas / Entregas: feitas e por fazer", () => {
    const e = summarizeOps("entradas", [row({ status: "CHECKED_IN", count: 5 }), row({ status: "BOOKED", count: 2 })], parks);
    expect(e).toMatchObject({ total: 7, done: 5, pending: 2 });
    const x = summarizeOps("saidas", [row({ status: "CHECKED_IN", count: 5 }), row({ status: "CHECKED_OUT", count: 2 })], parks);
    expect(x).toMatchObject({ done: 2, pending: 5 });
    expect(opsDone("saidas", "CHECKED_OUT")).toBe(true);
    expect(opsDone("entradas", "BOOKED")).toBe(false);
  });

  it("Cancelados: motivos, reembolsos, aproximados e comparação (subir é mau)", () => {
    const s = summarizeOps("cancelados", [
      row({ status: "CANCELLED", reason: "Cliente Cancelou", count: 3, value: 150, refund: 1, refunded: 40 }),
      row({ status: "CANCELLED", reason: null, count: 1, value: 20, approx: 1 }),
      row({ status: "CANCELLED", current: false, count: 6 }),
    ], parks);
    expect(s).toMatchObject({ total: 4, prevTotal: 6, value: 170, refund: 1, refunded: 40, approx: 1 });
    expect(s.byReason).toEqual([{ reason: "Cliente Cancelou", count: 3, value: 150 }, { reason: "Sem motivo", count: 1, value: 20 }]);
    expect(deltaVs(4, 6)).toEqual({ diff: -2, pct: -33.3 });
    expect(deltaVs(3, 0)).toEqual({ diff: 3, pct: null });
  });
});

describe("leitura ao vivo (BD simulada)", () => {
  const PARKS = [
    { id: "p1", name: "Airpark", city: "Lisboa" },
    { id: "p5", name: "Redpark", city: "Porto" },
  ];
  const route = (agg: unknown[], list: unknown[]) => (sql: string) => {
    if (sql.includes(`FROM "Park" p`)) return Promise.resolve(PARKS);
    if (sql.includes("GROUP BY 1, 2")) return Promise.resolve(agg);
    return Promise.resolve(list);
  };

  it("sem DATABASE_URL_MULTIPARK → indisponível, sem ler", async () => {
    delete process.env[ENV];
    const r = await getMultiparkOpsList({ kind: "cancelados", from: "2026-09-27", to: "2026-09-27" });
    expect(r).toMatchObject({ available: false, code: "NOT_CONFIGURED" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("âmbito de cidade pelo Park.city; contadores + página", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockImplementation(route(
      [{ park_id: "p1", cur: true, status: "CANCELLED", origin: "API", has_partner: false, reason: "Erro na Reserva", n: "2", value: "90", paid: "0", to_pay: "90", approx: "0", refund: "1", refunded: "10" },
        { park_id: "p1", cur: false, status: "CANCELLED", origin: "API", has_partner: false, reason: null, n: "5", value: "0", paid: "0", to_pay: "0", approx: "0", refund: "0", refunded: "0" }],
      [{ id: "b1", code: "MP1", status: "CANCELLED", park_id: "p1", event_at: "2026-09-27 08:00:00", cancel_type: "Erro na Reserva", cancelled_by: "Rui" }],
    ));
    const r = await getMultiparkOpsList({ kind: "cancelados", from: "2026-09-27", to: "2026-09-27" }, ["Lisboa"]);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.data.parks.map((p) => p.id)).toEqual(["p1"]);
    expect(r.data.summary).toMatchObject({ total: 2, prevTotal: 5, refund: 1 });
    expect(r.data.rows[0]).toMatchObject({ code: "MP1", groupLabel: "Airpark Lisboa", cancellation: { by: "Rui" } });
    expect(r.data).toMatchObject({ prevFrom: "2026-09-26", hasMore: false });
    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls).toHaveLength(3);
    for (const [sql, params] of queryMock.mock.calls.slice(1)) {
      expect(params).toContain("p1");
      expect(params).not.toContain("p5");
      expect(() => assertReadOnlySql(sql)).not.toThrow();
    }
  });

  it("paginação: limit+1 diz se há mais", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockImplementation(route([], Array.from({ length: 11 }, (_, i) => ({ id: `b${i}`, status: "BOOKED", park_id: "p1" }))));
    const r = await getMultiparkOpsList({ kind: "reservas", from: "2026-09-01", to: "2026-09-30", limit: 10, offset: 20 });
    expect(r.available && r.data.rows.length).toBe(10);
    expect(r.available && r.data.hasMore).toBe(true);
    expect(r.available && r.data.offset).toBe(20);
  });

  it("sem parques no âmbito (ou parque de fora) → vazio, só a leitura dos parques", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockImplementation(route([], []));
    const r = await getMultiparkOpsList({ kind: "entradas", from: "2026-09-27", to: "2026-09-27", parkId: "p5" }, ["Lisboa"]);
    expect(r).toMatchObject({ available: true, data: { rows: [], summary: { total: 0 } } });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("tempo esgotado → aviso, não lança", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockResolvedValueOnce(PARKS).mockRejectedValue(new Error("canceling statement due to statement timeout"));
    const r = await getMultiparkOpsList({ kind: "saidas", from: "2026-09-01", to: "2026-09-30" });
    expect(r).toMatchObject({ available: false, code: "TIMEOUT" });
  });

  it("período demasiado longo → indisponível (a rota recusa antes)", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    const r = await getMultiparkOpsList({ kind: "reservas", from: "2026-01-01", to: "2026-12-31" });
    expect(r.available).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
