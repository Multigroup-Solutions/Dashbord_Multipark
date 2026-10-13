import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  toCents, payKind, bookingFindings, buildBookingView, daySummary, dayAlertOf, resolvedColor, justificationValid, justificationProblem, closeBlockers,
  statusAfterClose, canonicalJson, bookingSealState, validationFlags, hasCounterInDay, stableSubKeys, offCounterOf, feeSplitOf, eur,
  type ConfirmBookingLive, type ConfirmOrigin, type StripeCheck, type Finding, type JustificationRef, type InDay, type ShiftDeclaration,
} from "../shared/cashConfirm";
import { eventHash, verifyChain, verifyIntegrity, sealDrift, summaryDrift, buildSeal, GENESIS_HASH, type ChainEvent, type StoredEvent } from "./cashConfirm";
import { buildConfirmDaySql, mapConfirmRow, CONFIRM_BOOKINGS_MAX, CONFIRM_PAYMENTS_MAX } from "./multiparkDb/cashConfirm";
import { MIGRATION_0635_STATEMENTS } from "./migrations/migration_0635";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

const V = (done = false) => ({ done, at: null, by: null, byId: null });
const DAYP = "2026-10-12T10:00:00.000Z";
function bk(o: Partial<ConfirmBookingLive> = {}): ConfirmBookingLive {
  return {
    id: "b1", code: "A1", parkId: "p1", parkName: "Airpark Lisboa", status: "CHECKED_OUT", checkIn: "2026-10-10T08:00:00.000Z", checkOut: DAYP,
    createdAt: "2026-10-01T10:00:00.000Z", bookingPrice: 50, originalBookingPrice: 50, paymentMethod: "Numerário", campaignId: null, partnerId: null,
    pro: false, clientPlanId: null, allowance: false, checkOutDriverName: "Rui", checkInDriverId: "d1", checkingInAt: null, paymentIntentId: null, stripeChargeId: null,
    credit: null, fees: null, cashierClosed: V(true), cashValidated: V(true), driverValidated: V(true),
    lines: [{ id: "l1", description: "Estacionamento", category: "PARKING", total: 50, amountPaid: 50, extraServiceId: null }],
    payments: [{ id: "z1", pricingId: "l1", amount: 50, method: "Numerário", recordedAt: DAYP }],
    intents: [], cancelled: false, refunded: null, ...o,
  };
}
const origin = (o: Partial<ConfirmOrigin> = {}): ConfirmOrigin => ({ source: "webhook", bookingPrice: 50, originalBookingPrice: 50, checkOut: DAYP, receivedAt: "2026-10-01T10:00:05.000Z", pro: false, partnerId: null, campaignId: null, fromDb: true, late: false, ...o });
const run = (live: ConfirmBookingLive, extra: Partial<Parameters<typeof bookingFindings>[0]> = {}) => bookingFindings({
  live, origin: origin(), windowPaymentIds: new Set(live.payments.map((p) => p.id)), inDay: "checkout",
  stripe: new Map(), stripeAvailable: true, mbReceipts: [], ...extra,
});
const codes = (f: Finding[]) => f.map((x) => `${x.code}:${x.color}`).sort();
const line = (total: number, paid = total, o: Partial<ConfirmBookingLive["lines"][number]> = {}) => ({ id: "l1", description: "Estacionamento", category: "PARKING", total, amountPaid: paid, extraServiceId: null, ...o });
const pay = (amount: number, method = "Numerário", o: Partial<ConfirmBookingLive["payments"][number]> = {}) => ({ id: "z1", pricingId: "l1", amount, method, recordedAt: DAYP, ...o });

describe("dinheiro em cêntimos", () => {
  it("half-even e sem erros de float", () => {
    expect(toCents(0.125)).toBe(12);
    expect(toCents(0.135)).toBe(14);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(null)).toBe(0);
    expect(eur(-1234)).toBe("−12,34 €");
  });
});

describe("métodos (dicionário exato)", () => {
  it("classifica os valores conhecidos e o resto é desconhecido", () => {
    for (const [m, k] of [["Numerário", "cash"], ["dinheiro", "cash"], ["Multibanco", "card"], ["Cartão de crédito", "card"], ["Online, MBWAY", "online"], ["MB WAY", "online"],
      ["Online, Card", "online"], ["Crédito", "off_counter"], ["PRO_PLAN", "off_counter"], ["Transferencia Bancária", "transfer"], ["Unknown", "unknown"], ["Depósito", "unknown"], ["Parkos", "unknown"]] as const) {
      expect(payKind(m), m).toBe(k);
    }
    expect(payKind("Parkos", new Set(["parkos"]))).toBe("off_counter");
  });
});

