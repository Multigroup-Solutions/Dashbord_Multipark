import { describe, expect, it } from "vitest";
import {
  cancellationsByDay, computeDiffs, focusDay, lisbonRangeUtc, summarize, utcToLisbon,
  type OurBooking, type TheirBooking,
} from "./diff";

const NOW = new Date("2026-09-27T12:00:00Z");
const our = (id: string, p: Partial<OurBooking> = {}): OurBooking => ({
  id, bookingNumber: "A1", status: "BOOKED", parkId: "p1", parkName: "Airpark Lisboa", city: "Lisboa",
  checkIn: "2026-09-20 08:00:00", checkOut: "2026-09-25 18:00:00", createdAt: "2026-09-01 10:00:00",
  cancelledAt: null, totalPrice: 50, detailErrorCode: null, updatedAt: "2026-09-02 10:00:00", ...p,
});
const their = (id: string, p: Partial<TheirBooking> = {}): TheirBooking => ({
  id, allocation: "A1", status: "BOOKED", parkId: "p1", parkName: "Airpark Lisboa",
  checkIn: "2026-09-20 08:00:00", checkOut: "2026-09-25 18:00:00", createdAt: "2026-09-01 10:00:00", updatedAt: "2026-09-02 10:00:00",
  price: 50, cancelledAt: null, cancelType: null, cancelAgent: null, cancelMovementAt: null, ...p,
});
const run = (ours: OurBooking[], theirs: TheirBooking[], floor: string | null = "2026-01-01 00:00:00") =>
  computeDiffs(ours, theirs, { now: NOW, floor });

describe("diferenças — datas", () => {
  it("dia de Lisboa no verão, na mudança de hora e no inverno", () => {
    expect(lisbonRangeUtc("2026-09-10", "2026-09-10")).toEqual({ start: "2026-09-09 23:00:00", end: "2026-09-10 23:00:00" });
    expect(lisbonRangeUtc("2026-10-24", "2026-10-25")).toEqual({ start: "2026-10-23 23:00:00", end: "2026-10-26 00:00:00" });
    expect(lisbonRangeUtc("2026-12-01", "2026-12-01")).toEqual({ start: "2026-12-01 00:00:00", end: "2026-12-02 00:00:00" });
    expect(() => lisbonRangeUtc("10/09/2026", "2026-09-10")).toThrow();
  });
  it("UTC → hora de Lisboa", () => {
    expect(utcToLisbon("2026-09-09 23:30:00")).toBe("2026-09-10 00:30");
    expect(utcToLisbon(null)).toBeNull();
  });
});

