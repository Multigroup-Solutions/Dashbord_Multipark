/**
 * P3 lote 13 — Reservas & Operações → Ficha de reserva: as listas contam como
 * o Dashboard (sem compras online por acabar; a diferença dos parques
 * Marketplace dita na página), as Reservas do dia deixam as pendentes fora das
 * contas, e nenhum ecrã mostra zeros/vazio quando a leitura falha.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParamList } from "./multiparkDb/read";
import { buildOpsAggSql, buildOpsListSql, buildSource, opsBounds } from "./multiparkDb/opsLists";
import { buildOpsCountsSql } from "./multiparkDb/opsCounts";
import { OPS_LIST_KINDS, summarizeOps, type OpsAggRow, type OpsListKind, type OpsParkInfo } from "../shared/opsLists";
import {
  countsForDay, filterMovements, summarizeDay, toDayMovements, type DayBooking,
} from "../shared/reservasDoDia";
import { isForbidden, retryTransient, trpcErrorCode } from "../client/src/lib/queryRetry";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const spec = (kind: OpsListKind) => ({ kind, parkIds: ["p1", "p9"], ourParkIds: ["p1"] });
const bounds = opsBounds("2026-09-01", "2026-09-30");

describe("listas por período: as compras online por acabar não entram", () => {
  it("Reservas, Recolhas e Entregas deixam de fora o PENDING (como o Dashboard)", () => {
    for (const kind of ["reservas", "entradas", "saidas"] as const) {
      const p = new ParamList();
      const sql = buildSource(spec(kind), p, bounds.start, bounds.end, true);
      expect(p.values).toContain("PENDING");
      const i = p.values.indexOf("PENDING") + 1;
      expect(sql).toContain(`b."status"::text <> $${i}`);
    }
  });

  it("nos Cancelados o estado já é CANCELLED (sem filtro a mais)", () => {
    const p = new ParamList();
    buildSource(spec("cancelados"), p, bounds.start, bounds.end, true);
    expect(p.values).not.toContain("PENDING");
  });

  it("o agregado (contadores) e a página da tabela usam o mesmo filtro", () => {
    for (const kind of ["reservas", "entradas", "saidas"] as const) {
      expect(buildOpsAggSql(spec(kind), bounds).params).toContain("PENDING");
      expect(buildOpsListSql(spec(kind), bounds, 200, 0).params).toContain("PENDING");
    }
  });

  it("é a mesma regra das contagens do Dashboard (opsCounts)", () => {
    const { sql } = buildOpsCountsSql({ events: ["created", "createdAll", "checkin", "checkout"], start: bounds.start, end: bounds.end, parkIds: ["p1"] });
    expect(sql).toContain(`<> 'PENDING'`);
    expect(sql).toContain(`NOT IN ('CANCELLED', 'PENDING')`);
  });
});

describe("listas por período: quantas são dos parques nossos (o número do Dashboard)", () => {
  const parks: OpsParkInfo[] = [
    { id: "p1", name: "Airpark Lisboa", cityName: "Lisboa", key: "airpark_lisboa", label: "Airpark Lisboa", ours: true },
    { id: "p9", name: "Top Parking", cityName: "Lisboa", key: "marketplace", label: "Marketplace", ours: false },
  ];
  const row = (o: Partial<OpsAggRow>): OpsAggRow => ({
    parkId: "p1", current: true, status: "BOOKED", origin: "API", paymentSource: null, hasPartner: false, reason: null,
    count: 1, value: 10, paid: 0, toPay: 10, approx: 0, refund: 0, refunded: 0, ...o,
  });

  it("Reservas: total = nossos + Marketplace; o período anterior não conta", () => {
    const s = summarizeOps("reservas", [
      row({ count: 120 }), row({ status: "CANCELLED", count: 5 }), row({ parkId: "p9", count: 15 }), row({ current: false, count: 99 }),
    ], parks);
    expect(s.total).toBe(140);
    expect(s.ours).toBe(125);
    expect(s.oursApprox).toBe(0);
  });

  it("Cancelados: o Dashboard conta só os nossos com registo de cancelamento", () => {
    const s = summarizeOps("cancelados", [
      row({ status: "CANCELLED", count: 4, approx: 1 }), row({ parkId: "p9", status: "CANCELLED", count: 2, approx: 2 }),
    ], parks);
    expect(s.total).toBe(6);
    expect(s.ours - s.oursApprox).toBe(3);
  });

  it("com filtro de canal, os nossos seguem o filtro", () => {
    const s = summarizeOps("reservas", [row({ count: 4 }), row({ hasPartner: true, count: 6 })], parks, "parceiro");
    expect(s.ours).toBe(6);
  });

  it("todas as listas devolvem os dois campos", () => {
    for (const kind of OPS_LIST_KINDS) {
      const s = summarizeOps(kind, [], parks);
      expect(s).toMatchObject({ ours: 0, oursApprox: 0 });
    }
  });

  it("a página mostra a diferença só sem filtros, e o cartão abre a lista no mesmo período", () => {
    const list = src("client/src/components/operacoes/OpsList.tsx");
    expect(list).toContain("No Dashboard das Operações");
    expect(list).toMatch(/const unfiltered = state === "all" && !shared\.channel && !shared\.parkId && !shared\.search\.trim\(\)/);
    const page = src("client/src/pages/OperacoesPage.tsx");
    expect(page).toMatch(/if \(n > 0 && n <= OPS_LIST_MAX_DAYS\) patchShared\(\{ from: range\.from, to: range\.to \}\)/);
    expect(page).toContain(`const jump = (tab: string) => onJump(tab, { from, to });`);
    expect(page).not.toContain("(abre em hoje)");
  });
});

describe("Reservas do dia: pendentes fora das contas, à distância de um clique", () => {
  const day = { startMs: Date.parse("2026-10-01T23:00:00Z"), endMs: Date.parse("2026-10-02T23:00:00Z") };
  const mk = (id: string, status: string, o: Partial<DayBooking> = {}): DayBooking => ({
    id, code: id, status, checkIn: "2026-10-02T08:00:00.000Z", checkOut: "2026-10-09T08:00:00.000Z",
    parkId: "p1", groupKey: "airpark_lisboa", groupLabel: "Airpark Lisboa", groupOrder: 1, ours: true,
    ...o,
  } as DayBooking);
  const rows = toDayMovements([mk("a", "BOOKED"), mk("b", "PENDING"), mk("c", "CANCELLED"), mk("d", "CHECKED_IN")], day.startMs, day.endMs);

  it("countsForDay: só canceladas e pendentes ficam de fora", () => {
    expect(countsForDay("PENDING")).toBe(false);
    expect(countsForDay("CANCELLED")).toBe(false);
    expect(countsForDay("BOOKED")).toBe(true);
    expect(countsForDay("CHECKED_OUT")).toBe(true);
  });

  it("contadores: a pendente não conta como entrada; aparece à parte", () => {
    const s = summarizeDay(rows);
    expect(s).toMatchObject({ entradas: 2, entradasPorFazer: 1, canceladas: 1, pendentes: 1 });
    expect(s.groups[0]).toMatchObject({ entradas: 2 });
  });

  it("lista por omissão = o que os contadores contam; 'Pendente' e 'Todas' mostram-nas", () => {
    expect(filterMovements(rows, {}).map((m) => m.booking.id)).toEqual(["a", "d"]);
    expect(filterMovements(rows, { state: "PENDING" }).map((m) => m.booking.id)).toEqual(["b"]);
    expect(filterMovements(rows, { state: "todas" })).toHaveLength(4);
  });

  it("a página mostra o atalho para as compras por acabar", () => {
    const page = src("client/src/components/operacoes/ReservasDoDia.tsx");
    expect(page).toContain("summary.pendentes > 0");
    expect(page).toContain(`setState(state === "PENDING" ? "ativas" : "PENDING")`);
    expect(page).toContain("Sem canceladas nem pendentes");
  });
});

describe("erro ≠ zero", () => {
  const err = (code: string) => ({ data: { code } });

  it("falha passageira repete 2 vezes; sem permissão ou pedido inválido, não", () => {
    expect(retryTransient(0, err("INTERNAL_SERVER_ERROR"))).toBe(true);
    expect(retryTransient(1, new Error("rede"))).toBe(true);
    expect(retryTransient(2, err("INTERNAL_SERVER_ERROR"))).toBe(false);
    for (const c of ["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"]) expect(retryTransient(0, err(c))).toBe(false);
    expect(isForbidden(err("FORBIDDEN"))).toBe(true);
    expect(isForbidden(null)).toBe(false);
    expect(trpcErrorCode(undefined)).toBe("");
  });

  it("Operações → Dashboard: cartão de erro com 'Tentar de novo' e cartões sem zeros a fingir", () => {
    const page = src("client/src/pages/OperacoesPage.tsx");
    expect(page).toContain("retry: retryTransient");
    expect(page).toContain("Não foi possível ler as reservas da Multipark.");
    expect(page).toContain("Tentar de novo");
    expect(page).toMatch(/value=\{ready \? stats\.criadas : null\}/);
    expect(page).toContain(`value == null ? "…"`);
    expect(page).toMatch(/compareValue=\{prevReady \?/);
  });

  it("/operacoes-dashboard: dias de Lisboa, erro explicado e '—' em vez de 0", () => {
    const page = src("client/src/pages/OperacoesDashboard.tsx");
    expect(page).not.toMatch(/\.toISOString\(\)\.slice/);
    expect(page).not.toMatch(/new Date\(d\.date\)/);
    expect(page).toContain("lisbonDayOf(Date.now())");
    expect(page).not.toMatch(/fmtNum\(bookingStats\?\.\w+ \?\? 0\)/);
    expect(page).toContain("Sem acesso aos números das reservas.");
    expect(page).toContain("Não foi possível ler o GPS de ontem");
    const bar = src("client/src/components/DashboardFilterBar.tsx");
    expect(bar).not.toMatch(/\.toISOString\(\)\.slice/);
    expect(bar).toContain("lisbonDayOf(Date.now())");
  });

  it("Ficha da reserva: cada secção mostra o erro com 'Tentar de novo' (nunca 'A carregar…' para sempre)", () => {
    const page = src("client/src/pages/BookingFilePage.tsx");
    // main, anexos, assinaturas, linha do tempo, contas, extras, comunicação, ocorrências, os nossos casos
    expect(page.match(/<QueryErrorNote error=/g)?.length).toBe(9);
    // As secções que abrem ao clicar verificam o erro ANTES do "a carregar".
    expect(page.match(/\{q\.error \? <QueryErrorNote[^\n]*: q\.isLoading \|\| \(!d && enabled\) \? <Loading \/>/g)?.length).toBe(2);
    expect(page).not.toMatch(/\{q\.isLoading \|\| \(!d && enabled\) \? <Loading \/>/);
  });
});