describe("achados de uma saída", () => {
  it("tudo certo → nada", () => { expect(run(bk())).toEqual([]); });
  it("preço desceu face ao que nasceu → vermelho com o valor", () => {
    const f = run(bk({ bookingPrice: 40, lines: [line(40)], payments: [pay(40)] })).find((x) => x.code === "price_down")!;
    expect(f.color).toBe("red");
    expect(f.amountCents).toBe(1000);
  });
  it("PRO: nasceu já com o desconto; um desconto manual a mais é vermelho (cenário D da auditoria)", () => {
    const lines = [line(100, 0), { id: "l2", description: "Desconto PRO", category: "DISCOUNT", total: -10, amountPaid: 0, extraServiceId: null }, { id: "l3", description: "Ajuste de preço (desconto)", category: "DISCOUNT", total: -10, amountPaid: 0, extraServiceId: null }];
    const f = run(bk({ pro: true, bookingPrice: 80, originalBookingPrice: 100, lines, payments: [] }), { origin: origin({ bookingPrice: 90, originalBookingPrice: 100, pro: true }) });
    expect(f.find((x) => x.code === "price_down")?.amountCents).toBe(1000);
  });
  it("sem memória: o desconto PRO/campanha explica a descida só até ao valor das linhas", () => {
    const lines = [line(50, 0), { id: "l2", description: "Desconto PRO", category: "DISCOUNT", total: -5, amountPaid: 0, extraServiceId: null }];
    const none = (o: Partial<ConfirmBookingLive>) => bookingFindings({ live: bk({ lines, payments: [], ...o }), origin: null, windowPaymentIds: new Set(), inDay: "checkout", stripe: new Map(), stripeAvailable: true, mbReceipts: [] });
    expect(none({ pro: true, bookingPrice: 45 }).some((x) => x.code === "price_down")).toBe(false);
    expect(none({ pro: true, bookingPrice: 40 }).find((x) => x.code === "price_down")?.amountCents).toBe(500);
    expect(none({ pro: false, bookingPrice: 45 }).some((x) => x.code === "price_down")).toBe(true);
    expect(codes(none({ bookingPrice: 45 }))).toContain("no_origin:amber");
  });
  it("saída antecipada → vermelho próprio (sem comprovativo obrigatório)", () => {
    const f = run(bk({ bookingPrice: 40, checkOut: "2026-10-12T06:00:00.000Z", lines: [line(40)], payments: [pay(40, "Numerário", { recordedAt: "2026-10-12T06:00:00.000Z" })] }));
    expect(codes(f)).toContain("price_down_early:red");
    expect(justificationProblem({ finding: f.find((x) => x.code === "price_down_early")!, reason: "saida_antecipada", explanation: "a".repeat(30), fileCount: 0 })).toBeNull();
  });
  it("original da Multipark abaixo do que vimos nascer → vermelho; webhook tardio → amarelo", () => {
    expect(codes(run(bk({ originalBookingPrice: 45 })))).toContain("origin_conflict:red");
    expect(codes(run(bk(), { origin: origin({ late: true }) }))).toContain("origin_late:amber");
  });
  it("subida: com taxa/extra ou mais dias é verde; sem causa é amarelo", () => {
    const up = (lines: ConfirmBookingLive["lines"], checkOut = DAYP) => run(bk({ bookingPrice: 60, checkOut, lines, payments: [pay(60, "Numerário", { pricingId: lines[0].id, recordedAt: checkOut })] }));
    expect(up([line(50, 60), { id: "l2", description: "Noturno", category: "FEE", total: 10, amountPaid: 0, extraServiceId: null }]).some((x) => x.code === "price_up_unexplained")).toBe(false);
    expect(up([line(60)], "2026-10-13T10:00:00.000Z").some((x) => x.code === "price_up_unexplained")).toBe(false);
    expect(codes(up([line(60, 60, { category: "ADJUSTMENT", description: "Ajuste" })]))).toContain("price_up_unexplained:amber");
  });
  it("PRO/parceiro ligado depois de nascer → vermelho e o pagamento continua a ser conferido", () => {
    const f = run(bk({ partnerId: "par1", payments: [pay(0)], lines: [line(50, 0)] }));
    expect(codes(f)).toContain("marker_added:red");
    expect(codes(f)).toContain("underpaid:red");
    expect(offCounterOf(bk({ partnerId: "par1" }), origin())).toBe(false);
    expect(offCounterOf(bk({ partnerId: "par1" }), origin({ partnerId: "par1" }))).toBe(true);
  });
  it("pago a menos, crédito, negativo, desconhecido, fora do balcão numa reserva normal", () => {
    expect(run(bk({ payments: [pay(30)], lines: [line(50, 30)] })).find((x) => x.code === "underpaid")?.amountCents).toBe(2000);
    expect(codes(run(bk({ credit: 10, payments: [pay(40)], lines: [line(50, 40)] })))).toEqual(["credit_given:red"]);
    expect(codes(run(bk({ payments: [pay(50, "PRO_PLAN")] })))).toContain("off_counter_method:red");
    expect(run(bk({ pro: true, payments: [pay(50, "PRO_PLAN")] }), { origin: origin({ pro: true }) }).some((x) => x.code === "off_counter_method")).toBe(false);
    expect(codes(run(bk({ payments: [pay(50, "Unknown")] })))).toContain("unknown_method:red");
    expect(codes(run(bk({ payments: [pay(60), { id: "z2", pricingId: "l1", amount: -10, method: "Numerário", recordedAt: DAYP }] })))).toContain("negative_payment:red");
  });
  it("pagamento negativo que espelha uma linha de desconto não é achado", () => {
    const lines = [line(60, 60), { id: "l2", description: "Desconto parceiro", category: "DISCOUNT", total: -10, amountPaid: -10, extraServiceId: null }];
    const f = run(bk({ lines, payments: [pay(60), { id: "z2", pricingId: "l2", amount: -10, method: "Numerário", recordedAt: DAYP }] }));
    expect(f.some((x) => x.code === "negative_payment")).toBe(false);
  });
  it("taxa extra (BookingFee) não dá 'pago a menos' — é dinheiro à parte (cenário C)", () => {
    const f = run(bk({ fees: 5 }));
    expect(f.some((x) => x.code === "underpaid")).toBe(false);
    expect(codes(f)).toEqual(["fee_cash:amber"]);
  });
  it("linha: pago ≠ pagamentos → vermelho; linha antiga sem pagamentos → amarelo", () => {
    expect(codes(run(bk({ lines: [line(50, 40)] })))).toContain("ledger_mismatch:red");
    expect(codes(run(bk({ lines: [line(50, 50, { description: "Reserva", category: null })], payments: [pay(50, "Numerário", { pricingId: "lx" })] })))).toContain("legacy_line:amber");
  });
  it("Multibanco: sem talão vermelho; com talão do mesmo valor e da reserva sai", () => {
    const live = bk({ payments: [pay(50, "Multibanco")] });
    expect(codes(run(live))).toContain("mb_no_receipt:red");
    expect(run(live, { mbReceipts: [{ id: 1, amountCents: 5000, bookingId: "b1" }] }).some((x) => x.code === "mb_no_receipt")).toBe(false);
    expect(codes(run(live, { mbReceipts: [{ id: 1, amountCents: 5000, bookingId: "b2" }] }))).toContain("mb_no_receipt:red");
    expect(codes(run(live, { mbReceipts: [{ id: 1, amountCents: 4999, bookingId: "b1" }] }))).toContain("mb_no_receipt:red");
  });
  it("Online: sem Stripe ou por ler → amarelo (bloqueia o dia); sem PI, 404, valor ou estado errado → vermelho; certo → nada", () => {
    const live = bk({ payments: [pay(50, "Online, Card")], intents: [{ id: "pi_1", expected: 50 }] });
    const ok: StripeCheck = { status: "succeeded", received: 50, refunded: 0, disputed: false };
    expect(codes(run(live, { stripeAvailable: false }))).toContain("online_unverified:amber");
    expect(codes(run(live, { stripe: new Map() }))).toContain("online_unverified:amber");
    expect(codes(run(bk({ payments: live.payments, intents: [] })))).toContain("online_mismatch:red");
    expect(codes(run(live, { stripe: new Map([["pi_1", null]]) }))).toContain("online_mismatch:red");
    expect(codes(run(live, { stripe: new Map([["pi_1", { ...ok, received: 40 }]]) }))).toContain("online_mismatch:red");
    expect(codes(run(live, { stripe: new Map([["pi_1", { ...ok, status: "requires_payment_method" }]]) }))).toContain("online_mismatch:red");
    expect(run(live, { stripe: new Map([["pi_1", ok]]) })).toEqual([]);
  });
  it("validações: por fechar amarelo; fora de ordem vermelho; saída por concluir vermelho", () => {
    expect(codes(run(bk({ cashierClosed: V(false) })))).toEqual(["mp_not_closed:amber"]);
    expect(codes(run(bk({ cashValidated: V(false) })))).toContain("mp_order:red");
    expect(codes(run(bk({ status: "CHECKING_OUT", cashierClosed: V(false), cashValidated: V(false), driverValidated: V(false) }), { inDay: "checkout_pending" }))).toContain("checkout_unfinished:red");
  });
  it("chaves estáveis: recriar os ids não muda a chave do achado", () => {
    const a = run(bk({ payments: [pay(50, "Unknown")] })).find((x) => x.code === "unknown_method")!;
    const b = run(bk({ payments: [pay(50, "Unknown", { id: "zz9", pricingId: "l9" })], lines: [line(50, 50, { id: "l9" })] })).find((x) => x.code === "unknown_method")!;
    expect(a.key).toBe(b.key);
    const sk = stableSubKeys(bk({ payments: [pay(10, "Multibanco", { id: "a", recordedAt: "1" }), pay(10, "Multibanco", { id: "b", recordedAt: "2" })] }));
    expect(sk.payment.get("a")).not.toBe(sk.payment.get("b"));
  });
});

