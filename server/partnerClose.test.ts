import { describe, expect, it } from "vitest";
import { canClose, comparePartnerMonth, monthRangeLisbon, MEMORY_START_UTC, type CloseMpBooking, type CloseOurSnap } from "../shared/partnerClose";
import { buildBookingsStateSql, buildMonthlyInvoicesSql, buildPartnerCloseSql, mapCloseBooking } from "./multiparkDb/partnerClose";
import { lisbonDayRangeUtc } from "../shared/lisbonDay";
import { isMonth, previousMonth } from "./partnerClose";

const start = "2026-09-30 23:00:00", end = "2026-10-31 23:59:59";
const mp = (o: Partial<CloseMpBooking> & Pick<CloseMpBooking, "id">): CloseMpBooking => ({ code: o.id.toUpperCase(), partnerKey: "u-lets", partnerName: "Let's Travel", value: 100, ours: 75, dueMissing: false, checkOut: "2026-10-10 10:00:00", invoices: 1, ...o });
const snap = (o: Partial<CloseOurSnap> & Pick<CloseOurSnap, "bookingId">): CloseOurSnap => ({ status: "CHECKED_OUT", checkOut: "2026-10-10 10:00:00", partnerId: "pa1", value: 100, ours: 75, receivedAt: "2026-10-10 10:00:01", ...o });
const partnerOf = new Map([["pa1", { key: "u-lets", name: "Let's Travel" }], ["pa2", { key: "u-outro", name: "Outra Agência" }]]);

describe("fecho do mês de parceiros: comparação", () => {
  it("tudo igual → sem diferenças e totais iguais", () => {
    const r = comparePartnerMonth({ mp: [mp({ id: "b1" })], ours: new Map([["b1", snap({ bookingId: "b1" })]]), partnerOf, mpState: new Map(), start, end });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ partnerKey: "u-lets", mp: { bookings: 1, ours: 75, invoices: 1 }, copy: { bookings: 1, ours: 75 }, diffs: [] });
  });
  it("aponta o que não bate, reserva a reserva", () => {
    const r = comparePartnerMonth({
      mp: [
        mp({ id: "b1", ours: 80 }),                          // devido mudou
        mp({ id: "b2" }),                                    // não chegou pelo webhook
        mp({ id: "b3" }),                                    // saída não chegou (último retrato = CHECKED_IN)
        mp({ id: "b4", invoices: 0, dueMissing: true }),     // sem devido (fatura por reserva não conta: parceiros faturam ao mês)
        mp({ id: "b5", checkOut: "2026-09-20 10:00:00" }),   // antes da memória: não conta
        mp({ id: "b6", value: 120 }),                        // valor mudou
      ],
      ours: new Map([
        ["b1", snap({ bookingId: "b1" })],
        ["b3", snap({ bookingId: "b3", status: "CHECKED_IN" })],
        ["b4", snap({ bookingId: "b4" })],
        ["b6", snap({ bookingId: "b6" })],
        ["b7", snap({ bookingId: "b7", partnerId: "pa2" })],  // só nós: na Multipark foi cancelada
      ]),
      partnerOf,
      mpState: new Map([["b7", { status: "CANCELLED", checkOut: "2026-10-10 10:00:00", partnerId: "pa2" }]]),
      start, end,
    });
    const lets = r.find((x) => x.partnerKey === "u-lets")!;
    const codes = Object.fromEntries(lets.diffs.map((d) => [d.bookingId, d.codes]));
    expect(codes.b1).toEqual(["devido_diferente"]);
    expect(codes.b2).toEqual(["falta_na_copia"]);
    expect(codes.b3).toEqual(["saida_nao_recebida"]);
    expect(codes.b4).toEqual(["sem_devido"]);
    expect(codes.b5).toBeUndefined();
    expect(codes.b6).toEqual(["valor_diferente"]);
    expect(lets.beforeMemory).toBe(1);
    expect(lets.mp).toMatchObject({ bookings: 6, noDue: 1 });
    expect(lets.copy.bookings).toBe(3);
    const outro = r.find((x) => x.partnerKey === "u-outro")!;
    expect(outro.diffs).toEqual([{ bookingId: "b7", code: null, codes: ["falta_na_multipark"], detail: "na Multipark está CANCELLED" }]);
  });
  it("antes da memória: compara com o histórico carregado (preço inicial) e soma as faturas mensais", () => {
    const r = comparePartnerMonth({
      mp: [
        mp({ id: "h1", checkOut: "2026-09-10 10:00:00", price: 45 }),  // nasceu a 31 €, agora 45 €
        mp({ id: "h2", checkOut: "2026-09-11 10:00:00", price: 31 }),  // igual ao histórico
        mp({ id: "h3", checkOut: "2026-09-12 10:00:00", price: 31 }),  // sem histórico nem memória
      ],
      ours: new Map(), partnerOf, mpState: new Map(),
      history: new Map([["h1", { initialPrice: 31 }], ["h2", { initialPrice: 31 }]]),
      monthlyInvoices: new Map([["u-lets", 1]]),
      start: "2026-08-31 23:00:00", end: "2026-09-30 23:00:00",
    });
    expect(r[0].copy).toMatchObject({ bookings: 2, fromHistory: 2, value: 62 });
    expect(r[0].beforeMemory).toBe(1);
    expect(r[0].diffs.map((d) => [d.bookingId, d.codes])).toEqual([["h1", ["preco_alterado"]]]);
    expect(r[0].mp.invoices).toBe(3 + 1);
  });
  it("parceiro diferente entre a cópia e a Multipark", () => {
    const r = comparePartnerMonth({ mp: [mp({ id: "b1" })], ours: new Map([["b1", snap({ bookingId: "b1", partnerId: "pa2" })]]), partnerOf, mpState: new Map(), start, end });
    expect(r[0].diffs[0].codes).toEqual(["parceiro_diferente"]);
  });
  it("fechar com diferenças pede explicação", () => {
    expect(canClose(0, null)).toBeNull();
    expect(canClose(2, "curto")).toMatch(/porque/);
    expect(canClose(2, "combinado com o parceiro por email")).toBeNull();
  });
  it("mês → limites em UTC (Lisboa) e datas", () => {
    // outubro: começa em hora de verão (UTC+1) e acaba em hora de inverno (UTC+0)
    expect(monthRangeLisbon("2026-10", lisbonDayRangeUtc)).toEqual({ start: "2026-09-30 23:00:00", end: "2026-11-01 00:00:00" });
    expect(isMonth("2026-10")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(MEMORY_START_UTC < start).toBe(true);
  });
});

