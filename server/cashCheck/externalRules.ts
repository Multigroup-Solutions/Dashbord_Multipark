/**
 * Caixa, fase 4 — cruzar com o exterior (PURO, sem BD nem rede).
 *
 *  R19 InvoiceExpress: a fatura que a Multipark diz ter emitido existe, não
 *      está anulada e tem o valor do `Billing`.
 *  R20 Stripe: o pagamento online foi cobrado, com o valor que a Multipark
 *      dá; reembolsos sem cancelamento e disputas.
 *  R30 Terminal multibanco: por parque e dia, o extrato do terminal = soma dos
 *      pagamentos por cartão/multibanco registados na Multipark.
 *  R31 Banco: cada transferência registada na Multipark aparece no extrato
 *      do banco (mesmo valor, até TRANSFER_DAYS dias depois).
 *  R17 Parceiros: por reserva, o valor no extrato do parceiro = `partnerAmountDue`.
 *
 * Mais o leitor de CSV dos extratos (separador, números à portuguesa,
 * cabeçalhos com nomes diferentes).
 */
import type { IxResult } from "../external/invoiceExpress";
import type { StripeEvent, StripePayment } from "../external/stripe";
import type { ExternalBooking, PartnerDueRow, RecordedPayment } from "../multiparkDb/cashExternal";
import { eurText, MONEY_TOLERANCE } from "./rules";
import { finding, type Finding } from "./sweepRules";

const neq = (a: number, b: number, tol = MONEY_TOLERANCE) => Math.abs(a - b) > tol + 1e-9;
const r2 = (v: number) => Math.round(v * 100) / 100;

// ─── Métodos de pagamento ──────────────────────────────────────────────────

export type MethodKind = "cash" | "card" | "mbway" | "transfer" | "online" | "other";

/** Texto livre do método (Multipark) → tipo. PURA. */
export function methodKind(method: string | null | undefined): MethodKind {
  const m = String(method ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (!m.trim()) return "other";
  if (/cash|dinheiro|numer/.test(m)) return "cash";
  if (/mb ?way/.test(m)) return "mbway";
  if (/transf|\bbank\b|\bbanco\b|\biban\b|\bsepa\b|\bwire\b/.test(m)) return "transfer";
  if (/stripe|online|link|web/.test(m)) return "online";
  if (/card|cartao|tpa|visa|master|multibanco|debit|credit|^mb$|\bmb\b|pos/.test(m)) return "card";
  return "other";
}

// ─── R19 InvoiceExpress ────────────────────────────────────────────────────

const IX_VOID = /cancel|anulad|void|deleted/i;

/** Uma reserva, com as respostas da InvoiceExpress por `invoiceExpressId`. PURA. */
export function invoiceExternalFinding(bk: Pick<ExternalBooking, "billing">, docs: ReadonlyMap<number, IxResult>): Finding | null {
  const problems: string[] = [];
  for (const bl of bk.billing) {
    if (!bl.emitted || bl.invoiceExpressId == null) continue;
    const r = docs.get(bl.invoiceExpressId);
    if (!r || (!r.ok && r.reason !== "not_found")) continue; // não lida (sem chave, erro): não conclui nada
    const isCredit = /credit/i.test(bl.type ?? "");
    const name = `${isCredit ? "nota de crédito" : "fatura"} ${bl.invoiceExpressId}`;
    if (!r.ok) { problems.push(`${name} não existe na InvoiceExpress`); continue; }
    if (r.doc.status && IX_VOID.test(r.doc.status)) { problems.push(`${name} está ${r.doc.status} na InvoiceExpress`); continue; }
    if (bl.amount != null && r.doc.total != null && neq(Math.abs(bl.amount), Math.abs(r.doc.total))) {
      problems.push(`${name}: Multipark ${eurText(bl.amount)}, InvoiceExpress ${eurText(r.doc.total)}`);
    }
  }
  return problems.length ? finding("invoice_external", `${problems.join("; ")}.`) : null;
}

/** Faturas a ler (emitidas e com id). PURA. */
export function invoicesToRead(bks: readonly ExternalBooking[]): Array<{ id: number; type: string | null }> {
  const seen = new Map<number, string | null>();
  for (const bk of bks) for (const bl of bk.billing) if (bl.emitted && bl.invoiceExpressId != null && !seen.has(bl.invoiceExpressId)) seen.set(bl.invoiceExpressId, bl.type);
  return [...seen].map(([id, type]) => ({ id, type }));
}

// ─── R20 Stripe ────────────────────────────────────────────────────────────

/** Pagamentos online de uma reserva: id → quanto a Multipark diz ter recebido (null = não sabe). PURA. */
export function intentsOf(bk: Pick<ExternalBooking, "paymentIntentId" | "billing" | "links">): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const l of bk.links) {
    if (String(l.status ?? "").toUpperCase() !== "SETTLED") continue;
    out.set(l.paymentIntentId, l.received ?? l.amount);
  }
  for (const bl of bk.billing) {
    if (!bl.paymentIntentId || out.has(bl.paymentIntentId) || /credit/i.test(bl.type ?? "")) continue;
    out.set(bl.paymentIntentId, bl.amount);
  }
  if (bk.paymentIntentId && !out.has(bk.paymentIntentId)) out.set(bk.paymentIntentId, null);
  return out;
}