describe("reservas que só têm dinheiro no dia", () => {
  const prepaidOnline = bk({ status: "BOOKED", checkOut: "2026-10-17T10:00:00.000Z", bookingPrice: 30, payments: [pay(50, "Online, Card")], intents: [] });
  it("pré-pago online que sai noutro dia: nada hoje (o preço e a Stripe conferem-se no dia da saída)", () => {
    expect(run(prepaidOnline, { inDay: "payment_only" })).toEqual([]);
  });
  it("dinheiro no check-in: aparece a amarelo e o MB precisa de talão", () => {
    const f = run(bk({ status: "CHECKED_IN", checkOut: "2026-10-15T10:00:00.000Z", payments: [pay(20, "Multibanco")] }), { inDay: "payment_only" });
    expect(codes(f)).toEqual(["mb_no_receipt:red", "not_checked_out:amber"]);
  });
  it("pagamento recriado pela Multipark dias depois da saída → vermelho (cenário 9)", () => {
    const f = run(bk({ checkOut: "2026-10-09T10:00:00.000Z", payments: [pay(20, "Numerário", { recordedAt: DAYP })] }), { inDay: "payment_only" });
    expect(codes(f)).toContain("late_payment:red");
  });
  it("cancelada depois do check-in: vermelho com o pago menos o reembolso", () => {
    const f = run(bk({ status: "CANCELLED", refunded: 20 }), { inDay: "cancelled" });
    expect(f.find((x) => x.code === "cancelled_after_checkin")?.amountCents).toBe(3000);
  });
});

