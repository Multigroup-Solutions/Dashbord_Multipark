import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveFinance } from "./rules";
import type { SweepExtras } from "../multiparkDb/cashSweep";
import {
  buildAgentPermsSql, buildParkMovementSql, buildSweepExtrasSql, buildSweepIdsSql, mapAgentPermsRow, mapSweepExtrasRow, MONEY_PERMISSIONS,
} from "../multiparkDb/cashSweep";
import { assertReadOnlySql } from "../multiparkDb/client";
import { agentPermsFinding, evaluateSweep, missingFinding, parkSilentFinding, snapFromLive, stateHash, type SweepSnap } from "./sweepRules";
import { actionNote, planCaseActions, type ExistingCase } from "./cases";
import { MIGRATION_0265_STATEMENTS } from "../migrations/migration_0265";

const v = (done = false, at: string | null = null, by: string | null = null) => ({ done, at, by });
const live = (o: Partial<LiveFinance> = {}): LiveFinance => ({
  id: "bk1", code: "29484", parkId: "pA", parkName: "Airpark Lisboa", status: "CHECKED_OUT", checkIn: "2026-09-20T09:00:00.000Z",
  checkOut: "2026-09-25T10:00:00.000Z", updatedAt: "2026-09-25T10:05:00.000Z", currency: "EUR", bookingPrice: 50, originalBookingPrice: 50,
  parkingPrice: 50, deliveryPrice: 0, discountAmount: 0, discountApplied: false, paymentMethod: "Dinheiro", paymentSource: null, paymentBy: null,
  campaignId: null, partnerId: null, partnerAmountDue: null, partnerAmountPaid: null, partnerContributedAmount: null, pro: false, proClientId: null,
  linesCount: 1, linesTotal: 50, linesPaid: 50, paymentsCount: 1, paymentsTotal: 50, paymentMethods: ["Dinheiro"],
  cashierClosed: v(), cashValidated: v(), driverValidated: v(true), ...o,
});
const extras = (o: Partial<SweepExtras> = {}): SweepExtras => ({
  id: "bk1", clientPlanId: null, allowance: null, creditId: null, checkOutDriverName: "Rui", disputed: false, cancellation: null,
  billing: { count: 1, emitted: 1, amount: 50, creditNotes: 0 }, credit: { count: 0, value: null },
  paymentLinks: { failed: 0, succeeded: 0, received: null }, extras: { done: 0, doneUncharged: 0 }, cash: { amount: 50, firstAt: "2026-09-25T10:00:00.000Z" }, ...o,
});
const snap = (l: LiveFinance, x: SweepExtras | null, at: string): SweepSnap => snapFromLive(l, x, at);
const codes = (f: { code: string }[]) => f.map((x) => x.code).sort();
const NOW = "2026-09-29T12:00:00.000Z";

describe("caixa fase 2: leituras ao vivo da varredura", () => {
  it("reservas a ver: alteradas (reserva, linhas, pagamentos), ativas e saídas de 48 h dos nossos parques; só leitura com LIMIT", () => {
    const q = buildSweepIdsSql({ parkIds: ["pA", "pB"], since: "2026-09-29 11:45:00", now: "2026-09-29 12:00:00" });
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    for (const t of [`"BookingPricing" y WHERE y."updatedAt"`, `z."recordedAt" >=`, `'CHECKED_OUT'`, "LIMIT"]) expect(q.sql).toContain(t);
    expect(q.params.slice(0, 4)).toEqual(["pA", "pB", "2026-09-29 11:45:00", "2026-09-29 12:00:00"]);
    expect(() => buildSweepIdsSql({ parkIds: [], since: "a", now: "b" })).toThrow();
    expect(() => assertReadOnlySql(buildParkMovementSql({ parkIds: ["pA"], since: "x" }).sql)).not.toThrow();
  });
  it("extras por reserva: cancelamento, faturas, crédito, links, disputa (só sim/não), extras e dinheiro", () => {
    const q = buildSweepExtrasSql(["bk1", "bk1", "bk2"]);
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    for (const t of [`"Cancellation"`, `"Billing"`, `"Credit"`, `"BookingPaymentLink"`, `"BookingExtraService"`, `"disputeEvents" IS NOT NULL`, "'SETTLED'"]) expect(q.sql).toContain(t);
    expect(q.params).toEqual(["bk1", "bk2", 2]);
    expect(q.sql).not.toMatch(/"disputeEvents" AS/);
    const m = mapSweepExtrasRow({ id: "bk1", disputed: "t", cx_at: "2026-09-25 10:00:00", cx_refund: true, cx_refunded: "f", cx_refunded_amount: "10", billing_n: "2", billing_emitted: 1, cash_amount: "20.5" });
    expect(m).toMatchObject({ disputed: true, cancellation: { refund: true, refunded: false, refundedAmount: 10 }, billing: { count: 2, emitted: 1 }, cash: { amount: 20.5 } });
  });
  it("permissões dos agentes: só as de dinheiro, pelas chaves pedidas", () => {
    const q = buildAgentPermsSql(["pA"]);
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.params).toEqual(expect.arrayContaining([...MONEY_PERMISSIONS, "pA"]));
    expect(mapAgentPermsRow({ id: "a1", park_id: "pA", name: "Rui", role: "SUPERVISOR", perms: { allowCloseCashier: true, allowEditBookingPrice: false } }).perms).toEqual(["allowCloseCashier"]);
  });
});

