import { SCHEMA_MIGRATION_IDS } from "../migrations/index";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  invoiceExternalFinding, invoicesToRead, intentsOf, matchMbReceipts, matchViva, mbDayFinding, methodKind, monthlyKindOf, monthlyReceiptFinding,
  onlineNoIntentFinding, parseAmount, parseDate, parseVivaCsv, stripeExternalFinding,
} from "./externalRules";
import { EXTERNAL_CODES, SWEEP_LABELS } from "./sweepRules";
import { ixConfigured, ixGetDocument, ixPathFor, mapIxDocument } from "../external/invoiceExpress";
import { mapPaymentIntent, stripeGetPayment, stripeKeyState, stripeRecentEvents } from "../external/stripe";
import { buildBookingsByIntentSql, buildExternalCheckoutsSql, buildMonthArrearsSql, buildMonthDuesSql, buildPaymentsInWindowSql, mapExternalBookingRow } from "../multiparkDb/cashExternal";
import { mapVivaTransactions, vivaConfigured, vivaTransactionsOfDay } from "../external/vivaWallet";
import { AUTOMATION_FLAGS, automationFlagDefault } from "../../shared/appSettings";
import { assertReadOnlySql } from "../multiparkDb/client";
import { MIGRATION_0275_STATEMENTS } from "../migrations/migration_0275";
import type { ExternalBooking, RecordedPayment } from "../multiparkDb/cashExternal";

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

const bk = (o: Partial<ExternalBooking> = {}): ExternalBooking => ({
  id: "b1", code: "A1", parkId: "pA", status: "CHECKED_OUT", checkOut: "2026-09-28T10:00:00.000Z", bookingPrice: 50, paid: 50, paymentSource: "STRIPE",
  paymentMethod: "Multibanco", onlinePaid: null, paymentIntentId: null, stripeChargeId: null, cancelled: false, refundedAmount: null, billing: [], links: [], ...o,
});
const jsonRes = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe("caixa fase 4: InvoiceExpress (R19)", () => {
  it("só GET, sem chaves = não configurado, tipo → caminho", async () => {
    expect(ixConfigured({})).toBe(false);
    expect(await ixGetDocument("1", "INVOICE_RECEIPT", { env: {} })).toEqual({ ok: false, reason: "not_configured" });
    expect(ixPathFor("INVOICE_RECEIPT")).toBe("invoice_receipts");
    expect(ixPathFor("CREDIT_NOTE")).toBe("credit_notes");
    expect(ixPathFor(null)).toBe("invoices");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = { INVOICEXPRESS_ACCOUNT: "multipark", INVOICEXPRESS_API_KEY: "k" } as NodeJS.ProcessEnv;
    const r = await ixGetDocument("77", "INVOICE_RECEIPT", { env, fetch: async (url, init) => { calls.push({ url, init }); return jsonRes(200, { invoice_receipt: { id: 77, status: "final", total: "45.0" } }); } });
    expect(r).toMatchObject({ ok: true, doc: { id: "77", total: 45, status: "final" } });
    expect(calls[0].url).toMatch(/^https:\/\/multipark\.app\.invoicexpress\.com\/invoice_receipts\/77\.json\?api_key=/);
    expect(calls[0].init?.method).toBe("GET");
    expect(await ixGetDocument("9", null, { env, fetch: async () => jsonRes(404, {}) })).toEqual({ ok: false, reason: "not_found" });
    expect(mapIxDocument({ credit_note: { id: 3, sum: 10 } }, "credit_notes")).toMatchObject({ id: "3", total: 10 });
  });
  it("inexistente, anulada ou valor diferente → caso; sem resposta → não conclui", () => {
    const b = bk({ billing: [{ id: "x", invoiceExpressId: 77, type: "INVOICE_RECEIPT", amount: 50, emitted: true, paymentIntentId: null }] });
    expect(invoicesToRead([b])).toEqual([{ id: 77, type: "INVOICE_RECEIPT" }]);
    const ok = new Map([[77, { ok: true as const, doc: { id: "77", type: "invoice_receipts", status: "final", total: 50, date: null, number: null } }]]);
    expect(invoiceExternalFinding(b, ok)).toBeNull();
    const diff = new Map([[77, { ok: true as const, doc: { id: "77", type: "invoice_receipts", status: "final", total: 40, date: null, number: null } }]]);
    expect(invoiceExternalFinding(b, diff)).toMatchObject({ code: "invoice_external", rule: "R19" });
    expect(invoiceExternalFinding(b, diff)!.detail).toContain("Multipark 50,00 €, InvoiceExpress 40,00 €");
    const voided = new Map([[77, { ok: true as const, doc: { id: "77", type: "invoice_receipts", status: "canceled", total: 50, date: null, number: null } }]]);
    expect(invoiceExternalFinding(b, voided)!.detail).toContain("canceled");
    expect(invoiceExternalFinding(b, new Map([[77, { ok: false as const, reason: "not_found" as const }]]))!.detail).toContain("não existe");
    expect(invoiceExternalFinding(b, new Map([[77, { ok: false as const, reason: "error" as const }]]))).toBeNull();
  });
});