describe("auditoria do código, ronda 2", () => {
  const proOrigin = origin({ pro: true, bookingPrice: 50 });
  const settled = (o: Partial<ConfirmBookingLive> = {}) => bk({
    pro: true, checkOut: "2026-09-20T10:00:00.000Z", lines: [line(50, 50)],
    payments: [pay(50, "CARD", { recordedAt: DAYP })], ...o,
  });
  it("ALTO 1: acerto PRO 20 dias depois da saída (CARD) não dá vermelhos no dia nem entra num dia selado", () => {
    const live = settled();
    expect(payKind("CARD")).toBe("off_counter");
    expect(payKind("MIT_OFF_SESSION")).toBe("off_counter");
    expect(run(live, { inDay: "payment_only", origin: proOrigin })).toEqual([]);
    expect(hasCounterInDay(live, new Set(["z1"]), undefined, true)).toBe(false);
    // Nem mesmo se o acerto vier com outro método (ex.: "Multibanco"): é liquidação de uma reserva PRO depois da saída.
    const mb = settled({ payments: [pay(50, "Multibanco", { recordedAt: DAYP })] });
    expect(run(mb, { inDay: "payment_only", origin: proOrigin })).toEqual([]);
    expect(hasCounterInDay(mb, new Set(["z1"]), undefined, true)).toBe(false);
  });
  it("ALTO 1: o selo da saída PRO não muda quando chega o acerto (não reabre o dia da saída)", () => {
    const atCheckout = bk({ pro: true, lines: [line(50, 0)], payments: [] });
    const afterSettle = bk({ pro: true, lines: [line(50, 50)], payments: [pay(50, "CARD", { recordedAt: "2026-11-02T10:00:00.000Z" })] });
    const h = (b: ConfirmBookingLive) => canonicalJson(bookingSealState(b, "checkout", new Set(), undefined, true));
    expect(h(afterSettle)).toBe(h(atCheckout));
    // Numa reserva normal, um pagamento novo depois da saída muda o selo (e reabre).
    expect(canonicalJson(bookingSealState({ ...afterSettle, pro: false }, "checkout", new Set(), undefined, false))).not.toBe(canonicalJson(bookingSealState({ ...atCheckout, pro: false }, "checkout", new Set(), undefined, false)));
  });
  it("MÉDIO 2: taxa paga no MB vai para o MB; reserva PRO não paga taxa ao balcão", () => {
    const mbFee = bk({ fees: 5, payments: [pay(55, "Multibanco")] });
    expect(feeSplitOf(mbFee, new Set(["z1"]), false)).toEqual({ cash: 0, mb: 500 });
    expect(feeSplitOf(bk({ fees: 5 }), new Set(["z1"]), false)).toEqual({ cash: 500, mb: 0 });
    expect(feeSplitOf(bk({ fees: 5, payments: [] }), new Set(), false)).toEqual({ cash: 500, mb: 0 });
    expect(feeSplitOf(bk({ fees: 5, pro: true }), new Set(["z1"]), true)).toEqual({ cash: 0, mb: 0 });
    const s = daySummary({ windowPayments: [{ amount: 55, method: "Multibanco" }], shiftExpenses: 0, fees: { cash: 0, mb: 500 }, shifts: [{ shift: "morning", cash: 0, mb: 60, multiparkTotal: null, byName: null, byId: 1 }, { shift: "night", cash: 0, mb: 0, multiparkTotal: null, byName: null, byId: 1 }], confirmed: { cash: 0, mb: 60 } });
    expect([s.expectedMbCents, s.absDifferenceCents]).toEqual([6000, 0]);
  });
  it("MÉDIO 3: envelope abaixo do que o team leader declarou dá alerta mesmo com o esperado certo", () => {
    const sh: ShiftDeclaration[] = [{ shift: "morning", cash: 250, mb: 0, multiparkTotal: null, byName: null, byId: 1 }, { shift: "night", cash: 250, mb: 0, multiparkTotal: null, byName: null, byId: 1 }];
    const s = daySummary({ windowPayments: [{ amount: 440, method: "Numerário" }], shiftExpenses: 0, fees: { cash: 0, mb: 0 }, shifts: sh, confirmed: { cash: 440, mb: 0 } });
    expect(s.absDifferenceCents).toBe(0);
    expect(s.declaredVsCountedCashCents).toBe(-6000);
    expect(s.alertBasisCents).toBe(6000);
    expect(s.alert).toBe("amber");
  });
  it("MÉDIO 4: memória sem o campo PRO (ou só do payload) → amarelo, sem vermelho falso", () => {
    const live = bk({ pro: true, payments: [], lines: [line(50, 0)] });
    expect(codes(run(live, { origin: origin({ pro: null }) }))).toEqual(["marker_unverified:amber"]);
    expect(codes(run(live, { origin: origin({ fromDb: false, pro: false }) }))).toEqual(["marker_unverified:amber"]);
    expect(codes(run(live, { origin: origin({ pro: false }) }))).toContain("marker_added:red");
  });
  it("MÉDIO 5: avença/plano → aviso amarelo (a memória não guarda quando foi ligada)", () => {
    expect(codes(run(bk({ clientPlanId: "cp1", payments: [], lines: [line(50, 0)] })))).toEqual(["plan_unverified:amber"]);
  });
  it("BAIXO 14: PaymentIntent antigo abandonado não dá vermelho se o pagamento por link foi bem-sucedido", () => {
    const live = bk({ payments: [pay(50, "Online, Card")], intents: [{ id: "pi_link", expected: 50 }, { id: "pi_old", expected: null }] });
    const stripe = new Map<string, StripeCheck | null>([["pi_link", { status: "succeeded", received: 50, refunded: 0, disputed: false }], ["pi_old", { status: "requires_payment_method", received: 0, refunded: 0, disputed: false }]]);
    expect(run(live, { stripe })).toEqual([]);
  });
  it("MÉDIO 7: saída por concluir que fechou depois das 03:00 sai do dia sem o reabrir", () => {
    expect(sealDrift({ b1: "h|000|k|1" }, {})).toEqual({ changed: [], added: [], removed: [] });
    expect(sealDrift({ b1: "h|111|c|1" }, {}).removed).toEqual(["b1"]);
  });
});