describe("caixa fase 2: regras da varredura", () => {
  it("o teste do dono sem webhook: o retrato da varredura é o \"era\" (preço zerado com caixa fechada)", () => {
    const before = live({ status: "CHECKED_IN", checkOut: "2026-09-25T10:00:00.000Z", paymentsCount: 0, paymentsTotal: null, paymentMethods: [], linesPaid: 0 });
    const era = [snap(before, extras(), "2026-09-24T10:00:00.000Z")];
    const now = live({ bookingPrice: 0, linesTotal: 0, linesPaid: 0, paymentsCount: 0, paymentsTotal: null, paymentMethods: [], cashierClosed: v(true, "2026-09-25T20:00:00.000Z", "Ana") });
    const f = evaluateSweep({ live: now, extras: extras({ cash: { amount: null, firstAt: null } }), era, nowIso: NOW });
    expect(codes(f)).toEqual(expect.arrayContaining(["price_zeroed", "cashier_closed_with_divergence"]));
  });
  it("R12, R16, R17: desconto, pro/avença e parceiro mudados depois", () => {
    const first = live({ status: "BOOKED", paymentSource: "CLIENT" });
    const atCheckin = live({ status: "CHECKED_IN", paymentSource: "CLIENT" });
    const era = [snap(first, extras(), "2026-09-19T10:00:00.000Z"), snap(atCheckin, extras(), "2026-09-20T10:00:00.000Z")];
    const now = live({ discountAmount: 10, campaignId: "c9", pro: true, proClientId: "pc1", partnerId: "p7", partnerAmountDue: 20, paymentSource: "PARTNER" });
    const f = codes(evaluateSweep({ live: now, extras: extras({ clientPlanId: "plan1" }), era, nowIso: NOW }));
    expect(f).toEqual(expect.arrayContaining(["discount_late", "pro_late", "partner_changed"]));
  });
  it("R13: cancelada com pago e sem reembolso; reembolso acima do pago", () => {
    const f1 = codes(evaluateSweep({ live: live({ status: "CANCELLED" }), extras: extras({ cancellation: { at: NOW, refund: false, refunded: false, refundedAmount: null, hasTransaction: false } }), era: [], nowIso: NOW }));
    expect(f1).toContain("refund_issue");
    const f2 = evaluateSweep({ live: live({ status: "CANCELLED", paymentMethods: ["Stripe"] }), extras: extras({ cancellation: { at: NOW, refund: true, refunded: true, refundedAmount: 80, hasTransaction: false } }), era: [], nowIso: NOW });
    expect(f2.find((x) => x.code === "refund_issue")!.detail).toMatch(/acima do pago.*sem id da transação/);
  });
  it("R14 e R22: mudou de dia depois do fecho e a caixa reabriu", () => {
    const closed = live({ cashierClosed: v(true, "2026-09-25T20:00:00.000Z", "Ana"), cashValidated: v(true) });
    const era = [snap(closed, extras(), "2026-09-25T21:00:00.000Z")];
    const f = codes(evaluateSweep({ live: live({ checkOut: "2026-09-27T10:00:00.000Z" }), extras: extras(), era, nowIso: NOW }));
    expect(f).toEqual(expect.arrayContaining(["moved_after_close", "cash_reopened"]));
  });
  it("R18–R21, R23 e R28", () => {
    const f = codes(evaluateSweep({
      live: live({ paymentMethods: ["Dinheiro", "MB"], driverValidated: v(false) }),
      extras: extras({ extras: { done: 1, doneUncharged: 1 }, billing: { count: 0, emitted: 0, amount: null, creditNotes: 0 }, disputed: true, creditId: "cr1",
        cash: { amount: 20, firstAt: "2026-09-25T10:00:00.000Z" } }),
      era: [], nowIso: NOW,
    }));
    expect(f).toEqual(expect.arrayContaining(["extra_uncharged", "invoice_missing", "online_payment", "credit_used", "driver_cash_pending", "split_methods"]));
  });
  it("primeira vez que a varredura vê uma reserva (sem webhook nem retrato): nada de \"só na Multipark\"", () => {
    expect(codes(evaluateSweep({ live: live(), extras: extras(), era: [], nowIso: NOW }))).not.toContain("only_live");
  });
  it("reserva sem nada de estranho: nenhum caso", () => {
    const l = live();
    expect(evaluateSweep({ live: l, extras: extras(), era: [snap(live({ status: "CHECKED_IN" }), extras(), "2026-09-20T10:00:00.000Z")], nowIso: NOW })).toEqual([]);
  });
  it("impressão digital muda só quando o dinheiro muda; R15, R26 e R27", () => {
    expect(stateHash(live(), extras())).toBe(stateHash(live(), extras()));
    expect(stateHash(live(), extras())).not.toBe(stateHash(live({ bookingPrice: 49 }), extras()));
    expect(missingFinding({ status: "CHECKED_IN", bookingPrice: 50, checkOut: "2026-09-25T10:00:00.000Z" }).code).toBe("missing");
    expect(agentPermsFinding({ name: "Rui", before: ["allowCashValidation"], after: ["allowCashValidation", "allowEditBookingPrice"] })!.detail).toContain("ganhou allowEditBookingPrice");
    expect(agentPermsFinding({ name: "Rui", before: ["a"], after: ["a"] })).toBeNull();
    expect(parkSilentFinding({ parkName: "Airpark", moved: 5, hours: 3 }).detail).toContain("nenhum webhook");
  });
});