describe("caixa fase 4: Stripe (R20)", () => {
  it("só chaves restritas (rk_); sk_ recusada; GET com Bearer; 404 = não visível", async () => {
    expect(stripeKeyState({})).toBe("not_configured");
    expect(stripeKeyState({ STRIPE_READ_KEY: "sk_live_x" } as NodeJS.ProcessEnv)).toBe("not_restricted");
    expect(stripeKeyState({ STRIPE_READ_KEY: "rk_live_x" } as NodeJS.ProcessEnv)).toBe("ok");
    expect(await stripeGetPayment("pi_1", { env: { STRIPE_READ_KEY: "sk_live_x" } as NodeJS.ProcessEnv })).toEqual({ ok: false, detail: "not_restricted" });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = { STRIPE_READ_KEY: "rk_live_abc" } as NodeJS.ProcessEnv;
    const r = await stripeGetPayment("pi_1", { env, fetch: async (url, init) => { calls.push({ url, init }); return jsonRes(200, { id: "pi_1", status: "succeeded", amount: 5000, amount_received: 5000, latest_charge: { id: "ch_1", amount_refunded: 1000, disputed: false } }); } });
    expect(r).toEqual({ ok: true, payment: { id: "pi_1", status: "succeeded", amount: 50, received: 50, refunded: 10, disputed: false, chargeId: "ch_1" } });
    expect(calls[0].init?.method).toBe("GET");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer rk_live_abc");
    expect(await stripeGetPayment("pi_x", { env, fetch: async () => jsonRes(404, {}) })).toEqual({ ok: true, payment: null });
    const ev = await stripeRecentEvents(1, { env, fetch: async (url) => jsonRes(200, { data: [{ id: url.includes("refunds") ? "re_1" : "dp_1", payment_intent: "pi_1", amount: 1000, status: "x", created: 5 }] }) });
    expect(ev.ok && ev.events.map((e) => e.kind)).toEqual(["refund", "dispute"]);
    expect(mapPaymentIntent(null)).toBeNull();
  });
  it("pagamentos de uma reserva: links pagos, faturas e o da reserva", () => {
    const m = intentsOf(bk({ paymentIntentId: "pi_b", links: [{ paymentIntentId: "pi_l", amount: 20, received: 20, status: "SETTLED" }, { paymentIntentId: "pi_f", amount: 5, received: null, status: "FAILED" }],
      billing: [{ id: "x", invoiceExpressId: 1, type: "INVOICE_RECEIPT", amount: 30, emitted: true, paymentIntentId: "pi_i" }] }));
    expect([...m]).toEqual([["pi_l", 20], ["pi_i", 30], ["pi_b", null]]);
  });
  it("não cobrado, valor diferente, reembolso sem cancelamento, disputa", () => {
    const b = bk({ billing: [{ id: "x", invoiceExpressId: 1, type: "INVOICE_RECEIPT", amount: 50, emitted: true, paymentIntentId: "pi_1" }] });
    const pay = (o: object) => new Map([["pi_1", { id: "pi_1", status: "succeeded", amount: 50, received: 50, refunded: 0, disputed: false, chargeId: "ch", ...o }]]);
    expect(stripeExternalFinding(b, pay({}))).toBeNull();
    expect(stripeExternalFinding(b, pay({ status: "requires_payment_method" }))!.detail).toContain("requires_payment_method");
    expect(stripeExternalFinding(b, pay({ received: 45 }))!.detail).toContain("Stripe recebeu 45,00 €");
    expect(stripeExternalFinding(b, pay({ refunded: 50 }))!.detail).toContain("sem cancelamento");
    expect(stripeExternalFinding({ ...b, cancelled: true, refundedAmount: 50 }, pay({ refunded: 50 }))).toBeNull();
    expect(stripeExternalFinding(b, pay({ disputed: true }))).toMatchObject({ code: "stripe_external", rule: "R20" });
    expect(stripeExternalFinding(b, new Map([["pi_1", null]]))).toBeNull();
    expect(stripeExternalFinding(b, pay({}), [{ kind: "dispute", id: "dp", paymentIntent: "pi_1", charge: null, amount: 50, status: "needs_response", created: 1 }])!.detail).toContain("disputa");
  });
});