describe("diferenças — comparação", () => {
  it("iguais → sem diferenças", () => {
    expect(run([our("a")], [their("a")]).diffs).toEqual([]);
  });
  it("só nossa: apagada deles, com 404 e estado", () => {
    const { diffs } = run([our("a", { status: "CANCELLED", cancelledAt: "2026-09-10 09:00:00", detailErrorCode: "API_HTTP_404" })], []);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: "so_nossa", oursStatus: "CANCELLED", parkName: "Airpark Lisboa", city: "Lisboa" });
    expect(diffs[0].reason).toMatch(/Apagada da BD da Multipark \(a API também responde 404\) — estava cancelada no dashboard desde 2026-09-10 10:00/);
  });
  it("só deles: motivos (pendente, parque sem chave, cancelada, nunca chegou)", () => {
    const { diffs } = run([our("x")], [
      their("x"),
      their("p", { status: "PENDING" }),
      their("k", { parkId: "p9", parkName: "Top Parking Porto" }),
      their("c", { status: "CANCELLED", cancelledAt: "2026-09-10 09:00:00" }),
      their("n"),
    ]);
    const r = Object.fromEntries(diffs.map((d) => [d.externalId, d.reason]));
    expect(r.p).toMatch(/pendente/);
    expect(r.k).toMatch(/Parque sem nenhuma reserva no dashboard \(Top Parking Porto\)/);
    expect(r.c).toMatch(/Cancelada na Multipark a 2026-09-10 10:00/);
    expect(r.n).toMatch(/Nunca chegou/);
  });
  it("só deles antes do início do dashboard ou criada há pouco não conta", () => {
    const { diffs, skipped } = run([our("x", { createdAt: "2026-06-01 00:00:00" })], [
      their("x"), their("old", { createdAt: "2026-05-01 00:00:00" }), their("new", { createdAt: "2026-09-27 11:50:00" }),
    ], "2026-06-01 00:00:00");
    expect(diffs).toEqual([]);
    expect(skipped).toMatchObject({ antesDoInicio: 1, criadasRecentes: 1 });
  });
  it("estado: sync não apanhou vs reativada", () => {
    const a = run([our("a")], [their("a", { status: "CANCELLED", updatedAt: "2026-09-10 09:00:00" })]).diffs;
    expect(a.find((d) => d.kind === "estado")!.reason).toMatch(/o sync não apanhou/);
    const b = run([our("b", { status: "CANCELLED", cancelledAt: "2026-09-10 09:00:00" })], [their("b", { status: "BOOKED" })]).diffs;
    expect(b.find((d) => d.kind === "estado")!.reason).toMatch(/reativada/);
  });
  it("cancelamento: sem data no dashboard, ou datas diferentes (> 2 min)", () => {
    const t = their("a", { status: "CANCELLED", cancelledAt: "2026-09-10 09:00:00" });
    expect(run([our("a", { status: "CANCELLED" })], [t]).diffs.map((d) => d.kind)).toEqual(["cancelamento"]);
    expect(run([our("a", { status: "CANCELLED", cancelledAt: "2026-09-10 09:01:00" })], [t]).diffs).toEqual([]);
    expect(run([our("a", { status: "CANCELLED", cancelledAt: "2026-09-11 09:00:00" })], [t]).diffs[0]).toMatchObject({ kind: "cancelamento", oursValue: "2026-09-11 10:00", theirsValue: "2026-09-10 10:00" });
  });
  it("entrada, saída, preço e parque", () => {
    const { diffs } = run([our("a")], [their("a", { checkIn: "2026-09-20 09:00:00", checkOut: "2026-09-26 18:00:00", price: 55, parkId: "p2", parkName: "Redpark" })]);
    expect(diffs.map((d) => d.kind).sort()).toEqual(["entrada", "parque", "preco", "saida"]);
  });
  it("alterada há pouco na Multipark → não compara campos", () => {
    const { diffs, skipped } = run([our("a")], [their("a", { status: "CHECKED_IN", updatedAt: "2026-09-27 11:55:00" })]);
    expect(diffs).toEqual([]);
    expect(skipped.alteradasRecentes).toBe(1);
  });
});

describe("diferenças — resumos", () => {
  it("summarize agrupa por tipo, motivo e parque; desaparecidas por dia", () => {
    const { diffs } = run([our("a", { status: "CANCELLED", cancelledAt: "2026-09-10 09:00:00" }), our("b")], []);
    const s = summarize(diffs);
    expect(s.porTipo).toEqual({ so_nossa: 2 });
    expect(s.desaparecidas.porDiaCancelamento).toMatchObject({ "2026-09-10": 1 });
    expect(s.porParque["Airpark Lisboa"]).toEqual({ so_nossa: 2 });
  });
  it("cancelamentos por dia dos dois lados", () => {
    const r = cancellationsByDay(
      [our("a", { status: "CANCELLED", cancelledAt: "2026-09-10 09:00:00" })],
      [their("a", { status: "CANCELLED", cancelledAt: "2026-09-10 09:00:00" }), their("b", { status: "CANCELLED", cancelMovementAt: "2026-09-09 23:30:00" })],
      NOW,
    );
    expect(r["2026-09-10"]).toEqual({ deles: 2, nossa: 1 });
  });
  it("foco num dia classifica cada cancelada", () => {
    const f = focusDay("2026-09-10",
      [our("both", { status: "CANCELLED", cancelledAt: "2026-09-10 09:00:00" }), our("gone", { status: "CANCELLED", cancelledAt: "2026-09-10 10:00:00" }), our("act")],
      [their("both", { status: "CANCELLED", cancelledAt: "2026-09-10 09:00:00", cancelAgent: "Ana" }), their("act", { status: "CANCELLED", cancelledAt: "2026-09-10 11:00:00" }), their("new", { status: "CANCELLED", cancelledAt: "2026-09-10 12:00:00" })],
    );
    expect(f.porClasse).toEqual({ cancelada_nos_dois: 1, desapareceu_da_multipark: 1, cancelada_so_na_multipark: 1, nunca_chegou_ao_dashboard: 1 });
    expect(f.porQuem).toMatchObject({ Ana: 1 });
    expect(f.porDiaEntrada).toEqual({ "2026-09-20": 4 });
  });
});
