import { describe, expect, it } from "vitest";
import { assertReadOnlySql } from "./client";
import {
  buildProBookingsSql, buildProClientsSql, buildProOnlinePaymentsSql, buildProPricingPaymentsSql, buildProSettlementsSql,
  mapProSnapshot, periodShape, readMultiparkPro,
} from "./pro";
import { looksLikeCompany } from "../crm/proSync";
import { cityInScope, hideMoney, isLegacySearch, stripLegacyWord } from "../crm/proQueries";
import { summarizeLedger } from "../../shared/crmPro";

describe("Pro na BD Multipark — SQL", () => {
  it("todas as leituras passam na guarda só de leitura e têm LIMIT", () => {
    for (const b of [buildProClientsSql(), buildProBookingsSql(), buildProPricingPaymentsSql(), buildProSettlementsSql(), buildProOnlinePaymentsSql()]) {
      expect(() => assertReadOnlySql(b.sql)).not.toThrow();
      expect(b.sql).toMatch(/LIMIT \$\d+/);
    }
  });
  it("acertos só de clientes Pro, por parâmetro", () => {
    const s = buildProSettlementsSql();
    expect(s.sql).toContain(`"entityType"::text = $1`);
    expect(s.params[0]).toBe("PRO_CLIENT");
  });
});

const proClients = [
  { pro_client_id: "pc-a1", client_id: "cl-a", park_id: "pk1", park_name: "Airpark Lisboa", park_city: "lisbon", discount: 15, active: true, pro_name: "Pinto & Filhos, Lda", first_name: "Paulo", last_name: "Pinto", email: "conta@exemplo.pt", phone: "+351910000000" },
  { pro_client_id: "pc-a2", client_id: "cl-a", park_id: "pk2", park_name: "Airpark Porto", park_city: "porto", discount: 15, active: false, pro_name: null },
  { pro_client_id: "pc-b1", client_id: "cl-b", park_id: "pk1", park_name: "Airpark Lisboa", park_city: "lisbon", discount: 10, active: true, first_name: "Ana", last_name: "Sousa", anonymized: true, email: "x@y.z" },
];
const bookings = [
  // conta A: proClientId → ProClient
  { id: "bk1", code: "1001", status: "CHECKED_OUT", check_in: "2026-07-03 08:00:00", check_out: "2026-07-05 08:00:00", park_id: "pk1", client_id: "cl-a", pro_client_id: "pc-a1", pro: true, booking_price: 100, discount_amount: 15, pricing_lines: 2, pricing_total: 85, paid: 85, plate: "AA-12-BB", traveler_name: "Rui Costa" },
  // conta A: sem proClientId mas pro=true e cliente da conta
  { id: "bk2", code: "1002", status: "BOOKED", check_in: "2026-09-10 08:00:00", park_id: "pk2", client_id: "cl-a", pro_client_id: null, pro: true, booking_price: 60, pricing_lines: 0, pricing_total: null, paid: 0 },
  // pago sem pagamento datado (registo antigo)
  { id: "bk3", code: "1003", status: "CHECKED_OUT", check_in: "2026-06-02 08:00:00", park_id: "pk1", client_id: "cl-a", pro_client_id: "pc-a1", pro: true, booking_price: 40, pricing_lines: 1, pricing_total: 40, paid: 40, paid_updated_at: "2026-07-10 09:00:00" },
  // cancelada sem pagamento: não deixa dívida
  { id: "bk4", code: "1004", status: "CANCELLED", check_in: "2026-08-02 08:00:00", park_id: "pk1", client_id: "cl-a", pro_client_id: "pc-a1", pro: true, booking_price: 70, pricing_lines: 1, pricing_total: 70, paid: 0 },
  // Pro antigo: cliente sem ProClient hoje → conta própria (não se perde a dívida)
  { id: "bk9", status: "BOOKED", check_in: "2026-09-01 08:00:00", park_id: "pk1", client_id: "cl-z", pro_client_id: "pc-z", pro: true, booking_price: 10, paid: 0, owner_name: "Zé Antigo", owner_email: "ze@exemplo.pt" },
  // sem cliente nenhum: fica de fora (contado no diagnóstico)
  { id: "bk10", status: "BOOKED", check_in: "2026-09-01 08:00:00", park_id: "pk1", client_id: null, pro_client_id: null, pro: true, booking_price: 10, paid: 0 },
];
const payments = [{ id: "pp1", booking_id: "bk1", amount: 85, method: "TRANSFER", recorded_at: "2026-08-22 10:00:00" }];
const settlements = [
  { id: "es1", entity_id: "pc-a1", park_id: "pk1", scope_key: "", period_key: "2026-07", paid_at: "2026-08-22 10:00:00", method: "TRANSFER", amount: null, source: "AGENT" },
  { id: "es2", entity_id: "cl-a", park_id: "pk1", scope_key: "pk1", period_key: "julho", paid_at: "2026-08-23 10:00:00", method: null, amount: 12.5, source: "AGENT" },
  { id: "es3", entity_id: "desconhecido", period_key: "2026-05", paid_at: "2026-06-01 10:00:00" },
];
const online = [{ id: "op1", client_id: "cl-b", amount: 20, status: "COMPLETED", method: null, period_start: "2026-08-01 00:00:00", period_end: "2026-08-31 00:00:00", created_at: "2026-09-01 09:00:00", mit: true }];