describe("justificações", () => {
  const red = { code: "price_down", color: "red" } as const;
  it("motivo da lista, explicação e comprovativo quando é perda", () => {
    expect(justificationProblem({ finding: red, reason: "xpto", explanation: "a".repeat(30), fileCount: 1 })).toMatch(/motivo/);
    expect(justificationProblem({ finding: red, reason: "perda_aceite", explanation: "curta", fileCount: 1 })).toMatch(/20/);
    expect(justificationProblem({ finding: red, reason: "perda_aceite", explanation: "a".repeat(30), fileCount: 0 })).toMatch(/comprovativo/);
    expect(justificationProblem({ finding: red, reason: "perda_aceite", explanation: "a".repeat(30), fileCount: 1 })).toBeNull();
    expect(justificationProblem({ finding: { code: "credit_given", color: "red" }, reason: "cortesia_reclamacao", explanation: "a".repeat(30), fileCount: 0 })).toBeNull();
  });
  const j = (o: Partial<JustificationRef> = {}): JustificationRef => ({ id: 1, findingKey: "k", code: "price_down", amountCents: 500, reason: "outro", explanation: "x", fileIds: [7], decision: null, ...o });
  const f = { code: "price_down" as const, color: "red" as const, amountCents: 500 };
  it("vermelho justificado → amarelo; aprovado → verde; recusado → vermelho", () => {
    expect(resolvedColor(f, null, new Set([7]))).toBe("red");
    expect(resolvedColor(f, j(), new Set([7]))).toBe("amber");
    expect(resolvedColor(f, j({ decision: "aprovado" }), new Set([7]))).toBe("green");
    expect(resolvedColor(f, j({ decision: "recusado" }), new Set([7]))).toBe("red");
  });
  it("a justificação fica presa ao valor e ao comprovativo (achado 4)", () => {
    expect(justificationValid({ ...f, amountCents: 5000 }, j({ decision: "aprovado" }), new Set([7]))).toBe(false);
    expect(resolvedColor({ ...f, amountCents: 5000 }, j({ decision: "aprovado" }), new Set([7]))).toBe("red");
    expect(resolvedColor(f, j({ decision: "aprovado" }), new Set())).toBe("red");
    expect(resolvedColor({ ...f, code: "underpaid" }, j(), new Set([7]))).toBe("red");
  });
});

