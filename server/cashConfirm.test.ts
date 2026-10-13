import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  toCents, payKind, bookingFindings, buildBookingView, daySummary, dayAlertOf, resolvedColor, justificationProblem, closeBlockers,
  statusAfterClose, canonicalJson, bookingMoneyState, validationFlags, stableSubKeys, eur,
  type ConfirmBookingLive, type ConfirmOrigin, type StripeCheck, type Finding, type JustificationRef,
} from "../shared/cashConfirm";
import { eventHash, verifyChain, sealDrift, buildSeal, GENESIS_HASH, type ChainEvent } from "./cashConfirm";
import { buildConfirmDaySql, mapConfirmRow, CONFIRM_BOOKINGS_MAX, CONFIRM_PAYMENTS_MAX } from "./multiparkDb/cashConfirm";
import { MIGRATION_0635_STATEMENTS } from "./migrations/migration_0635";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

const V = (done = false) => ({ done, at: null, by: null, byId: null });
function bk(o: Partial<ConfirmBookingLive> = {}): ConfirmBookingLive {
  return {
    id: "b1", code: "A1", parkId: "p1", parkName: "Airpark Lisboa", status: "CHECKED_OUT", checkIn: "2026-10-10T08:00:00.000Z", checkOut: "2026-10-12T10:00:00.000Z",
    createdAt: "2026-10-01T10:00:00.000Z", bookingPrice: 50, originalBookingPrice: 50, paymentMethod: "Numerário", campaignId: null, partnerId: null,
    pro: false, clientPlanId: null, allowance: false, checkOutDriverName: "Rui", checkInDriverId: "d1", checkingInAt: null, paymentIntentId: null, stripeChargeId: null,
    credit: null, fees: null, cashierClosed: V(true), cashValidated: V(true), driverValidated: V(true),
    lines: [{ id: "l1", description: "Estacionamento", category: "PARKING", total: 50, amountPaid: 50, extraServiceId: null }],
    payments: [{ id: "z1", pricingId: "l1", amount: 50, method: "Numerário", recordedAt: "2026-10-12T10:00:00.000Z" }],
    intents: [], cancelled: false, refunded: null, ...o,
  };
}
const origin = (o: Partial<ConfirmOrigin> = {}): ConfirmOrigin => ({ source: "webhook", bookingPrice: 50, originalBookingPrice: 50, checkOut: "2026-10-12T10:00:00.000Z", receivedAt: "2026-10-01T10:00:05.000Z", late: false, ...o });
const run = (live: ConfirmBookingLive, extra: Partial<Parameters<typeof bookingFindings>[0]> = {}) => bookingFindings({
  live, origin: origin(), windowPaymentIds: new Set(live.payments.map((p) => p.id)), inDay: "checkout",
  stripe: new Map(), stripeAvailable: true, mbReceipts: [], ...extra,
});
const codes = (f: Finding[]) => f.map((x) => `${x.code}:${x.color}`).sort();

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
    expect(payKind("Numerário")).toBe("cash");
    expect(payKind("dinheiro")).toBe("cash");
    expect(payKind("Multibanco")).toBe("card");
    expect(payKind("Cartão de crédito")).toBe("card");
    expect(payKind("Online, MBWAY")).toBe("online");
    expect(payKind("MB WAY")).toBe("online");
    expect(payKind("Online, Card")).toBe("online");
    expect(payKind("Crédito")).toBe("off_counter");
    expect(payKind("PRO_PLAN")).toBe("off_counter");
    expect(payKind("Transferencia Bancária")).toBe("transfer");
    expect(payKind("Unknown")).toBe("unknown");
    expect(payKind("Depósito")).toBe("unknown");
    expect(payKind("Parkos")).toBe("unknown");
    expect(payKind("Parkos", new Set(["parkos"]))).toBe("off_counter");
  });
});