describe("Pro na BD Multipark — conta corrente", () => {
  const s = mapProSnapshot({ proClients, bookings, payments, settlements, online });
  const a = s.accounts.find((x) => x.mpClientId === "cl-a")!;
  const led = (k: string, id: string) => s.ledger.find((l) => l.kind === k && l.sourceId === id)!;

  it("uma conta por cliente, com os parques; nome da empresa; anonimizado sem dados pessoais", () => {
    expect(s.accounts).toHaveLength(3);
    expect(a).toMatchObject({ name: "Pinto & Filhos, Lda", email: "conta@exemplo.pt", active: true, legacy: false });
    expect(a.parks.map((p) => p.proClientId)).toEqual(["pc-a1", "pc-a2"]);
    const b = s.accounts.find((x) => x.mpClientId === "cl-b")!;
    expect(b).toMatchObject({ name: null, email: null, phone: null });
  });
  it("reservas a débito pelas linhas de preço; pro=true sem proClientId vai para a conta do cliente", () => {
    expect(led("booking", "bk1")).toMatchObject({ mpClientId: "cl-a", debit: 85, paidAmount: 85, listPrice: 100, periodKey: "2026-07", parkName: "Airpark Lisboa", city: "lisbon", travelerName: "Rui Costa" });
    expect(led("booking", "bk2")).toMatchObject({ mpClientId: "cl-a", debit: 60, periodKey: "2026-09", parkName: "Airpark Porto" });
    expect(led("booking", "bk4")).toMatchObject({ debit: 0, status: "CANCELLED" });
    // Pro antigo: conta própria, inativa, com os dados do dono da reserva
    expect(s.accounts.find((x) => x.mpClientId === "cl-z")).toMatchObject({ legacy: true, active: false, name: "Zé Antigo", email: "ze@exemplo.pt", parks: [] });
    expect(led("booking", "bk9")).toMatchObject({ mpClientId: "cl-z", debit: 10 });
    expect(s.diagnostics).toMatchObject({ bookingsWithoutAccount: 1, legacyAccounts: 1, accounts: 3 });
    expect(s.diagnostics.pricingDiffersFromPrice).toBe(1);
  });
  it("pagamentos datados a crédito no mês da reserva; pago sem data como movimento próprio", () => {
    expect(led("payment", "pp1")).toMatchObject({ credit: 85, periodKey: "2026-07", entryAt: "2026-08-22 10:00:00", method: "TRANSFER" });
    // data estável: a saída (ou a entrada), não a última edição das linhas de preço
    expect(led("paid_undated", "bk3")).toMatchObject({ credit: 40, periodKey: "2026-06", entryAt: "2026-06-02 08:00:00" });
    expect(s.ledger.find((l) => l.kind === "paid_undated" && l.sourceId === "bk1")).toBeUndefined();
  });
  it("pago corrigido para baixo: correção negativa (o crédito total bate com o pago)", () => {
    const x = mapProSnapshot({
      proClients, settlements: [], online: [],
      bookings: [{ id: "bk7", code: "7", status: "CHECKED_OUT", check_in: "2026-07-01 08:00:00", check_out: "2026-07-03 08:00:00", park_id: "pk1", client_id: "cl-a", pro_client_id: "pc-a1", pricing_lines: 1, pricing_total: 50, paid: 30, booking_price: 50 }],
      payments: [{ id: "p7", booking_id: "bk7", amount: 50, method: "CARD", recorded_at: "2026-07-05 10:00:00" }],
    });
    const corr = x.ledger.find((l) => l.kind === "paid_undated" && l.sourceId === "bk7")!;
    expect(corr).toMatchObject({ credit: -20, entryAt: "2026-07-03 08:00:00" });
    expect(corr.description).toContain("corrigido");
    const credit = x.ledger.filter((l) => l.sourceId === "bk7" || l.sourceId === "p7").reduce((t, l) => t + l.credit, 0);
    expect(credit).toBe(30);
  });
  it("parque e cidade REAIS da reserva (não só os parques do ProClient)", () => {
    const x = mapProSnapshot({
      proClients, payments: [], settlements: [], online: [],
      bookings: [{ id: "bk8", status: "BOOKED", check_in: "2026-09-01 08:00:00", park_id: "pk-faro", park_name: "Airpark Faro", park_city: "faro", client_id: "cl-a", pro_client_id: "pc-a1", booking_price: 30, paid: 0 }],
    });
    expect(x.ledger[0]).toMatchObject({ parkName: "Airpark Faro", city: "faro" });
  });
  it("acertos (por ProClient ou Client) e cobranças online são marcas; período guardado tal e qual", () => {
    expect(led("settlement", "es1")).toMatchObject({ mpClientId: "cl-a", periodKey: "2026-07", mpPeriodKey: "2026-07", debit: 0, credit: 0 });
    expect(led("settlement", "es2")).toMatchObject({ mpClientId: "cl-a", periodKey: "", mpPeriodKey: "julho", infoAmount: 12.5 });
    expect(s.diagnostics).toMatchObject({ settlements: 3, settlementsWithoutAccount: 1, settlementPeriodUnparsed: 1 });
    expect(s.diagnostics.settlementPeriodShapes).toMatchObject({ "9999-99": 2, aaaaa: 1 });
    expect(led("online", "op1")).toMatchObject({ mpClientId: "cl-b", periodKey: "2026-08", infoAmount: 20, method: "cobrança automática", credit: 0 });
  });
  it("o saldo bate com o pendente da Multipark (preço − pago por reserva)", () => {
    const rows = s.ledger.filter((l) => l.mpClientId === "cl-a").map((l) => ({ ...l, entryAt: l.entryAt }));
    const sum = summarizeLedger(rows, new Date("2026-09-27T10:00:00Z"));
    // pendente: bk1 0 + bk2 60 + bk3 0 + bk4 0
    expect(sum.balance).toBe(60);
    expect(sum.due).toBe(0);
    expect(sum.currentMonthDebit).toBe(60);
    expect(sum.months.find((m) => m.periodKey === "2026-07")).toMatchObject({ status: "paid", settledAt: "2026-08-22 10:00:00" });
  });
  it("cobrança online de cliente sem ProClient: conta Pro antigo se o cliente existir", () => {
    const x = mapProSnapshot({
      proClients, bookings: [], payments: [], settlements: [],
      online: [
        { id: "o1", client_id: "cl-old", amount: 30, status: "COMPLETED", period_start: "2026-03-01 00:00:00", period_end: "2026-03-23 00:00:00", created_at: "2026-03-23 13:00:00", client_found: true, client_name: "Maria Velha", client_email: "m@exemplo.pt" },
        { id: "o2", client_id: "nao-existe", amount: 10, status: "COMPLETED", period_start: "2026-03-01 00:00:00", created_at: "2026-03-23 13:00:00", client_found: false },
      ],
    });
    expect(x.accounts.find((a) => a.mpClientId === "cl-old")).toMatchObject({ legacy: true, name: "Maria Velha" });
    expect(x.ledger.find((l) => l.sourceId === "o1")).toMatchObject({ mpClientId: "cl-old", kind: "online", periodKey: "2026-03" });
    expect(x.diagnostics).toMatchObject({ online: 2, onlineWithoutAccount: 1, legacyAccounts: 1 });
  });
  it("forma dos períodos sem valores", () => {
    expect(periodShape("2026-07")).toBe("9999-99");
    expect(periodShape(null)).toBe("(vazio)");
  });
});