describe("o dia", () => {
  const sh = (cash: number | null, mb: number | null, byId = 9): ShiftDeclaration[] => [
    { shift: "morning", cash: cash == null ? null : cash / 2, mb: mb == null ? null : mb / 2, multiparkTotal: null, byName: "TL", byId },
    { shift: "night", cash: cash == null ? null : cash / 2, mb: mb == null ? null : mb / 2, multiparkTotal: null, byName: "TL", byId },
  ];
  const pays = [{ amount: 100, method: "Numerário" }, { amount: 50, method: "Multibanco" }, { amount: 70, method: "Online, Card" }];
  it("esperado = dinheiro + taxas − despesas; diferença só depois de o João contar", () => {
    const s = daySummary({ windowPayments: pays, shiftExpenses: 10, fees: { cash: 500, mb: 0 }, shifts: sh(105, 50), confirmed: null });
    expect(s.expectedCashCents).toBe(9500);
    expect(s.expectedMbCents).toBe(5000);
    expect(s.differenceCents).toBeNull();
    expect(s.alert).toBe("none");
    const c = daySummary({ windowPayments: pays, shiftExpenses: 10, fees: { cash: 500, mb: 0 }, shifts: sh(105, 50), confirmed: { cash: 95, mb: 50 } });
    expect([c.cashDiffCents, c.mbDiffCents, c.absDifferenceCents, c.declaredVsCountedCashCents]).toEqual([0, 0, 0, 0]);
  });
  it("cenário A: dinheiro por declarar e envelope por contar → bloqueia", () => {
    const s = daySummary({ windowPayments: pays, shiftExpenses: 0, fees: { cash: 0, mb: 0 }, shifts: sh(null, 50), confirmed: null });
    expect(s.missingShifts).toEqual(["morning", "night"]);
    const b = closeBlockers({ dayClosedAt3am: true, truncated: false, multiparkOk: true, stripe: { available: true, unread: 0 }, views: [], summary: s, noteLen: 100, closerId: 1, declarantIds: [9] });
    expect(b.join(" ")).toMatch(/turno da manhã/);
    expect(b.join(" ")).toMatch(/Conta o envelope/);
  });
  it("cenário B: −60 € em dinheiro e +60 € em MB não se anulam (alerta pelos absolutos)", () => {
    const s = daySummary({ windowPayments: pays, shiftExpenses: 0, fees: { cash: 0, mb: 0 }, shifts: sh(100, 50), confirmed: { cash: 40, mb: 110 } });
    expect(s.differenceCents).toBe(0);
    expect(s.absDifferenceCents).toBe(12000);
    expect(s.alert).toBe("email");
  });
  it("limiares: 30 € não chega; 30,01 € amarelo; 70,01 € email", () => {
    expect(dayAlertOf(3000)).toBe("none");
    expect(dayAlertOf(3001)).toBe("amber");
    expect(dayAlertOf(7000)).toBe("amber");
    expect(dayAlertOf(7001)).toBe("email");
    expect(dayAlertOf(null)).toBe("none");
  });
  it("bloqueios: antes das 03:00, dados cortados, Stripe desligada, vermelhos, diferença sem nota, quem declarou não fecha", () => {
    const s = daySummary({ windowPayments: pays, shiftExpenses: 0, fees: { cash: 0, mb: 0 }, shifts: sh(100, 50), confirmed: { cash: 90, mb: 50 } });
    const live = bk({ bookingPrice: 40, payments: [pay(40, "Online, Card")], lines: [line(40)], intents: [{ id: "pi", expected: 40 }] });
    const ids = new Set(["z1"]);
    const f = run(live, { stripeAvailable: false });
    const view = buildBookingView({ live, origin: origin(), inDay: "checkout", findings: f, windowPaymentIds: ids, justifications: new Map(), activeFileIds: new Set() });
    const b = closeBlockers({ dayClosedAt3am: false, truncated: true, multiparkOk: true, stripe: { available: false, unread: 1 }, views: [view], summary: s, noteLen: 0, closerId: 9, declarantIds: [9] });
    expect(b.length).toBe(6);
  });
  it("depois de fechar: justificações por aprovar, diferença > 30 € ou dia já reaberto → à espera do Jorge", () => {
    const ok = daySummary({ windowPayments: pays, shiftExpenses: 0, fees: { cash: 0, mb: 0 }, shifts: sh(100, 50), confirmed: { cash: 100, mb: 50 } });
    const live = bk({ bookingPrice: 40, payments: [pay(40)], lines: [line(40)] });
    const f = run(live);
    const justs = new Map(f.map((x) => [x.key, { id: 1, findingKey: x.key, code: x.code, amountCents: x.amountCents, reason: "outro", explanation: "x", fileIds: [3], decision: null } as JustificationRef]));
    const pending = buildBookingView({ live, origin: origin(), inDay: "checkout", findings: f, windowPaymentIds: new Set(["z1"]), justifications: justs, activeFileIds: new Set([3]) });
    expect(pending.color).toBe("amber");
    expect(statusAfterClose({ views: [pending], summary: ok, reopenedBefore: false })).toBe("a_aprovar");
    expect(statusAfterClose({ views: [], summary: ok, reopenedBefore: false })).toBe("fechado");
    expect(statusAfterClose({ views: [], summary: ok, reopenedBefore: true })).toBe("a_aprovar");
    const big = daySummary({ windowPayments: pays, shiftExpenses: 0, fees: { cash: 0, mb: 0 }, shifts: sh(100, 50), confirmed: { cash: 60, mb: 50 } });
    expect(statusAfterClose({ views: [], summary: big, reopenedBefore: false })).toBe("a_aprovar");
    // Um vermelho aprovado e um amarelo sem relação não fazem esperar (achado 24).
    const approved = new Map([...justs].map(([k, v]) => [k, { ...v, decision: "aprovado" as const }]));
    const mixed = buildBookingView({ live: bk({ ...live, cashierClosed: V(false) }), origin: origin(), inDay: "checkout", findings: run(bk({ ...live, cashierClosed: V(false) })), windowPaymentIds: new Set(["z1"]), justifications: approved, activeFileIds: new Set([3]) });
    expect(statusAfterClose({ views: [mixed], summary: ok, reopenedBefore: false })).toBe("fechado");
  });
});