describe("caixa fase 2: ciclo de vida dos casos", () => {
  const f = (code: string, detail = "d1") => ({ code: code as any, severity: "high" as const, label: code, detail, rule: "R1" });
  const c = (id: number, code: string, state: ExistingCase["state"], detail = "d1"): ExistingCase => ({ id, code, state, detail, severity: "high" });
  it("abre, atualiza, reabre e resolve sozinho; informativas não abrem casos", () => {
    const acts = planCaseActions(
      [c(1, "price_zeroed", "aberto"), c(2, "method_changed", "justificado"), c(3, "paid_mismatch", "resolvido_sozinho"), c(4, "lines_below", "em_analise"), c(5, "credit_used", "justificado")],
      [f("price_zeroed", "d2"), f("method_changed", "d9"), f("paid_mismatch"), f("discount_late"), { ...f("split_methods"), severity: "info" as const }, f("credit_used")],
      "all",
    );
    expect(acts.map((a) => a.kind + ":" + ("caseId" in a ? a.caseId : a.finding.code))).toEqual([
      "update:1", "reopen:2", "reopen:3", "open:discount_late", "resolve:4",
    ]);
    expect(acts.find((a) => a.kind === "resolve")).toMatchObject({ state: "corrigido_na_multipark" });
    expect(actionNote(acts[1]).action).toBe("reaberto");
  });
  it("códigos não avaliados nunca se resolvem sozinhos", () => {
    expect(planCaseActions([c(1, "agent_perms_changed", "aberto")], [], new Set())).toEqual([]);
  });
});

describe("caixa fase 2: tabelas e agendador", () => {
  it("migração 0265 só cria tabelas", () => {
    const all = MIGRATION_0265_STATEMENTS.join("\n");
    for (const t of ["cash_live_snapshots", "cash_cases", "cash_case_events", "cash_agent_perms", "cash_sweep_state"]) expect(all).toContain(`CREATE TABLE IF NOT EXISTS \`${t}\``);
    expect(all).not.toMatch(/DROP|DELETE|ALTER/i);
    expect(readFileSync(join(__dirname, "..", "db.ts"), "utf8")).toContain('import("./migrations/migration_0265")');
  });
  it("cash-sweep de 10 em 10 min e cash-close diário, com endpoint manual", async () => {
    const { TICK_JOBS, describeCadence } = await import("../cronSchedule");
    expect(describeCadence(TICK_JOBS.find((j) => j.key === "cash-sweep")!.cadence)).toBe("a cada 10 min");
    expect(TICK_JOBS.find((j) => j.key === "cash-close")!.cadence).toMatchObject({ kind: "daily" });
    const api = readFileSync(join(__dirname, "..", "_core", "api-entry.ts"), "utf8");
    expect(api).toContain('"/api/cron/cash-sweep"');
    expect(api).toContain('"/api/cron/cash-close"');
  });
});