describe("achados de uma reserva", () => {
  it("tudo certo → nada", () => {
    expect(run(bk())).toEqual([]);
  });
  it("preço desceu → vermelho com o valor", () => {
    const f = run(bk({ bookingPrice: 40, lines: [{ id: "l1", description: "Estacionamento", category: "PARKING", total: 40, amountPaid: 40, extraServiceId: null }], payments: [{ id: "z1", pricingId: "l1", amount: 40, method: "Numerário", recordedAt: "2026-10-12T10:00:00.000Z" }] }));
    const d = f.find((x) => x.code === "price_down")!;
    expect(d.color).toBe("red");
    expect(d.amountCents).toBe(1000);
  });
  it("desconto PRO explica a descida só até ao valor da linha", () => {
    const lines = [
      { id: "l1", description: "Estacionamento", category: "PARKING", total: 50, amountPaid: 0, extraServiceId: null },
      { id: "l2", description: "Desconto PRO", category: "DISCOUNT", total: -5, amountPaid: 0, extraServiceId: null },
    ];
    const ok = run(bk({ pro: true, bookingPrice: 45, lines, payments: [] }));
    expect(ok.some((x) => x.code === "price_down")).toBe(false);
    const more = run(bk({ pro: true, bookingPrice: 40, lines, payments: [] }));
    expect(more.find((x) => x.code === "price_down")?.amountCents).toBe(500);
    // Sem PRO, a linha "Desconto PRO" não explica nada.
    expect(run(bk({ pro: false, bookingPrice: 45, lines, payments: [] })).some((x) => x.code === "price_down")).toBe(true);
  });
  it("sem webhook de criação compara com o original e avisa; sem nada → amarelo", () => {
    const f = bookingFindings({ live: bk({ bookingPrice: 40 }), origin: null, windowPaymentIds: new Set(), inDay: "checkout", stripe: new Map(), stripeAvailable: true, mbReceipts: [] });
    expect(codes(f)).toContain("no_origin:amber");
    expect(codes(f)).toContain("price_down:red");
    const g = bookingFindings({ live: bk({ originalBookingPrice: 0 }), origin: null, windowPaymentIds: new Set(), inDay: "checkout", stripe: new Map(), stripeAvailable: true, mbReceipts: [] });
    expect(codes(g)).toContain("no_origin:amber");
  });
  it("original da Multipark abaixo do que vimos nascer → vermelho; webhook tardio → amarelo", () => {
    expect(codes(run(bk({ originalBookingPrice: 45 })))).toContain("origin_conflict:red");
    const f = bookingFindings({ live: bk(), origin: origin({ late: true }), windowPaymentIds: new Set(["z1"]), inDay: "checkout", stripe: new Map(), stripeAvailable: true, mbReceipts: [] });
    expect(codes(f)).toContain("origin_late:amber");
  });
  it("subida: com taxa/extra ou mais dias é verde; sem causa é amarelo", () => {
    const up = (lines: ConfirmBookingLive["lines"], checkOut = "2026-10-12T10:00:00.000Z") =>
      run(bk({ bookingPrice: 60, checkOut, lines, payments: [{ id: "z1", pricingId: lines[0].id, amount: 60, method: "Numerário", recordedAt: "2026-10-12T10:00:00.000Z" }] }));
    expect(up([{ id: "l1", description: "Estacionamento", category: "PARKING", total: 50, amountPaid: 50, extraServiceId: null }, { id: "l2", description: "Noturno", category: "FEE", total: 10, amountPaid: 10, extraServiceId: null }])
      .some((x) => x.code === "price_up_unexplained")).toBe(false);
    expect(up([{ id: "l1", description: "Estacionamento", category: "PARKING", total: 60, amountPaid: 60, extraServiceId: null }], "2026-10-13T10:00:00.000Z")
      .some((x) => x.code === "price_up_unexplained")).toBe(false);
    expect(codes(up([{ id: "l1", description: "Ajuste", category: "ADJUSTMENT", total: 60, amountPaid: 60, extraServiceId: null }]))).toContain("price_up_unexplained:amber");
  });
  it("pago a menos, crédito, negativo, método desconhecido, fora do balcão numa reserva normal", () => {
    expect(run(bk({ payments: [{ id: "z1", pricingId: "l1", amount: 30, method: "Numerário", recordedAt: null }], lines: [{ id: "l1", description: "Estacionamento", category: "PARKING", total: 50, amountPaid: 30, extraServiceId: null }] }))
      .find((x) => x.code === "underpaid")?.amountCents).toBe(2000);
    expect(codes(run(bk({ credit: 10, payments: [{ id: "z1", pricingId: "l1", amount: 40, method: "Numerário", recordedAt: null }], lines: [{ id: "l1", description: "Estacionamento", category: "PARKING", total: 50, amountPaid: 40, extraServiceId: null }] }))))
      .toEqual(["credit_given:red"]);
    expect(codes(run(bk({ payments: [{ id: "z1", pricingId: "l1", amount: 50, method: "PRO_PLAN", recordedAt: null }] })))).toContain("off_counter_method:red");
    expect(run(bk({ pro: true, payments: [{ id: "z1", pricingId: "l1", amount: 50, method: "PRO_PLAN", recordedAt: null }] })).some((x) => x.code === "off_counter_method")).toBe(false);
    expect(codes(run(bk({ payments: [{ id: "z1", pricingId: "l1", amount: 50, method: "Unknown", recordedAt: null }] })))).toContain("unknown_method:red");
    expect(codes(run(bk({ payments: [{ id: "z1", pricingId: "l1", amount: 60, method: "Numerário", recordedAt: null }, { id: "z2", pricingId: "l1", amount: -10, method: "Numerário", recordedAt: null }] })))).toContain("negative_payment:red");
  });
  it("taxa (BookingFee) entra no devido", () => {
    expect(run(bk({ fees: 5 })).find((x) => x.code === "underpaid")?.amountCents).toBe(500);
  });
  it("linha: pago ≠ pagamentos → vermelho; linha antiga sem pagamentos → amarelo", () => {
    expect(codes(run(bk({ lines: [{ id: "l1", description: "Estacionamento", category: "PARKING", total: 50, amountPaid: 40, extraServiceId: null }] })))).toContain("ledger_mismatch:red");
    expect(codes(run(bk({ lines: [{ id: "l1", description: "Reserva", category: null, total: 50, amountPaid: 50, extraServiceId: null }], payments: [{ id: "z1", pricingId: "lx", amount: 50, method: "Numerário", recordedAt: null }] })))).toContain("legacy_line:amber");
  });
  it("Multibanco: sem talão vermelho; com talão do mesmo valor sai", () => {
    const live = bk({ payments: [{ id: "z1", pricingId: "l1", amount: 50, method: "Multibanco", recordedAt: "2026-10-12T10:00:00.000Z" }] });
    expect(codes(run(live))).toContain("mb_no_receipt:red");
    expect(run(live, { mbReceipts: [{ id: 1, amountCents: 5000, bookingId: "b1" }] }).some((x) => x.code === "mb_no_receipt")).toBe(false);
    // Talão de outra reserva ou de outro valor não serve.
    expect(codes(run(live, { mbReceipts: [{ id: 1, amountCents: 5000, bookingId: "b2" }] }))).toContain("mb_no_receipt:red");
    expect(codes(run(live, { mbReceipts: [{ id: 1, amountCents: 4999, bookingId: "b1" }] }))).toContain("mb_no_receipt:red");
  });
  it("Online: sem Stripe, sem PI, 404 e valor diferente são vermelhos; certo não dá nada", () => {
    const live = bk({ payments: [{ id: "z1", pricingId: "l1", amount: 50, method: "Online, Card", recordedAt: null }], intents: [{ id: "pi_1", expected: 50 }] });
    const ok: StripeCheck = { status: "succeeded", received: 50, refunded: 0, disputed: false };
    expect(codes(run(live, { stripeAvailable: false }))).toContain("online_unverified:red");
    expect(codes(run(bk({ payments: live.payments, intents: [] })))).toContain("online_mismatch:red");
    expect(codes(run(live, { stripe: new Map([["pi_1", null]]) }))).toContain("online_unverified:red");
    expect(codes(run(live, { stripe: new Map() }))).toContain("online_unverified:red");
    expect(codes(run(live, { stripe: new Map([["pi_1", { ...ok, received: 40 }]]) }))).toContain("online_mismatch:red");
    expect(codes(run(live, { stripe: new Map([["pi_1", { ...ok, status: "requires_payment_method" }]]) }))).toContain("online_mismatch:red");
    expect(run(live, { stripe: new Map([["pi_1", ok]]) })).toEqual([]);
  });
  it("validações da Multipark: por fechar amarelo; fora de ordem vermelho", () => {
    expect(codes(run(bk({ cashierClosed: V(false) })))).toEqual(["mp_not_closed:amber"]);
    expect(codes(run(bk({ cashValidated: V(false) })))).toContain("mp_order:red");
  });
  it("cancelada depois do check-in → vermelho com o pago", () => {
    const f = run(bk({ status: "CANCELLED" }), { inDay: "cancelled" });
    expect(f.find((x) => x.code === "cancelled_after_checkin")?.amountCents).toBe(5000);
  });
  it("chaves estáveis: recriar os ids dos pagamentos não muda a chave do achado", () => {
    const a = run(bk({ payments: [{ id: "z1", pricingId: "l1", amount: 50, method: "Unknown", recordedAt: "2026-10-12T10:00:00.000Z" }] })).find((x) => x.code === "unknown_method")!;
    const b = run(bk({ payments: [{ id: "zz9", pricingId: "l9", amount: 50, method: "Unknown", recordedAt: "2026-10-12T10:00:00.000Z" }], lines: [{ id: "l9", description: "Estacionamento", category: "PARKING", total: 50, amountPaid: 50, extraServiceId: null }] })).find((x) => x.code === "unknown_method")!;
    expect(a.key).toBe(b.key);
    const sk = stableSubKeys(bk({ payments: [{ id: "a", pricingId: null, amount: 10, method: "Multibanco", recordedAt: "1" }, { id: "b", pricingId: null, amount: 10, method: "Multibanco", recordedAt: "2" }] }));
    expect(sk.payment.get("a")).not.toBe(sk.payment.get("b"));
  });
});