describe("selo e varredura", () => {
  const st = (b: ConfirmBookingLive, kind: InDay, ids = new Set(b.payments.map((p) => p.id))) => {
    const h = createHash("sha256").update(canonicalJson(bookingSealState(b, kind, ids)), "utf8").digest("hex");
    const short = kind === "payment_only" ? "p" : kind === "cancelled" ? "x" : "c";
    return [h, kind === "checkout" || kind === "checkout_pending" ? validationFlags(b) : "", short, hasCounterInDay(b, ids) ? "1" : "0"].join("|");
  };
  it("CRÍTICO 1: pré-pago online do dia que sai daqui a 5 dias não reabre o dia", () => {
    const before = bk({ status: "BOOKED", checkOut: "2026-10-17T10:00:00.000Z", payments: [pay(50, "Online, Card")] });
    const after = bk({ status: "CHECKED_OUT", checkOut: "2026-10-17T12:00:00.000Z", bookingPrice: 60, payments: [pay(50, "Online, Card"), pay(10, "Numerário", { id: "z9", recordedAt: "2026-10-17T12:00:00.000Z" })] });
    const sealed = { b1: st(before, "payment_only", new Set(["z1"])) };
    const now = { b1: st(after, "payment_only", new Set(["z1"])) };
    expect(sealDrift(sealed, now)).toEqual({ changed: [], added: [], removed: [] });
  });
  it("acerto PRO com data no passado (sem balcão) não entra num dia selado; dinheiro de balcão novo entra", () => {
    const pro = bk({ id: "b2", pro: true, payments: [pay(80, "PRO_PLAN")] });
    expect(sealDrift({}, { b2: st(pro, "payment_only") }).added).toEqual([]);
    const cash = bk({ id: "b3", status: "CHECKED_IN", payments: [pay(20)] });
    expect(sealDrift({}, { b3: st(cash, "payment_only") }).added).toEqual(["b3"]);
  });
  it("saída: dinheiro mudado, saída nova ou que saiu do dia e validação que volta a 'não' reabrem; passar a 'sim' não", () => {
    const a = bk();
    const sealed = { b1: st(a, "checkout") };
    expect(sealDrift(sealed, { b1: st(a, "checkout") }).changed).toEqual([]);
    expect(sealDrift(sealed, { b1: st(bk({ payments: [pay(50, "Online, Card")] }), "checkout") }).changed).toEqual(["b1"]);
    expect(sealDrift(sealed, { b1: st(bk({ cashierClosed: V(false) }), "checkout") }).changed).toEqual(["b1"]);
    expect(sealDrift({ b1: st(bk({ cashierClosed: V(false) }), "checkout") }, { b1: st(a, "checkout") }).changed).toEqual([]);
    expect(sealDrift(sealed, {}).removed).toEqual(["b1"]);
    expect(sealDrift({}, sealed).added).toEqual(["b1"]);
    // Ids recriados pela Multipark não mudam nada.
    expect(sealDrift(sealed, { b1: st(bk({ payments: [pay(50, "Numerário", { id: "novo", pricingId: "x" })] }), "checkout") }).changed).toEqual([]);
  });
  it("as contas do dia também estão no selo (declarações, despesas, envelope)", () => {
    const sh: ShiftDeclaration[] = [{ shift: "morning", cash: 50, mb: 0, multiparkTotal: 50, byName: null, byId: 1 }, { shift: "night", cash: 50, mb: 0, multiparkTotal: 50, byName: null, byId: 1 }];
    const s1 = daySummary({ windowPayments: [{ amount: 100, method: "Numerário" }], shiftExpenses: 0, fees: { cash: 0, mb: 0 }, shifts: sh, confirmed: { cash: 100, mb: 0 } });
    const seal = JSON.parse(buildSeal({ day: "d", city: "lisbon", summary: s1, states: {}, parkIds: ["p1"], justificationIds: [], fileIds: [], chainHead: "h", status: "fechado" }).json);
    expect(summaryDrift(seal.summary, s1)).toEqual([]);
    const s2 = daySummary({ windowPayments: [{ amount: 100, method: "Numerário" }], shiftExpenses: 20, fees: { cash: 0, mb: 0 }, shifts: sh, confirmed: { cash: 100, mb: 0 } });
    expect(summaryDrift(seal.summary, s2).join(" ")).toMatch(/despesas do turno/);
  });
  it("selo determinístico", () => {
    const summary = daySummary({ windowPayments: [], shiftExpenses: 0, fees: { cash: 0, mb: 0 }, shifts: [], confirmed: null });
    const a = buildSeal({ day: "d", city: "lisbon", summary, states: { x: "1|111|c|1" }, parkIds: ["b", "a"], justificationIds: [2, 1], fileIds: [], chainHead: "h", status: "fechado" });
    const b = buildSeal({ day: "d", city: "lisbon", summary, states: { x: "1|111|c|1" }, parkIds: ["a", "b"], justificationIds: [1, 2], fileIds: [], chainHead: "h", status: "fechado" });
    expect(a.hash).toBe(b.hash);
  });
});