const OK_STATUSES = new Set(["succeeded"]);

/**
 * Uma reserva contra a Stripe. `payments`: id → pagamento (null = a Stripe não
 * o mostra com esta chave; ausente = não lido). `events`: reembolsos/disputas
 * recentes dos seus pagamentos. PURA.
 */
export function stripeExternalFinding(
  bk: Pick<ExternalBooking, "paymentIntentId" | "billing" | "links" | "cancelled" | "refundedAmount">,
  payments: ReadonlyMap<string, StripePayment | null>,
  events: readonly StripeEvent[] = [],
): Finding | null {
  const problems: string[] = [];
  const intents = intentsOf(bk);
  let refundedTotal = 0;
  for (const [pi, expected] of intents) {
    if (!payments.has(pi)) continue;
    const p = payments.get(pi);
    if (!p) continue; // conta ligada / outra conta: sem conclusão
    if (!p.status || !OK_STATUSES.has(p.status)) {
      if (expected != null && expected > MONEY_TOLERANCE) problems.push(`${pi} está "${p.status ?? "?"}" na Stripe mas a Multipark dá ${eurText(expected)} recebidos`);
      continue;
    }
    if (expected != null && p.received != null && neq(expected, p.received)) problems.push(`${pi}: Multipark ${eurText(expected)}, Stripe recebeu ${eurText(p.received)}`);
    if (p.refunded) refundedTotal += p.refunded;
    if (p.disputed) problems.push(`${pi} tem uma disputa aberta na Stripe`);
  }
  const mine = new Set(intents.keys());
  for (const e of events) {
    if (!e.paymentIntent || !mine.has(e.paymentIntent)) continue;
    if (e.kind === "dispute" && !problems.some((x) => x.startsWith(`${e.paymentIntent} tem uma disputa`))) problems.push(`${e.paymentIntent} tem uma disputa (${e.status ?? "?"}) de ${eurText(e.amount)}`);
  }
  refundedTotal = r2(refundedTotal);
  if (refundedTotal > MONEY_TOLERANCE) {
    if (!bk.cancelled) problems.push(`${eurText(refundedTotal)} reembolsados na Stripe sem cancelamento na Multipark`);
    else if (bk.refundedAmount != null && neq(bk.refundedAmount, refundedTotal)) problems.push(`reembolso na Multipark ${eurText(bk.refundedAmount)}, na Stripe ${eurText(refundedTotal)}`);
  }
  return problems.length ? finding("stripe_external", `${problems.join("; ")}.`) : null;
}

