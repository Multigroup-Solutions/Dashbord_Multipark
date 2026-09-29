/**
 * Caixa, fase 4 — confirmar os pagamentos que não são dinheiro (PURO, sem BD
 * nem rede).
 *
 *  R19 InvoiceExpress (interruptor, desligado): a fatura existe, não está
 *      anulada e tem o valor do `Billing`.
 *  R20 Online: a Multipark tem o pagamento Stripe de uma reserva paga online
 *      (sempre, só Multipark); e, com o interruptor, a Stripe confirma-o
 *      (cobrado, valor, reembolsos sem cancelamento, disputas).
 *  R30 Multibanco: cada pagamento por multibanco tem o talão (foto, conferida
 *      à mão na contagem da caixa) ou, com o interruptor ou o CSV exportado, a
 *      transação no terminal da Viva Wallet (mesmo dia ou seguinte, mesmo valor).
 *  R17 Recebimentos mensais (Pro, agentes e agregadores pagam no fim do mês,
 *      por transferência, conferida à mão): recebido = devido na Multipark.
 */
import type { IxResult } from "../external/invoiceExpress";
import type { StripeEvent, StripePayment } from "../external/stripe";
import type { ExternalBooking, RecordedPayment } from "../multiparkDb/cashExternal";
import type { VivaTxn } from "../external/vivaWallet";
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

// ─── R20 Online sem pagamento Stripe na Multipark ──────────────────────────

/**
 * Reserva dada como paga online (método da reserva ou pagamentos "Online"/
 * "Stripe") sem nenhum pagamento Stripe na Multipark: nem `paymentIntentId`
 * na reserva ou nas faturas, nem link de pagamento pago. PURA.
 */
export function onlineNoIntentFinding(bk: Pick<ExternalBooking, "paymentMethod" | "onlinePaid" | "paymentIntentId" | "billing" | "links" | "cancelled">): Finding | null {
  const online = (bk.onlinePaid ?? 0) > MONEY_TOLERANCE ? bk.onlinePaid! : null;
  const methodOnline = methodKind(bk.paymentMethod) === "online";
  if (!online && !methodOnline) return null;
  if (intentsOf(bk).size > 0) return null;
  if (!online && bk.cancelled) return null;
  return finding("online_no_intent", online
    ? `${eurText(online)} registados como pagos online, mas a Multipark não tem o pagamento Stripe (sem id de pagamento na reserva, nas faturas ou num link pago).`
    : `Método "${bk.paymentMethod}", mas a Multipark não tem o pagamento Stripe (sem id de pagamento na reserva, nas faturas ou num link pago).`);
}

// ─── Leitura de CSV (Viva Wallet exportado) ────────────────────────────────

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

export const VIVA_CSV_MAX_LINES = 10000;
const VIVA_HEADERS = {
  date: ["date", "data", "transaction date", "data transacao"],
  time: ["time", "hora"],
  amount: ["amount", "valor", "montante"],
  channel: ["channel", "canal"],
  id: ["transaction id", "transactionid", "id", "id transacao"],
  terminal: ["terminal id", "terminalid", "terminal"],
};

/** Hora de Lisboa ("AAAA-MM-DD" + "HH:MM[:SS]") → instante UTC. PURA. */
function lisbonLocalToIso(day: string, time: string | null): string {
  const [hh, mm, ss] = (time ?? "12:00").split(":").map((x) => Number(x) || 0);
  const guess = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hh, mm, ss);
  const lis = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
  const utc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess - (lis.getTime() - utc.getTime())).toISOString();
}