describe("justificações", () => {
  const red = { code: "price_down", color: "red" } as const;
  it("motivo da lista, explicação e comprovativo quando é perda", () => {
    expect(justificationProblem({ finding: red, reason: "xpto", explanation: "a".repeat(30), fileCount: 1 })).toMatch(/motivo/);
    expect(justificationProblem({ finding: red, reason: "perda_aceite", explanation: "curta", fileCount: 1 })).toMatch(/20/);
    expect(justificationProblem({ finding: red, reason: "perda_aceite", explanation: "a".repeat(30), fileCount: 0 })).toMatch(/comprovativo/);
    expect(justificationProblem({ finding: red, reason: "perda_aceite", explanation: "a".repeat(30), fileCount: 1 })).toBeNull();
    expect(justificationProblem({ finding: { code: "mb_no_receipt", color: "red" }, reason: "talao_em_falta", explanation: "a".repeat(30), fileCount: 0 })).toBeNull();
  });
  it("vermelho justificado → amarelo (à espera do Jorge); aprovado → verde; recusado → vermelho", () => {
    const j = (decision: JustificationRef["decision"]): JustificationRef => ({ id: 1, findingKey: "k", reason: "outro", explanation: "x", fileCount: 0, decision });
    expect(resolvedColor({ color: "red" }, null)).toBe("red");
    expect(resolvedColor({ color: "red" }, j(null))).toBe("amber");
    expect(resolvedColor({ color: "red" }, j("aprovado"))).toBe("green");
    expect(resolvedColor({ color: "red" }, j("recusado"))).toBe("red");
  });
});