// ─── Leitor de CSV dos extratos ────────────────────────────────────────────

export interface StatementLine { lineNo: number; date: string; amount: number; reference: string | null; description: string | null }
export interface ParsedStatement { lines: StatementLine[]; errors: string[]; delimiter: string }

const HEADERS = {
  date: ["data", "date", "data movimento", "data mov", "data valor", "data operacao", "data transacao", "booking date", "transaction date", "dia"],
  amount: ["valor", "amount", "montante", "importancia", "total", "valor eur", "montante eur", "net", "liquido", "comissao a pagar", "commission", "a pagar"],
  credit: ["credito", "credit", "entrada", "entradas"],
  debit: ["debito", "debit", "saida", "saidas"],
  reference: ["referencia", "reference", "ref", "booking", "reserva", "booking ref", "booking reference", "codigo", "id reserva", "n reserva", "order", "order id", "terminal", "tpa"],
  description: ["descricao", "description", "descritivo", "movimento", "detalhe", "details", "observacoes", "nome", "cliente"],
};

const norm = (h: string) => h.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function splitCsvLine(line: string, d: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** "1.234,56" · "1,234.56" · "-12,5" · "12,50 €" · "(12,50)" → número. PURA. */
export function parseAmount(raw: string | null | undefined): number | null {
  let t = String(raw ?? "").replace(/[€\s]|EUR/gi, "");
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.endsWith("-")) { neg = true; t = t.slice(0, -1); }
  const lastComma = t.lastIndexOf(","), lastDot = t.lastIndexOf(".");
  if (lastComma > lastDot) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return r2(neg ? -v : v);
}

/** "29/09/2026" · "29-09-2026" · "2026-09-29" · "29.09.26" → "2026-09-29". PURA. */
export function parseDate(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const d = Number(m[1]), mo = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

export const STATEMENT_MAX_LINES = 5000;

/** CSV de um extrato → linhas. Nunca lança; o que não se lê vai para `errors`. PURA. */
export function parseStatementCsv(text: string): ParsedStatement {
  const raw = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const errors: string[] = [];
  if (!raw.length) return { lines: [], errors: ["Ficheiro vazio."], delimiter: ";" };
  // Cabeçalho: a primeira das 10 primeiras linhas que tenha uma coluna de data e uma de valor.
  const counts = (l: string) => ({ ";": l.split(";").length, ",": l.split(",").length, "\t": l.split("\t").length });
  let headerIdx = -1, delimiter = ";";
  let cols: { date: number; amount: number; credit: number; debit: number; reference: number; description: number } | null = null;
  for (let i = 0; i < Math.min(raw.length, 10) && !cols; i++) {
    const c = counts(raw[i]);
    const d = (Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]);
    const hs = splitCsvLine(raw[i], d).map(norm);
    const find = (names: string[]) => hs.findIndex((h) => names.includes(h));
    const found = { date: find(HEADERS.date), amount: find(HEADERS.amount), credit: find(HEADERS.credit), debit: find(HEADERS.debit), reference: find(HEADERS.reference), description: find(HEADERS.description) };
    if (found.date >= 0 && (found.amount >= 0 || found.credit >= 0)) { cols = found; headerIdx = i; delimiter = d; }
  }
  if (!cols) return { lines: [], errors: ["Não encontrei o cabeçalho (precisa de uma coluna de data e uma de valor, crédito ou montante)."], delimiter };
  const lines: StatementLine[] = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    if (lines.length >= STATEMENT_MAX_LINES) { errors.push(`Só li as primeiras ${STATEMENT_MAX_LINES} linhas.`); break; }
    const f = splitCsvLine(raw[i], delimiter);
    const date = parseDate(f[cols.date]);
    let amount: number | null = null;
    if (cols.amount >= 0) amount = parseAmount(f[cols.amount]);
    if (amount == null && cols.credit >= 0) {
      const cr = parseAmount(f[cols.credit]);
      const db = cols.debit >= 0 ? parseAmount(f[cols.debit]) : null;
      amount = cr != null && cr !== 0 ? Math.abs(cr) : db != null ? -Math.abs(db) : null;
    }
    if (!date || amount == null) {
      if (f.some((x) => x)) errors.push(`Linha ${i + 1}: sem data ou valor legíveis.`);
      continue;
    }
    const ref = cols.reference >= 0 ? f[cols.reference] || null : null;
    const desc = cols.description >= 0 ? f[cols.description] || null : null;
    lines.push({ lineNo: i + 1, date, amount, reference: ref, description: desc });
  }
  return { lines, errors: errors.slice(0, 50), delimiter };
}