describe("caixa fase 4: leituras ao vivo (só leitura)", () => {
  it("saídas, por pagamento, pagamentos e referências: SQL de leitura com LIMIT", () => {
    for (const q of [
      buildExternalCheckoutsSql({ parkIds: ["pA"], start: "2026-09-26 23:00:00", end: "2026-09-28 23:00:00" }),
      buildBookingsByIntentSql({ parkIds: ["pA"], intents: ["pi_1"] }),
      buildPaymentsInWindowSql({ parkIds: ["pA"], start: "2026-09-26 23:00:00", end: "2026-09-28 23:00:00" }),
      buildMonthDuesSql({ parkIds: ["pA"], start: "2026-08-31 23:00:00", end: "2026-09-30 23:00:00" }),
      buildMonthArrearsSql({ parkIds: ["pA"], start: "2025-08-31 23:00:00", end: "2026-08-31 23:00:00" }),
    ]) {
      expect(() => assertReadOnlySql(q.sql)).not.toThrow();
      expect(q.sql).toMatch(/LIMIT \$\d+/);
    }
    const row = mapExternalBookingRow({ id: "b", code: "A1", billing: JSON.stringify([{ id: "x", ix: 7, type: "INVOICE", amount: 10, emitted: true, pi: "pi_1" }]), links: [{ pi: "pi_2", amount: 1050, received: 1050, status: "SETTLED" }], cancelled: "f" });
    expect(row.billing[0]).toEqual({ id: "x", invoiceExpressId: 7, type: "INVOICE", amount: 10, emitted: true, paymentIntentId: "pi_1" });
    expect(row.links[0]).toEqual({ paymentIntentId: "pi_2", amount: 10.5, received: 10.5, status: "SETTLED" });
    expect(row.cancelled).toBe(false);
  });
});

describe("caixa fase 4: online (R20, só Multipark)", () => {
  it("pago online sem pagamento Stripe na Multipark → caso; com id → ok", () => {
    expect(onlineNoIntentFinding(bk({ paymentMethod: "Online", onlinePaid: 45 }))).toMatchObject({ code: "online_no_intent", rule: "R20" });
    expect(onlineNoIntentFinding(bk({ paymentMethod: "Stripe, Online", onlinePaid: null }))!.detail).toContain("Stripe, Online");
    expect(onlineNoIntentFinding(bk({ paymentMethod: "Online", onlinePaid: 45, paymentIntentId: "pi_1" }))).toBeNull();
    expect(onlineNoIntentFinding(bk({ paymentMethod: "Online", links: [{ paymentIntentId: "pi_2", amount: 45, received: 45, status: "SETTLED" }] }))).toBeNull();
    expect(onlineNoIntentFinding(bk({ paymentMethod: "Multibanco" }))).toBeNull();
    expect(onlineNoIntentFinding(bk({ paymentMethod: "Online", cancelled: true }))).toBeNull();
  });
  it("métodos de pagamento (os nomes da Multipark)", () => {
    expect(methodKind("Dinheiro")).toBe("cash");
    expect(methodKind("Numerário")).toBe("cash");
    expect(methodKind("Multibanco")).toBe("card");
    expect(methodKind("MB Way")).toBe("mbway");
    expect(methodKind("Transferência")).toBe("transfer");
    expect(methodKind("Stripe, Online")).toBe("online");
    expect(methodKind("Online")).toBe("online");
  });
});