describe("o dia", () => {
  const shifts = (cash: number, mb: number) => [{ shift: "morning" as const, cash: cash / 2, mb: mb / 2, multiparkTotal: (cash + mb) / 2, byName: "TL" }, { shift: "night" as const, cash: cash / 2, mb: mb / 2, multiparkTotal: (cash + mb) / 2, byName: "TL" }];
  const pays = [{ amount: 100, method: "Numerário" }, { amount: 50, method: "Multibanco" }, { amount: 70, method: "Online, Card" }];
  it("esperado = dinheiro − despesas; diferença = o que há − esperado", () => {
    const s = daySummary({ windowPayments: pays, shiftExpenses: 10, shifts: shifts(100, 50), confirmed: null });
    expect(s.expectedCashCents).toBe(9000);
    expect(s.expectedMbCents).toBe(5000);
    expect(s.differenceCents).toBe(0);
    expect(s.multiparkTotalGapCents).toBe(0);
    expect(s.alert).toBe("none");
    const short = daySummary({ windowPayments: pays, shiftExpenses: 10, shifts: shifts(100, 50), confirmed: { cash: 50, mb: null } });
    expect(short.differenceCents).toBe(-4000);
    expect(short.alert).toBe("amber");
  });
  it("limiares: 30 € não chega; 30,01 € amarelo; 70,01 € email (também sobras)", () => {
    expect(dayAlertOf(-3000)).toBe("none");
    expect(dayAlertOf(-3001)).toBe("amber");
    expect(dayAlertOf(7000)).toBe("amber");
    expect(dayAlertOf(-7001)).toBe("email");
    expect(dayAlertOf(null)).toBe("none");
  });
  it("turno sem declaração bloqueia o fecho", () => {
    const s = daySummary({ windowPayments: pays, shiftExpenses: 0, shifts: [shifts(100, 50)[0]], confirmed: null });
    expect(s.missingShifts).toEqual(["night"]);
    const b = closeBlockers({ dayClosedAt3am: true, truncated: false, multiparkOk: true, views: [], summary: s, noteLen: 100 });
    expect(b.join(" ")).toMatch(/turno da noite/);
  });
  it("bloqueios: dia por fechar, dados cortados, vermelhos por justificar, diferença sem nota", () => {
    const s = daySummary({ windowPayments: pays, shiftExpenses: 0, shifts: shifts(90, 50), confirmed: null });
    const live = bk({ bookingPrice: 40, payments: [], lines: [] });
    const f = run(live);
    const view = buildBookingView({ live, origin: origin(), inDay: "checkout", findings: f, justifications: new Map() });
    const b = closeBlockers({ dayClosedAt3am: false, truncated: true, multiparkOk: true, views: [view], summary: s, noteLen: 0 });
    expect(b.length).toBe(4);
  });
  it("depois de fechar: justificações por aprovar ou diferença > 30 € → à espera do Jorge", () => {
    const ok = daySummary({ windowPayments: pays, shiftExpenses: 0, shifts: shifts(100, 50), confirmed: null });
    const live = bk({ bookingPrice: 40, payments: [], lines: [] });
    const f = run(live);
    const justs = new Map(f.map((x) => [x.key, { id: 1, findingKey: x.key, reason: "outro", explanation: "x", fileCount: 1, decision: null } as JustificationRef]));
    const pending = buildBookingView({ live, origin: origin(), inDay: "checkout", findings: f, justifications: justs });
    expect(statusAfterClose({ views: [pending], summary: ok })).toBe("a_aprovar");
    expect(statusAfterClose({ views: [], summary: ok })).toBe("fechado");
    const big = daySummary({ windowPayments: pays, shiftExpenses: 0, shifts: shifts(60, 50), confirmed: null });
    expect(statusAfterClose({ views: [], summary: big })).toBe("a_aprovar");
  });
});