/** CSV exportado da Viva Wallet (Date, Time, Amount, Channel…) → transações pagas. Nunca lança. PURA. */
export function parseVivaCsv(text: string): { txns: VivaTxn[]; errors: string[] } {
  const raw = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!raw.length) return { txns: [], errors: ["Ficheiro vazio."] };
  for (let h = 0; h < Math.min(raw.length, 10); h++) {
    const d = [";", ",", "\t"].sort((a, b) => raw[h].split(b).length - raw[h].split(a).length)[0];
    const hs = splitCsvLine(raw[h], d).map(norm);
    const col = (names: string[]) => hs.findIndex((x) => names.includes(x));
    const c = { date: col(VIVA_HEADERS.date), time: col(VIVA_HEADERS.time), amount: col(VIVA_HEADERS.amount), channel: col(VIVA_HEADERS.channel), id: col(VIVA_HEADERS.id), terminal: col(VIVA_HEADERS.terminal) };
    if (c.date < 0 || c.amount < 0) continue;
    const txns: VivaTxn[] = [];
    const errors: string[] = [];
    for (let i = h + 1; i < raw.length && txns.length < VIVA_CSV_MAX_LINES; i++) {
      const f = splitCsvLine(raw[i], d);
      const dateRaw = f[c.date] ?? "";
      const day = parseDate(dateRaw);
      const amount = parseAmount(f[c.amount]);
      if (!day || amount == null) { errors.push(`Linha ${i + 1}: sem data ou valor legíveis.`); continue; }
      if (amount <= 0) continue; // reembolsos
      const time = c.time >= 0 ? f[c.time] || null : (dateRaw.match(/\d{1,2}:\d{2}(:\d{2})?/)?.[0] ?? null);
      const terminalId = c.terminal >= 0 ? f[c.terminal] || null : null;
      txns.push({ id: c.id >= 0 ? f[c.id] || `csv-${i + 1}` : `csv-${i + 1}`, at: lisbonLocalToIso(day, time), amount, channel: csvChannel(c.channel >= 0 ? f[c.channel] : "", terminalId), status: "F", terminalId, sourceCode: null });
    }
    return { txns, errors: errors.slice(0, 50) };
  }
  return { txns: [], errors: ["Não encontrei o cabeçalho (precisa das colunas Date e Amount do extrato da Viva Wallet)."] };
}

/** Canal do CSV (sem canal = terminal: o extrato do TPA). */
function csvChannel(raw: unknown, terminalId?: unknown): VivaTxn["channel"] {
  const t = String(raw ?? "").toLowerCase();
  if (/card present|pos|terminal/.test(t) || (t === "" && terminalId)) return "terminal";
  if (/smart checkout|checkout|link|ecommerce|native/.test(t)) return "link";
  return t ? "other" : "terminal";
}

// ─── Dia de Lisboa ─────────────────────────────────────────────────────────

export function lisbonDayOf(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(t)) : null;
}
const dayNum = (d: string) => Math.round(Date.parse(`${d}T12:00:00Z`) / 86_400_000);

// ─── R30 Multibanco: Viva Wallet ───────────────────────────────────────────

export interface VivaMatch {
  matched: Array<{ bookingId: string; txnId: string; amount: number }>;
  /** Pagamentos por multibanco da Multipark sem transação no terminal. */
  missing: Map<string, { code: string | null; parkId: string | null; items: RecordedPayment[] }>;
  /** Transações do terminal sem pagamento registado na Multipark. */
  extra: VivaTxn[];
}

/**
 * Cada pagamento por multibanco (dias `days`) procura uma transação do terminal
 * com o mesmo valor, no mesmo dia (primeiro) ou no seguinte. Um para um. PURA.
 */
export function matchViva(o: { payments: readonly RecordedPayment[]; txns: readonly VivaTxn[]; days: readonly string[] }): VivaMatch {
  const pool = o.txns.filter((t) => t.channel !== "link").map((t) => ({ t, day: lisbonDayOf(t.at), used: false }));
  const matched: VivaMatch["matched"] = [];
  const missing: VivaMatch["missing"] = new Map();
  const want = new Set(o.days);
  for (const p of o.payments) {
    if (methodKind(p.method) !== "card" || p.amount <= 0) continue;
    const day = lisbonDayOf(p.recordedAt);
    if (!day || !want.has(day)) continue;
    const dn = dayNum(day);
    const pick = (gap: number) => pool.find((x) => !x.used && x.day && dayNum(x.day) - dn === gap && !neq(x.t.amount, p.amount));
    const hit = pick(0) ?? pick(1);
    if (hit) { hit.used = true; matched.push({ bookingId: p.bookingId, txnId: hit.t.id, amount: p.amount }); continue; }
    const cur = missing.get(p.bookingId) ?? { code: p.code, parkId: p.parkId, items: [] };
    cur.items.push(p);
    missing.set(p.bookingId, cur);
  }
  return { matched, missing, extra: pool.filter((x) => !x.used && x.day && want.has(x.day)).map((x) => x.t) };
}

export function vivaMissingFinding(items: readonly RecordedPayment[]): Finding {
  const total = r2(items.reduce((s, p) => s + p.amount, 0));
  return finding("mb_unconfirmed", `${eurText(total)} por multibanco (${[...new Set(items.map((p) => lisbonDayOf(p.recordedAt)))].join(", ")}) sem transação com o mesmo valor no terminal da Viva Wallet nesse dia ou no seguinte.`);
}

// ─── R30 Multibanco: talões (foto), conferidos à mão ───────────────────────

export interface MbReceipt { id: number; amount: number; bookingId: string | null }
export interface MbDayMatch {
  /** Pagamento (índice na lista dada) → talão. */
  byPayment: Map<number, number>;
  unmatchedPayments: RecordedPayment[];
  extraReceipts: MbReceipt[];
}

