import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  invoiceExternalFinding, invoicesToRead, intentsOf, matchBank, matchPartner, matchTpa, methodKind, parseAmount, parseDate, parseStatementCsv, stripeExternalFinding,
} from "./externalRules";
import { EXTERNAL_CODES, SWEEP_LABELS } from "./sweepRules";
import { ixConfigured, ixGetDocument, ixPathFor, mapIxDocument } from "../external/invoiceExpress";
import { mapPaymentIntent, stripeGetPayment, stripeKeyState, stripeRecentEvents } from "../external/stripe";
import { buildBookingsByIntentSql, buildExternalCheckoutsSql, buildPartnerDueSql, buildPaymentsInWindowSql, mapExternalBookingRow } from "../multiparkDb/cashExternal";
import { assertReadOnlySql } from "../multiparkDb/client";
import { MIGRATION_0275_STATEMENTS } from "../migrations/migration_0275";
import type { ExternalBooking, RecordedPayment } from "../multiparkDb/cashExternal";

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

const bk = (o: Partial<ExternalBooking> = {}): ExternalBooking => ({
  id: "b1", code: "A1", parkId: "pA", status: "CHECKED_OUT", checkOut: "2026-09-28T10:00:00.000Z", bookingPrice: 50, paid: 50, paymentSource: "STRIPE",
  paymentIntentId: null, stripeChargeId: null, cancelled: false, refundedAmount: null, billing: [], links: [], ...o,
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
      buildPartnerDueSql({ parkIds: ["pA"], refs: ["PK-1"] }),
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

describe("caixa fase 4: extratos em CSV", () => {
  it("números e datas à portuguesa", () => {
    expect(parseAmount("1.234,56 €")).toBe(1234.56);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("(12,50)")).toBe(-12.5);
    expect(parseAmount("12,5-")).toBe(-12.5);
    expect(parseAmount("abc")).toBeNull();
    expect(parseDate("29/09/2026")).toBe("2026-09-29");
    expect(parseDate("2026-09-29 10:00")).toBe("2026-09-29");
    expect(parseDate("29.09.26")).toBe("2026-09-29");
    expect(parseDate("31/13/2026")).toBeNull();
  });
  it("separador, cabeçalhos com outros nomes, crédito/débito e linhas más", () => {
    const p = parseStatementCsv("﻿Extrato conta 123\nData Movimento;Descrição;Débito;Crédito\n28/09/2026;TRF JOAO;;45,00\n28/09/2026;COMISSAO;1,50;\nlixo;;;\n");
    expect(p.delimiter).toBe(";");
    expect(p.lines).toEqual([
      { lineNo: 3, date: "2026-09-28", amount: 45, reference: null, description: "TRF JOAO" },
      { lineNo: 4, date: "2026-09-28", amount: -1.5, reference: null, description: "COMISSAO" },
    ]);
    expect(p.errors).toHaveLength(1);
    const c = parseStatementCsv('date,booking reference,amount\n2026-09-28,"PK-1",12.50\n');
    expect(c.lines[0]).toMatchObject({ reference: "PK-1", amount: 12.5 });
    expect(parseStatementCsv("a;b\n1;2").errors[0]).toContain("cabeçalho");
  });
  it("métodos de pagamento", () => {
    expect(methodKind("Dinheiro")).toBe("cash");
    expect(methodKind("Cartão")).toBe("card");
    expect(methodKind("MULTIBANCO")).toBe("card");
    expect(methodKind("MB Way")).toBe("mbway");
    expect(methodKind("Transferência")).toBe("transfer");
    expect(methodKind("Stripe")).toBe("online");
  });
});

describe("caixa fase 4: cruzar extratos", () => {
  const pay = (o: Partial<RecordedPayment>): RecordedPayment => ({ bookingId: "b1", code: "A1", parkId: "pA", amount: 10, method: "Cartão", recordedAt: "2026-09-28T10:00:00.000Z", ...o });
  it("R30 terminal: soma do dia contra cartão/multibanco desse dia", () => {
    const lines = [{ lineNo: 2, date: "2026-09-28", amount: 30, reference: null, description: null }, { lineNo: 3, date: "2026-09-29", amount: 10, reference: null, description: null }];
    const out = matchTpa({ parkName: "Airpark", lines, payments: [pay({ amount: 20 }), pay({ amount: 10, method: "Multibanco" }), pay({ amount: 99, method: "Dinheiro" }), pay({ amount: 5, recordedAt: "2026-09-29T09:00:00.000Z" })] });
    expect(out[0]).toMatchObject({ day: "2026-09-28", statement: 30, multipark: 30, payments: 2, finding: null });
    expect(out[1].finding).toMatchObject({ code: "tpa_mismatch", rule: "R30" });
    expect(out[1].finding!.detail).toContain("o terminal recebeu mais 5,00 €");
  });
  it("R31 banco: transferência casa com entrada do mesmo valor até 5 dias; senão fica em falta", () => {
    const lines = [{ lineNo: 2, date: "2026-09-02", amount: 45, reference: null, description: "TRF" }, { lineNo: 3, date: "2026-09-03", amount: 99, reference: null, description: "?" }];
    const m = matchBank({ lines, payments: [pay({ bookingId: "b1", amount: 45, method: "Transferência", recordedAt: "2026-09-01T10:00:00.000Z" }), pay({ bookingId: "b2", amount: 60, method: "Transferência", recordedAt: "2026-09-01T10:00:00.000Z" }), pay({ bookingId: "b3", amount: 70, method: "Transferência", recordedAt: "2026-09-09T10:00:00.000Z" }), pay({ bookingId: "b4", amount: 80, method: "Transferência", recordedAt: "2026-08-30T10:00:00.000Z" })], periodStart: "2026-08-30", periodEnd: "2026-09-10" });
    expect(m.matched).toEqual([{ lineNo: 2, bookingId: "b1", code: "A1", amount: 45 }]);
    expect(m.unmatchedLines.map((l) => l.lineNo)).toEqual([3]);
    expect([...m.missing.keys()]).toEqual(["b2"]); // b3 ainda dentro do prazo; b4 podia ter entrado antes do extrato
  });
  it("R17 parceiro: referência + valor contra o devido", () => {
    const rows = [{ id: "b1", code: "A1", externalReference: "PK-1", parkId: "pA", partnerId: "p", status: "CHECKED_OUT", due: 12, paidToUs: null },
      { id: "b2", code: "A2", externalReference: "PK-2", parkId: "pA", partnerId: "p", status: "CHECKED_OUT", due: 8, paidToUs: null }];
    const lines = [{ lineNo: 2, date: "2026-09-28", amount: 12, reference: "pk-1", description: null }, { lineNo: 3, date: "2026-09-28", amount: 5, reference: "A2", description: null },
      { lineNo: 4, date: "2026-09-28", amount: 5, reference: "PK-9", description: null }, { lineNo: 5, date: "2026-09-28", amount: 1, reference: null, description: null }];
    const m = matchPartner({ partnerName: "Parkos", lines, bookings: rows });
    expect(m.ok).toBe(1);
    expect(m.findings.map((f) => [f.booking.id, f.finding.code])).toEqual([["b2", "partner_statement"]]);
    expect(m.notFound.map((l) => l.lineNo)).toEqual([4]);
    expect(m.noReference).toBe(1);
  });
});

describe("caixa fase 4: ligações", () => {
  it("códigos novos e a varredura não os resolve", () => {
    for (const c of EXTERNAL_CODES) expect(SWEEP_LABELS[c]).toBeDefined();
    expect(read("server/cashSweep.ts")).toContain("!EXTERNAL_CODES.has(c as SweepCode)");
  });
  it("migração 0275 só cria tabelas e está registada", () => {
    const all = MIGRATION_0275_STATEMENTS.join("\n");
    for (const t of ["cash_statement_batches", "cash_statement_lines", "cash_external_runs"]) expect(all).toContain(`CREATE TABLE IF NOT EXISTS \`${t}\``);
    expect(all).not.toMatch(/DROP|DELETE|TRUNCATE/i);
    expect(read("server/db.ts")).toContain('import("./migrations/migration_0275")');
  });
  it("cron cash-external registado nos 4 sítios + ajuda", () => {
    expect(read("server/cronSchedule.ts")).toContain('key: "cash-external"');
    expect(read("server/cronScheduler.ts")).toContain('"cash-external"');
    expect(read("shared/appSettings.ts")).toContain('name: "cash-external"');
    expect(read("server/_core/api-entry.ts")).toContain('"/api/cron/cash-external"');
    expect(read("docs/ajuda/agendador.md")).toContain("cash-external");
  });
  it("nunca escreve fora: só GET nos clientes externos", () => {
    for (const f of ["server/external/invoiceExpress.ts", "server/external/stripe.ts"]) {
      const src = read(f);
      expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    }
  });
});