describe("cadeia de eventos e selo", () => {
  const ev = (i: number, prev: string): ChainEvent & { id: number; prevHash: string; hash: string } => {
    const e: ChainEvent = { day: "2026-10-12", city: "lisbon", at: `2026-10-13 09:00:0${i}.000`, userId: 5326, action: "justificar", findingKey: "b1:price_down", data: { n: i } };
    return { ...e, id: i, prevHash: prev, hash: eventHash(prev, e) };
  };
  it("a cadeia confere e deteta adulteração", () => {
    const a = ev(1, GENESIS_HASH), b = ev(2, a.hash), c = ev(3, b.hash);
    expect(verifyChain([a, b, c])).toEqual({ ok: true, brokenAt: null });
    expect(verifyChain([a, { ...b, data: { n: 99 } }, c]).brokenAt).toBe(2);
    expect(verifyChain([a, c]).brokenAt).toBe(3);
  });
  it("JSON canónico independente da ordem das chaves", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
  it("selo determinístico", () => {
    const summary = daySummary({ windowPayments: [], shiftExpenses: 0, shifts: [], confirmed: null });
    const a = buildSeal({ day: "d", city: "lisbon", summary, states: { x: "1|111" }, justificationIds: [2, 1], fileIds: [], chainHead: "h", status: "fechado" });
    const b = buildSeal({ day: "d", city: "lisbon", summary, states: { x: "1|111" }, justificationIds: [1, 2], fileIds: [], chainHead: "h", status: "fechado" });
    expect(a.hash).toBe(b.hash);
  });
  it("deriva: dinheiro mudado, reservas que entram/saem e validação que volta a 'não'; passar a 'sim' não conta", () => {
    expect(sealDrift({ a: "h1|111" }, { a: "h1|111" })).toEqual({ changed: [], added: [], removed: [] });
    expect(sealDrift({ a: "h1|011" }, { a: "h1|111" }).changed).toEqual([]);
    expect(sealDrift({ a: "h1|111" }, { a: "h1|110" }).changed).toEqual(["a"]);
    expect(sealDrift({ a: "h1|111" }, { a: "h2|111" }).changed).toEqual(["a"]);
    expect(sealDrift({ a: "h1|111" }, { b: "h1|111" })).toEqual({ changed: [], added: ["b"], removed: ["a"] });
  });
  it("estado da reserva: ids recriados não mudam; dinheiro mudado muda", () => {
    const s1 = canonicalJson(bookingMoneyState(bk()));
    const s2 = canonicalJson(bookingMoneyState(bk({ payments: [{ id: "novo", pricingId: "x", amount: 50, method: "Numerário", recordedAt: "2026-10-12T11:00:00.000Z" }] })));
    expect(s1).toBe(s2);
    expect(canonicalJson(bookingMoneyState(bk({ payments: [{ id: "z1", pricingId: "l1", amount: 50, method: "Online, Card", recordedAt: null }] })))).not.toBe(s1);
    expect(validationFlags(bk())).toBe("111");
  });
});

describe("leitura da Multipark", () => {
  it("SQL: universo do dia, canceladas pelo check-in real (nunca pelo checkIn), LIMIT + 1", () => {
    const { sql, params } = buildConfirmDaySql({ parkIds: ["p1", "p2"], start: "2026-10-12 02:00:00", end: "2026-10-13 02:00:00" });
    expect(sql).toMatch(/'CHECKED_OUT'/);
    expect(sql).toMatch(/"checkInDriverId" IS NOT NULL OR b."checkingInAt" IS NOT NULL/);
    expect(sql).not.toMatch(/b\."checkIn" IS NOT NULL/);
    expect(params).toContain(CONFIRM_BOOKINGS_MAX + 1);
    expect(params).toContain(CONFIRM_PAYMENTS_MAX + 1);
    expect(() => buildConfirmDaySql({ parkIds: [], start: "a", end: "b" })).toThrow();
  });
  it("mapeia e assinala listas cortadas", () => {
    const r = mapConfirmRow({ rk: 1, booking: { id: "b1", parkId: "p1", status: "CHECKED_OUT", bookingPrice: 50, cashierClosed: true, cashierClosedById: "a1", pro: false },
      lines: [], payments: Array.from({ length: CONFIRM_PAYMENTS_MAX + 1 }, (_, i) => ({ id: `z${i}`, amount: 1, method: "Numerário" })),
      links: [{ pi: "pi_1", amount: 5000, received: 5000 }], billing_pi: [{ pi: "pi_1", amount: 50 }, { pi: "pi_2", amount: 10 }], credit: 2.5, fees: null });
    expect(r.kind).toBe("checkout");
    expect(r.truncated).toBe(true);
    expect(r.live.payments.length).toBe(CONFIRM_PAYMENTS_MAX);
    expect(r.live.intents).toEqual([{ id: "pi_1", expected: 50 }, { id: "pi_2", expected: 10 }]);
    expect(r.live.cashierClosed).toEqual({ done: true, at: null, by: null, byId: "a1" });
    expect(r.live.credit).toBe(2.5);
  });
});

describe("só acréscimo", () => {
  const APPEND_ONLY = ["cash_confirm_events", "cash_confirm_justifications", "cash_confirm_decisions", "cash_confirm_files", "cash_confirm_file_removals"];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" ? [] : walk(p);
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
  });
  it("nenhum UPDATE/DELETE/TRUNCATE/REPLACE nas tabelas da confirmação", () => {
    const bad: string[] = [];
    for (const f of walk(join(__dirname))) {
      const src = readFileSync(f, "utf8");
      for (const t of APPEND_ONLY) {
        const re = new RegExp(`(UPDATE\\s+\`?${t}\\b|DELETE\\s+FROM\\s+\`?${t}\\b|TRUNCATE\\s+(TABLE\\s+)?\`?${t}\\b|REPLACE\\s+INTO\\s+\`?${t}\\b|DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?\`?${t}\\b)`, "i");
        if (re.test(src)) bad.push(`${f}: ${t}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("migração 0635 registada no fim (depois da 0630), sem apagar nada", () => {
    expect(SCHEMA_MIGRATION_IDS[SCHEMA_MIGRATION_IDS.length - 1]).toBe("0635");
    expect(SCHEMA_MIGRATION_IDS.indexOf("0635")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0630"));
    expect(MIGRATION_0635_STATEMENTS.join("\n")).not.toMatch(/\bDELETE\b|\bDROP\b|TRUNCATE/i);
    for (const s of MIGRATION_0635_STATEMENTS) expect(s).not.toMatch(/^\s*UPDATE\b/i);
  });
  it("a migração cria as tabelas e os campos da passagem de turno", () => {
    const all = MIGRATION_0635_STATEMENTS.join("\n");
    for (const t of [...APPEND_ONLY, "cash_confirm_days"]) expect(all).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS \`${t}\``));
    for (const c of ["cashierCashReceived", "cashierMbReceived", "cashierMultiparkTotal"]) expect(all).toMatch(new RegExp(`ADD COLUMN \`${c}\``));
    expect(all).toMatch(/UNIQUE KEY `uq_cash_confirm_files_sha`/);
  });
});