describe("Pro na BD Multipark — leitura", () => {
  it("sem BD configurada devolve indisponível (não lança)", async () => {
    const prev = process.env.DATABASE_URL_MULTIPARK;
    delete process.env.DATABASE_URL_MULTIPARK;
    try {
      const r = await readMultiparkPro(async () => { throw new Error("não devia ler"); });
      expect(r.available).toBe(false);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL_MULTIPARK = prev;
    }
  });
  it("com BD: junta as cinco leituras", async () => {
    const prev = process.env.DATABASE_URL_MULTIPARK;
    process.env.DATABASE_URL_MULTIPARK = "postgres://u:p@h:5432/db";
    try {
      const answers = [proClients, bookings, payments, settlements, online];
      let i = 0;
      const r = await readMultiparkPro(async () => answers[i++] as any);
      expect(r.available).toBe(true);
      if (r.available) expect(r.data.accounts).toHaveLength(3);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL_MULTIPARK; else process.env.DATABASE_URL_MULTIPARK = prev;
    }
  });
});

describe("Pro antigos — fora das contas, à vista com a palavra 'antigo'", () => {
  it("reconhece a palavra e tira-a da procura", () => {
    expect(isLegacySearch("antigo")).toBe(true);
    expect(isLegacySearch("pro antigos")).toBe(true);
    expect(isLegacySearch("Silva antigo")).toBe(true);
    expect(isLegacySearch("antiguidades")).toBe(false);
    expect(isLegacySearch("silva")).toBe(false);
    expect(stripLegacyWord("pro antigo silva")).toBe("silva");
    expect(stripLegacyWord("antigos")).toBe("");
  });
});