// ─── Dia de Lisboa ─────────────────────────────────────────────────────────

export function lisbonDayOf(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(t)) : null;
}

// ─── R30 Terminal multibanco (por parque e dia) ────────────────────────────

export interface TpaDay { day: string; statement: number; multipark: number; payments: number; finding: Finding | null }

/**
 * Extrato do terminal de UM parque contra os pagamentos por cartão/multibanco
 * desse parque, dia a dia (dias de Lisboa, só os dias do extrato). PURA.
 */
export function matchTpa(o: { parkName: string | null; lines: readonly StatementLine[]; payments: readonly RecordedPayment[] }): TpaDay[] {
  const st = new Map<string, number>();
  for (const l of o.lines) st.set(l.date, r2((st.get(l.date) ?? 0) + l.amount));
  const mp = new Map<string, { sum: number; n: number }>();
  for (const p of o.payments) {
    if (methodKind(p.method) !== "card") continue;
    const day = lisbonDayOf(p.recordedAt);
    if (!day || !st.has(day)) continue;
    const cur = mp.get(day) ?? { sum: 0, n: 0 };
    mp.set(day, { sum: r2(cur.sum + p.amount), n: cur.n + 1 });
  }
  return [...st.keys()].sort().map((day) => {
    const statement = st.get(day)!;
    const m = mp.get(day) ?? { sum: 0, n: 0 };
    const diff = r2(statement - m.sum);
    const f = neq(statement, m.sum)
      ? finding("tpa_mismatch", `${o.parkName ?? "Parque"}, ${day}: terminal ${eurText(statement)}, Multipark ${eurText(m.sum)} em ${m.n} pagamento(s) por cartão/multibanco → ${diff < 0 ? `a Multipark tem mais ${eurText(-diff)} do que o terminal recebeu` : `o terminal recebeu mais ${eurText(diff)} do que está registado`}.`)
      : null;
    return { day, statement, multipark: m.sum, payments: m.n, finding: f };
  });
}

// ─── R31 Banco (transferências) ────────────────────────────────────────────

export const TRANSFER_DAYS = 5;

export interface BankMatch {
  matched: Array<{ lineNo: number; bookingId: string; code: string | null; amount: number }>;
  unmatchedLines: StatementLine[];
  /** Transferências da Multipark sem entrada no banco (por reserva). */
  missing: Map<string, { code: string | null; parkId: string | null; items: RecordedPayment[] }>;
}

const dayNum = (d: string) => Math.round(Date.parse(`${d}T12:00:00Z`) / 86_400_000);

/**
 * Cada transferência registada na Multipark (dentro do período do extrato)
 * procura uma entrada no banco com o mesmo valor, do dia do registo até
 * TRANSFER_DAYS depois (ou até 2 dias antes). Um para um, a mais próxima. PURA.
 */