describe("fecho do mês de parceiros: SQL da Multipark", () => {
  it("saídas concluídas de parceiro, com devido e faturas emitidas (sem notas de crédito)", () => {
    const { sql, params } = buildPartnerCloseSql({ parkIds: ["pk1"], start, end });
    expect(sql).toContain(`b."status"::text = 'CHECKED_OUT'`);
    expect(sql).toContain(`JOIN "Partner" pa ON pa."id" = b."partnerId"`);
    expect(sql).toContain(`"Billing" y WHERE y."bookingId" = b."id" AND y."emited" = true`);
    expect(sql).toContain(`NOT LIKE '%CREDIT%'`);
    expect(params).toEqual([start, end, "pk1", 20000]);
    expect(() => buildPartnerCloseSql({ parkIds: [], start, end })).toThrow();
    expect(buildBookingsStateSql(["a", "b"]).params).toEqual(["a", "b", 2]);
    const mi = buildMonthlyInvoicesSql({ start, end });
    expect(mi.sql).toContain(`y."bookingId" IS NULL`);
    expect(mi.sql).toContain(`interval '25 days'`);
  });
  it("mapeia a linha e usa a empresa (userId) como chave", () => {
    expect(mapCloseBooking({ id: "b1", code: "AB12", partner_id: "pa1", partner_user_id: "u-lets", partner_name: "Let's", value: "402", ours: "301.5", due_missing: "f", check_out: "2026-10-10 10:00:00", invoices: "1" }))
      .toEqual({ id: "b1", code: "AB12", parkId: null, partnerId: "pa1", partnerKey: "u-lets", partnerName: "Let's", value: 402, ours: 301.5, dueMissing: false, checkOut: "2026-10-10 10:00:00", invoices: 1, price: null });
    expect(mapCloseBooking({ id: "b1" })).toBeNull();
  });
});