describe("caixa fase 4: multibanco (R30)", () => {
  const pay = (o: Partial<RecordedPayment>): RecordedPayment => ({ bookingId: "b1", code: "A1", parkId: "pA", amount: 10, method: "Multibanco", recordedAt: "2026-09-28T10:00:00.000Z", ...o });
  it("talões: ligam pelo valor, o da reserva escolhida primeiro; o resto fica sem talão ou a mais", () => {
    const pays = [pay({ bookingId: "b1", amount: 20 }), pay({ bookingId: "b2", code: "A2", amount: 20 }), pay({ bookingId: "b3", code: "A3", amount: 35 }), pay({ bookingId: "b4", amount: 99, method: "Dinheiro" })];
    const m = matchMbReceipts({ payments: pays, receipts: [{ id: 1, amount: 20, bookingId: null }, { id: 2, amount: 20, bookingId: "b2" }, { id: 3, amount: 7, bookingId: null }] });
    expect([...m.byPayment]).toEqual([[1, 2], [0, 1]]);
    expect(m.unmatchedPayments.map((p) => p.bookingId)).toEqual(["b3"]);
    expect(m.extraReceipts.map((r) => r.id)).toEqual([3]);
    const f = mbDayFinding({ parkName: "Airpark", day: "2026-09-28", unmatchedPayments: m.unmatchedPayments, extraReceipts: m.extraReceipts })!;
    expect(f).toMatchObject({ code: "mb_unconfirmed", rule: "R30" });
    expect(f.detail).toContain("#A3 35,00 €");
    expect(f.detail).toContain("1 talão(ões) sem pagamento");
    expect(mbDayFinding({ parkName: null, day: "x", unmatchedPayments: [], extraReceipts: [] })).toBeNull();
  });
  it("Viva Wallet: mesmo dia primeiro, depois o seguinte; links não contam", () => {
    const txns = [
      { id: "t1", at: "2026-09-28T09:00:00.000Z", amount: 20, channel: "terminal" as const, status: "F", terminalId: "T", sourceCode: null },
      { id: "t2", at: "2026-09-29T08:00:00.000Z", amount: 35, channel: "terminal" as const, status: "F", terminalId: "T", sourceCode: null },
      { id: "t3", at: "2026-09-28T09:00:00.000Z", amount: 50, channel: "link" as const, status: "F", terminalId: null, sourceCode: null },
      { id: "t4", at: "2026-09-28T11:00:00.000Z", amount: 5, channel: "terminal" as const, status: "F", terminalId: "T", sourceCode: null },
    ];
    const m = matchViva({ days: ["2026-09-28"], txns, payments: [pay({ bookingId: "b1", amount: 20 }), pay({ bookingId: "b2", amount: 35 }), pay({ bookingId: "b3", amount: 50 }), pay({ bookingId: "b5", amount: 12, method: "Dinheiro" })] });
    expect(m.matched.map((x) => [x.bookingId, x.txnId])).toEqual([["b1", "t1"], ["b2", "t2"]]);
    expect([...m.missing.keys()]).toEqual(["b3"]);
    expect(m.extra.map((t) => t.id)).toEqual(["t4"]);
  });
  it("CSV exportado da Viva (como o comparador antigo): Date, Time, Amount, Channel", () => {
    const r = parseVivaCsv("Date;Time;Amount;Channel;Transaction Id\n28/09/2026;10:15:00;20,00;Card Present (VivaPayments Host);abc\n28/09/2026;11:00:00;-20,00;Card Present (VivaPayments Host);ref\n28/09/2026;12:00:00;15,50;Smart Checkout;lnk\nx;;;\n");
    expect(r.txns.map((t) => [t.id, t.amount, t.channel])).toEqual([["abc", 20, "terminal"], ["lnk", 15.5, "link"]]);
    expect(r.txns[0].at).toBe("2026-09-28T09:15:00.000Z");
    expect(r.errors).toHaveLength(1);
    expect(parseVivaCsv("a;b\n1;2").errors[0]).toContain("cabeçalho");
    expect(parseAmount("1.234,56 €")).toBe(1234.56);
    expect(parseDate("29.09.26")).toBe("2026-09-29");
  });
  it("API da Viva: só GET com autenticação básica; sem chaves não configurado; tira reembolsos e não finalizadas", async () => {
    expect(vivaConfigured({})).toBe(false);
    expect(await vivaTransactionsOfDay("2026-09-28", { env: {} })).toEqual({ ok: false, detail: "not_configured" });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = { VIVA_MERCHANT_ID: "m", VIVA_API_KEY: "k" } as NodeJS.ProcessEnv;
    const r = await vivaTransactionsOfDay("2026-09-28", { env, fetch: async (url, init) => { calls.push({ url, init }); return jsonRes(200, { Transactions: [
      { TransactionId: "a", Amount: 20, InsDate: "2026-09-28T10:00:00+01:00", StatusId: "F", TransactionTypeId: 5, TerminalId: 123 },
      { TransactionId: "b", Amount: 20, StatusId: "F", TransactionTypeId: 7 },
      { TransactionId: "c", Amount: 9, StatusId: "E" },
    ] }); } });
    expect(r.ok && r.txns.map((t) => [t.id, t.channel])).toEqual([["a", "terminal"]]);
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].url).toContain("date=2026-09-28");
    expect(String((calls[0].init?.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
    expect(mapVivaTransactions(null)).toEqual([]);
  });
});

describe("caixa fase 4: recebimentos mensais (R17)", () => {
  it("agregador vs agente pelo tipo da Multipark; recebido ≠ devido → caso", () => {
    expect(monthlyKindOf("AGGREGATOR")).toBe("agregador");
    expect(monthlyKindOf("AGENCY")).toBe("agente");
    expect(monthlyReceiptFinding({ kind: "agregador", name: "Parkos", month: "2026-09", received: 100, due: 100 })).toBeNull();
    const f = monthlyReceiptFinding({ kind: "agregador", name: "Parkos", month: "2026-09", received: 90, due: 100 })!;
    expect(f).toMatchObject({ code: "monthly_receipt", rule: "R17" });
    expect(f.detail).toContain("faltam 10,00 €");
    expect(monthlyReceiptFinding({ kind: "pro", name: "X", month: "2026-09", received: 90, due: null })).toBeNull();
    // Meses em atraso (decisão do dono): pagar a mais até ao que está em atraso não é diferença.
    expect(monthlyReceiptFinding({ kind: "pro", name: "X", month: "2026-09", received: 150, due: 100, arrears: 60 })).toBeNull();
    expect(monthlyReceiptFinding({ kind: "pro", name: "X", month: "2026-09", received: 170, due: 100, arrears: 60 })!.detail).toContain("a mais 10,00 €");
    expect(monthlyReceiptFinding({ kind: "pro", name: "X", month: "2026-09", received: 80, due: 100, arrears: 60 })!.detail).toContain("60,00 € em atraso");
  });
});

describe("caixa fase 4: interruptores", () => {
  it("Stripe, Viva Wallet e InvoiceExpress: desligados por omissão e só o super admin muda", () => {
    for (const n of ["CASH_STRIPE_CHECK", "CASH_VIVA_CHECK", "CASH_INVOICEXPRESS_CHECK"]) {
      expect(automationFlagDefault(n)).toBe(false);
      expect(AUTOMATION_FLAGS.find((f) => f.name === n)?.superAdminOnly).toBe(true);
    }
    const src = read("server/cashExternal.ts");
    expect(src).toContain('on("CASH_STRIPE_CHECK")');
    expect(src).toContain('on("CASH_VIVA_CHECK")');
    expect(src).toContain('on("CASH_INVOICEXPRESS_CHECK")');
  });
});

describe("caixa fase 4: ligações", () => {
  it("códigos novos e a varredura não os resolve", () => {
    for (const c of EXTERNAL_CODES) expect(SWEEP_LABELS[c]).toBeDefined();
    expect(read("server/cashSweep.ts")).toContain("!EXTERNAL_CODES.has(c as SweepCode)");
  });
  it("migração 0275 só cria tabelas e está registada", () => {
    const all = MIGRATION_0275_STATEMENTS.join("\n");
    for (const t of ["cash_external_runs", "cash_mb_receipts", "cash_mb_days", "cash_viva_imports", "cash_viva_txns", "cash_monthly_receipts"]) expect(all).toContain(`CREATE TABLE IF NOT EXISTS \`${t}\``);
    expect(all).not.toMatch(/DROP|DELETE|TRUNCATE/i);
    expect(SCHEMA_MIGRATION_IDS).toContain("0275");
  });
  it("cron cash-external registado nos 4 sítios + ajuda", () => {
    expect(read("server/cronSchedule.ts")).toContain('key: "cash-external"');
    expect(read("server/cronScheduler.ts")).toContain('"cash-external"');
    expect(read("shared/appSettings.ts")).toContain('name: "cash-external"');
    expect(read("server/_core/api-entry.ts")).toContain('"/api/cron/cash-external"');
    expect(read("docs/ajuda/agendador.md")).toContain("cash-external");
  });
  it("nunca escreve fora: só GET nos clientes externos", () => {
    for (const f of ["server/external/invoiceExpress.ts", "server/external/stripe.ts", "server/external/vivaWallet.ts"]) {
      const src = read(f);
      expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    }
  });
});