describe("Pro — âmbito de cidade", () => {
  it("sem cidade só para quem vê todas; cidades por nome ou alias", () => {
    expect(cityInScope(null, undefined)).toBe(true);
    expect(cityInScope(null, ["Lisboa"])).toBe(false);
    expect(cityInScope("lisbon", ["Lisboa"])).toBe(true);
    expect(cityInScope("porto", ["Lisboa"])).toBe(false);
  });
  it("sem euros para quem não vê totais (também a diferença dos meses dados como pagos)", () => {
    const s = summarizeLedger([{ kind: "booking", entryAt: "2026-06-02 08:00:00", periodKey: "2026-06", debit: 10, credit: 0 }], new Date("2026-09-27T10:00:00Z"));
    const h = hideMoney(s);
    expect(h).toMatchObject({ balance: null, due: null, paidThisYear: null, currentMonthDebit: null, dueMonths: 1, oldestDue: "2026-06" });
    expect(h.months[0]).toMatchObject({ debit: null, credit: null, pending: null, settledGap: null, status: "due" });
  });
});

describe("Pro — ficha nova: empresa ou pessoa", () => {
  it("pelo nome", () => {
    expect(looksLikeCompany("Pinto & Filhos, Lda")).toBe(true);
    expect(looksLikeCompany("Transportes Silva S.A.")).toBe(true);
    expect(looksLikeCompany("Maria Santos")).toBe(false);
    expect(looksLikeCompany(null, "Qualquer Coisa Unipessoal")).toBe(true);
  });
});