export function matchBank(o: { lines: readonly StatementLine[]; payments: readonly RecordedPayment[]; periodStart: string; periodEnd: string }): BankMatch {
  const credits = o.lines.filter((l) => l.amount > 0).map((l) => ({ l, used: false }));
  const matched: BankMatch["matched"] = [];
  const missing: BankMatch["missing"] = new Map();
  const transfers = o.payments.filter((p) => methodKind(p.method) === "transfer" && p.amount > 0);
  for (const p of transfers) {
    const day = lisbonDayOf(p.recordedAt);
    if (!day) continue;
    const dn = dayNum(day);
    let best: (typeof credits)[number] | null = null, bestGap = Infinity;
    for (const c of credits) {
      if (c.used || neq(c.l.amount, p.amount)) continue;
      const gap = dayNum(c.l.date) - dn;
      if (gap < -2 || gap > TRANSFER_DAYS) continue;
      if (Math.abs(gap) < bestGap) { best = c; bestGap = Math.abs(gap); }
    }
    if (best) { best.used = true; matched.push({ lineNo: best.l.lineNo, bookingId: p.bookingId, code: p.code, amount: p.amount }); continue; }
    // Só conta como em falta se o extrato cobre todos os dias em que devia ter entrado.
    if (dayNum(o.periodEnd) - dn < TRANSFER_DAYS || dn - 2 < dayNum(o.periodStart)) continue;
    const cur = missing.get(p.bookingId) ?? { code: p.code, parkId: p.parkId, items: [] };
    cur.items.push(p);
    missing.set(p.bookingId, cur);
  }
  return { matched, unmatchedLines: credits.filter((c) => !c.used).map((c) => c.l), missing };
}

export function transferMissingFinding(items: readonly RecordedPayment[]): Finding {
  const total = r2(items.reduce((s, p) => s + p.amount, 0));
  const days = [...new Set(items.map((p) => lisbonDayOf(p.recordedAt)).filter(Boolean))].join(", ");
  return finding("transfer_missing", `${eurText(total)} registados como transferência (${days}) sem entrada com o mesmo valor no extrato do banco até ${TRANSFER_DAYS} dias depois.`);
}

// ─── R17 Parceiros ─────────────────────────────────────────────────────────

export interface PartnerMatch {
  findings: Array<{ booking: PartnerDueRow; finding: Finding }>;
  ok: number;
  notFound: StatementLine[];
  noReference: number;
}

/** Linhas do extrato do parceiro (referência + valor) contra `partnerAmountDue`. PURA. */
export function matchPartner(o: { partnerName: string | null; lines: readonly StatementLine[]; bookings: readonly PartnerDueRow[] }): PartnerMatch {
  const byRef = new Map<string, PartnerDueRow>();
  for (const b of o.bookings) {
    if (b.externalReference) byRef.set(b.externalReference.trim().toUpperCase(), b);
    if (b.code) byRef.set(b.code.trim().toUpperCase(), b);
  }
  const sums = new Map<string, { b: PartnerDueRow; amount: number; lines: number[] }>();
  const notFound: StatementLine[] = [];
  let noReference = 0;
  for (const l of o.lines) {
    if (!l.reference) { noReference++; continue; }
    const b = byRef.get(l.reference.trim().toUpperCase());
    if (!b) { notFound.push(l); continue; }
    const cur = sums.get(b.id) ?? { b, amount: 0, lines: [] };
    cur.amount = r2(cur.amount + l.amount);
    cur.lines.push(l.lineNo);
    sums.set(b.id, cur);
  }
  const findings: PartnerMatch["findings"] = [];
  let ok = 0;
  for (const { b, amount } of sums.values()) {
    const due = b.due ?? 0;
    if (!neq(Math.abs(amount), Math.abs(due))) { ok++; continue; }
    findings.push({ booking: b, finding: finding("partner_statement", `Extrato ${o.partnerName ?? "do parceiro"}: ${eurText(amount)}; na Multipark o devido é ${eurText(b.due)}${b.status ? ` (reserva ${b.status})` : ""}.`) });
  }
  return { findings, ok, notFound, noReference };
}