/**
 * Talões do dia contra os pagamentos por multibanco do parque nesse dia. Um
 * talão ligado à mão a uma reserva vai primeiro para um pagamento dessa
 * reserva; o resto casa pelo valor. Um para um. PURA.
 */
export function matchMbReceipts(o: { payments: readonly RecordedPayment[]; receipts: readonly MbReceipt[] }): MbDayMatch {
  const byPayment = new Map<number, number>();
  const used = new Set<number>();
  const mb = o.payments.map((p, i) => ({ p, i })).filter(({ p }) => methodKind(p.method) === "card" && p.amount > 0);
  const receipts = [...o.receipts].sort((a, b) => Number(!!b.bookingId) - Number(!!a.bookingId) || a.id - b.id);
  for (const r of receipts) {
    const cand = mb.filter(({ i, p }) => !byPayment.has(i) && !neq(p.amount, r.amount));
    const hit = (r.bookingId ? cand.find(({ p }) => p.bookingId === r.bookingId) : undefined) ?? cand[0];
    if (hit) { byPayment.set(hit.i, r.id); used.add(r.id); }
  }
  return {
    byPayment,
    unmatchedPayments: mb.filter(({ i }) => !byPayment.has(i)).map(({ p }) => p),
    extraReceipts: o.receipts.filter((r) => !used.has(r.id)),
  };
}

/** Confirmar o multibanco de um parque e dia: tudo com talão, e sem talões a mais. PURA. */
export function mbDayFinding(o: { parkName: string | null; day: string; unmatchedPayments: readonly RecordedPayment[]; extraReceipts: readonly MbReceipt[] }): Finding | null {
  const parts: string[] = [];
  if (o.unmatchedPayments.length) {
    const total = r2(o.unmatchedPayments.reduce((s, p) => s + p.amount, 0));
    parts.push(`${o.unmatchedPayments.length} pagamento(s) por multibanco sem talão (${eurText(total)}: ${o.unmatchedPayments.slice(0, 8).map((p) => `#${p.code ?? p.bookingId} ${eurText(p.amount)}`).join(", ")}${o.unmatchedPayments.length > 8 ? "…" : ""})`);
  }
  if (o.extraReceipts.length) {
    const total = r2(o.extraReceipts.reduce((s, r) => s + r.amount, 0));
    parts.push(`${o.extraReceipts.length} talão(ões) sem pagamento registado na Multipark (${eurText(total)})`);
  }
  return parts.length ? finding("mb_unconfirmed", `${o.parkName ?? "Parque"}, ${o.day}: ${parts.join("; ")}.`) : null;
}

// ─── R17 Recebimentos mensais (Pro, agentes, agregadores) ──────────────────

export const MONTHLY_KINDS = ["pro", "agente", "agregador"] as const;
export type MonthlyKind = (typeof MONTHLY_KINDS)[number];
export const MONTHLY_LABEL: Record<MonthlyKind, string> = { pro: "Cliente Pro", agente: "Agente", agregador: "Agregador" };

/** Tipo de parceiro da Multipark → agente ou agregador. PURA. */
export function monthlyKindOf(partnerType: string | null | undefined): MonthlyKind {
  return String(partnerType ?? "").toUpperCase() === "AGGREGATOR" ? "agregador" : "agente";
}

/**
 * Recebido (conferido à mão) contra o devido do mês na Multipark (saídas
 * desse mês). Pode vir a mais se pagar meses em atraso: só é diferença se
 * passar o devido + o que está em atraso. PURA.
 */
export function monthlyReceiptFinding(o: { kind: MonthlyKind; name: string; month: string; received: number; due: number | null; arrears?: number }): Finding | null {
  if (o.due == null) return null;
  const arrears = o.arrears ?? 0;
  const head = `${MONTHLY_LABEL[o.kind]} ${o.name}, ${o.month}: recebido ${eurText(o.received)}, devido do mês ${eurText(o.due)}`;
  if (o.received < o.due - MONEY_TOLERANCE) return finding("monthly_receipt", `${head} → faltam ${eurText(r2(o.due - o.received))}${arrears > MONEY_TOLERANCE ? ` (e há ${eurText(arrears)} em atraso de meses anteriores)` : ""}.`);
  if (o.received > o.due + arrears + MONEY_TOLERANCE) return finding("monthly_receipt", `${head}${arrears > MONEY_TOLERANCE ? ` + ${eurText(arrears)} em atraso` : ""} → a mais ${eurText(r2(o.received - o.due - arrears))}.`);
  return null;
}