describe("cadeia e integridade", () => {
  const ev = (i: number, prev: string, action = "justificar", data: unknown = { justificationId: i }): StoredEvent => {
    const e: ChainEvent = { day: "2026-10-12", city: "lisbon", at: `2026-10-13 09:00:0${i}.000`, userId: 5326, action, findingKey: "b1:price_down", data };
    return { ...e, id: i, prevHash: prev, hash: eventHash(prev, e) };
  };
  it("a cadeia confere e deteta adulteração", () => {
    const a = ev(1, GENESIS_HASH), b = ev(2, a.hash), c = ev(3, b.hash);
    expect(verifyChain([a, b, c])).toEqual({ ok: true, brokenAt: null });
    expect(verifyChain([a, { ...b, data: { n: 99 } }, c]).brokenAt).toBe(2);
    expect(verifyChain([a, c]).brokenAt).toBe(3);
  });
  it("justificação, decisão ou ficheiro sem evento e selo trocado são apanhados (achado 15)", () => {
    const a = ev(1, GENESIS_HASH);
    expect(verifyIntegrity({ events: [a], seal: { json: null, hash: null }, justificationIds: [1], decisionIds: [], fileIds: [], removedFileIds: [] }).ok).toBe(true);
    expect(verifyIntegrity({ events: [a], seal: { json: null, hash: null }, justificationIds: [1, 2], decisionIds: [], fileIds: [], removedFileIds: [] }).problems.join(" ")).toMatch(/Justificações sem registo/);
    expect(verifyIntegrity({ events: [a], seal: { json: null, hash: null }, justificationIds: [1], decisionIds: [5], fileIds: [], removedFileIds: [] }).ok).toBe(false);
    const json = '{"x":1}';
    const hash = createHash("sha256").update(json).digest("hex");
    const s = ev(2, a.hash, "selar", { sealHash: hash });
    expect(verifyIntegrity({ events: [a, s], seal: { json, hash }, justificationIds: [1], decisionIds: [], fileIds: [], removedFileIds: [] }).ok).toBe(true);
    expect(verifyIntegrity({ events: [a, s], seal: { json: '{"x":2}', hash }, justificationIds: [1], decisionIds: [], fileIds: [], removedFileIds: [] }).ok).toBe(false);
  });
  it("JSON canónico independente da ordem das chaves", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
});

describe("leitura da Multipark", () => {
  it("SQL: saídas, por concluir, canceladas pela data do cancelamento (nunca pelo checkIn), pagamentos; LIMIT + 1", () => {
    const { sql, params } = buildConfirmDaySql({ parkIds: ["p1", "p2"], start: "2026-10-12 02:00:00", end: "2026-10-13 02:00:00" });
    expect(sql).toMatch(/'CHECKED_OUT'/);
    expect(sql).toMatch(/'CHECKING_OUT', 'PENDING_CHECKOUT'/);
    expect(sql).toMatch(/JOIN "Cancellation" cn ON cn."bookingId" = b."id"/);
    expect(sql).toMatch(/cn."createdAt" >= /);
    expect(sql).not.toMatch(/b\."updatedAt" >= /);
    expect(sql).not.toMatch(/b\."checkIn" IS NOT NULL/);
    expect(params).toContain(CONFIRM_BOOKINGS_MAX + 1);
    expect(params).toContain(CONFIRM_PAYMENTS_MAX + 1);
    expect(() => buildConfirmDaySql({ parkIds: [], start: "a", end: "b" })).toThrow();
  });
  it("mapeia o tipo e assinala listas cortadas", () => {
    const r = mapConfirmRow({ rk: 2, booking: { id: "b1", parkId: "p1", status: "CHECKING_OUT", bookingPrice: 50, cashierClosed: true, cashierClosedById: "a1", pro: false },
      lines: [], payments: Array.from({ length: CONFIRM_PAYMENTS_MAX + 1 }, (_, i) => ({ id: `z${i}`, amount: 1, method: "Numerário" })),
      links: [{ pi: "pi_1", amount: 5000, received: 5000 }], billing_pi: [{ pi: "pi_1", amount: 50 }, { pi: "pi_2", amount: 10 }], credit: 2.5, fees: null });
    expect(r.kind).toBe("checkout_pending");
    expect(mapConfirmRow({ rk: 4, booking: { id: "x", parkId: "p" } }).kind).toBe("payment_only");
    expect(r.truncated).toBe(true);
    expect(r.live.payments.length).toBe(CONFIRM_PAYMENTS_MAX);
    expect(r.live.intents).toEqual([{ id: "pi_1", expected: 50 }, { id: "pi_2", expected: 10 }]);
    expect(r.live.cashierClosed).toEqual({ done: true, at: null, by: null, byId: "a1" });
  });
});

describe("só acréscimo e regras do repositório", () => {
  const APPEND_ONLY = ["cash_confirm_events", "cash_confirm_justifications", "cash_confirm_decisions", "cash_confirm_files", "cash_confirm_file_removals", "cash_confirm_stripe_checks"];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
  });
  it("nenhum UPDATE/DELETE/TRUNCATE/REPLACE/DROP nas tabelas só acréscimo (server, shared, client, scripts)", () => {
    const bad: string[] = [];
    for (const dir of ["server", "shared", "client/src", "scripts"].map((d) => join(__dirname, "..", d))) {
      for (const f of walk(dir)) {
        const src = readFileSync(f, "utf8");
        for (const t of APPEND_ONLY) {
          const re = new RegExp(`(UPDATE\\s+\`?${t}\\b|DELETE\\s+FROM\\s+\`?${t}\\b|TRUNCATE\\s+(TABLE\\s+)?\`?${t}\\b|REPLACE\\s+INTO\\s+\`?${t}\\b|DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?\`?${t}\\b)`, "i");
          if (re.test(src)) bad.push(`${f}: ${t}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
  it("migração 0635 registada depois da 0630, sem apagar nada; horas em DATETIME(3)", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0635")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0630"));
    const all = MIGRATION_0635_STATEMENTS.join("\n");
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b|TRUNCATE/i);
    for (const s of MIGRATION_0635_STATEMENTS) expect(s).not.toMatch(/^\s*UPDATE\b/i);
    expect(all).not.toMatch(/`\w+` TIMESTAMP/);
    for (const t of [...APPEND_ONLY, "cash_confirm_days"]) expect(all).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS \`${t}\``));
    for (const c of ["cashierCashReceived", "cashierMbReceived", "cashierMultiparkTotal"]) expect(all).toMatch(new RegExp(`ADD COLUMN \`${c}\``));
    expect(all).toMatch(/UNIQUE KEY `uq_cash_confirm_files_sha`/);
  });
  it("notificações da confirmação só pelo notify()", () => {
    const src = readFileSync(join(__dirname, "cashConfirm.ts"), "utf8");
    expect(src).not.toMatch(/app_notifications/);
    expect(src).toMatch(/kind: "cash_confirm_alert"/);
    expect(src).toMatch(/kind: "cash_confirm_alert_email"/);
    expect(src).toMatch(/kind: "cash_confirm_refused"/);
  });
  it("as ações da confirmação não estão abertas ao MCP e o link dos ficheiros também não", () => {
    const src = readFileSync(join(__dirname, "mcpProceduresApi.ts"), "utf8");
    expect(src).not.toMatch(/"cashCheck\.confirm(Justify|Upload|Close|Decide|Reopen|Values|RemoveFile)"/);
    expect(src).toMatch(/\^cashCheck\\\.confirmFileUrl\$/);
  });
});
