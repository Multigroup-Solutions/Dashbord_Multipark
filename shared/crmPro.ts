/**
 * CRM fase 2 — clientes Pro e CONTA CORRENTE (Jorge, 27 set 2026). PURO.
 *
 * Os Pro pagam no fim do mês. Quem manda é a Multipark: a regra do saldo é a
 * da página Pro deles (pendente = preço − pago, por reserva), por isso o saldo
 * daqui bate com o deles.
 *   - débito de uma reserva = soma das linhas de preço ("BookingPricing.total",
 *     já com o desconto); sem linhas, "bookingPrice";
 *   - pago = soma de "amountPaid"; as datas vêm dos pagamentos
 *     ("BookingPricingPayment.recordedAt"); o pago sem pagamento datado
 *     (registos antigos) entra como "pago (sem data)";
 *   - reserva cancelada: não deixa dívida (débito = o que foi pago);
 *   - acertos ("EntitySettlement") e pagamentos online ("ProPayment") são
 *     MARCAS ("período pago", "cobrança online"): mostram-se, não contam.
 * Mês de uma reserva = mês (Lisboa) da entrada. Meses já acabados e por pagar
 * = saldo em dívida; o mês corrente está "em curso".
 */

export const LEDGER_KINDS = ["booking", "payment", "paid_undated", "settlement", "online"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
/** Movimentos que contam no saldo. */
export const BALANCE_KINDS: ReadonlySet<string> = new Set(["booking", "payment", "paid_undated"]);

const cents = (n: number) => Math.round(n * 100) / 100;

const monthFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit" });

/** Instante UTC ("AAAA-MM-DD HH:MM:SS", ISO ou Date) → mês "AAAA-MM" em Lisboa. */
export function lisbonMonth(v: string | Date | null | undefined): string | null {
  if (v == null || v === "") return null;
  let d: Date;
  if (v instanceof Date) d = v;
  else {
    const s = String(v).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    // sem fuso = UTC (a BD grava UTC)
    d = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? new Date(s) : new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
  }
  if (Number.isNaN(d.getTime())) return null;
  const parts = monthFmt.formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value, mo = parts.find((p) => p.type === "month")?.value;
  return y && mo ? `${y}-${mo}` : null;
}

/** Período de um acerto da Multipark → mês "AAAA-MM" (o 1.º que se reconheça), ou null. */
export function parseMpPeriodKey(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/(\d{4})-(\d{1,2})(?!\d)/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2].padStart(2, "0")}`;
  m = s.match(/(?<!\d)(\d{1,2})\/(\d{4})(?!\d)/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{4})(\d{2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2]}`;
  return null;
}

/** O que uma reserva Pro deve (débito na conta corrente). */
export function bookingOwed(o: { pricingLines: number; pricingTotal: number | null; bookingPrice: number | null; paid: number; cancelled: boolean }): number {
  if (o.cancelled) return cents(Math.max(0, o.paid));
  const owed = o.pricingLines > 0 && o.pricingTotal != null ? o.pricingTotal : o.bookingPrice ?? 0;
  return cents(Math.max(0, owed));
}

/** Último instante (exclusivo) de um mês "AAAA-MM", em ms UTC (aprox. Lisboa: 1 h de folga não conta em dias). */
function monthEndMs(periodKey: string): number {
  const [y, m] = periodKey.split("-").map(Number);
  return Date.UTC(y, m, 1);
}

export interface LedgerRowIn {
  kind: string;
  entryAt: string;
  periodKey: string;
  debit: number;
  credit: number;
  infoAmount?: number | null;
  status?: string | null;
  method?: string | null;
  mpPeriodKey?: string | null;
  goneAt?: string | null;
}

export type MonthStatus = "open" | "due" | "paid" | "credit";

export interface MonthSummary {
  periodKey: string;
  debit: number;
  credit: number;
  pending: number;
  bookings: number;
  status: MonthStatus;
  /** acerto da Multipark para este mês (período pago) */
  settledAt: string | null;
  settledMethod: string | null;
}

export interface AccountSummary {
  /** débito − crédito de tudo */
  balance: number;
  /** por pagar dos meses já acabados */
  due: number;
  /** meses acabados com valor por pagar */
  dueMonths: number;
  oldestDue: string | null;
  /** débito do mês corrente ("Setembro até hoje") */
  currentMonthDebit: number;
  currentMonthBookings: number;
  paidThisYear: number;
  lastPaidAt: string | null;
  /** dias, em média (pesada pelo valor), entre o fim do mês e o pagamento */
  avgPayDays: number | null;
  months: MonthSummary[];
}

/** Resumo da conta corrente a partir dos movimentos. `now` só para testes. */
export function summarizeLedger(rows: LedgerRowIn[], now = new Date()): AccountSummary {
  const nowMonth = lisbonMonth(now)!;
  const year = nowMonth.slice(0, 4);
  const live = rows.filter((r) => !r.goneAt);
  const months = new Map<string, MonthSummary>();
  const month = (k: string) => {
    let m = months.get(k);
    if (!m) { m = { periodKey: k, debit: 0, credit: 0, pending: 0, bookings: 0, status: "open", settledAt: null, settledMethod: null }; months.set(k, m); }
    return m;
  };
  let balance = 0, paidThisYear = 0, lastPaidAt: string | null = null;
  let payWeighted = 0, payWeight = 0;
  for (const r of live) {
    if (r.kind === "settlement") {
      const k = parseMpPeriodKey(r.mpPeriodKey) ?? (r.periodKey || null);
      if (k) {
        const m = month(k);
        if (!m.settledAt || r.entryAt > m.settledAt) { m.settledAt = r.entryAt; m.settledMethod = r.method ?? null; }
      }
      continue;
    }
    if (!BALANCE_KINDS.has(r.kind) || !r.periodKey) continue;
    const m = month(r.periodKey);
    m.debit += r.debit;
    m.credit += r.credit;
    if (r.kind === "booking") m.bookings += 1;
    balance += r.debit - r.credit;
    if (r.credit > 0) {
      if (r.entryAt.slice(0, 4) === year) paidThisYear += r.credit;
      if (r.kind === "payment") {
        if (!lastPaidAt || r.entryAt > lastPaidAt) lastPaidAt = r.entryAt;
        const t = Date.UTC(+r.entryAt.slice(0, 4), +r.entryAt.slice(5, 7) - 1, +r.entryAt.slice(8, 10));
        const days = Math.max(0, Math.round((t - monthEndMs(r.periodKey)) / 86_400_000));
        payWeighted += days * r.credit;
        payWeight += r.credit;
      }
    }
  }
  let due = 0, dueMonths = 0, oldestDue: string | null = null;
  for (const m of months.values()) {
    m.debit = cents(m.debit);
    m.credit = cents(m.credit);
    m.pending = cents(m.debit - m.credit);
    if (m.periodKey >= nowMonth) m.status = "open";
    else if (m.pending > 0.005) m.status = "due";
    else if (m.pending < -0.005) m.status = "credit";
    else m.status = "paid";
    if (m.status === "due") {
      due += m.pending;
      dueMonths += 1;
      if (!oldestDue || m.periodKey < oldestDue) oldestDue = m.periodKey;
    }
  }
  const cur = months.get(nowMonth);
  return {
    balance: cents(balance),
    due: cents(due),
    dueMonths,
    oldestDue,
    currentMonthDebit: cents(cur?.debit ?? 0),
    currentMonthBookings: cur?.bookings ?? 0,
    paidThisYear: cents(paidThisYear),
    lastPaidAt,
    avgPayDays: payWeight > 0 ? Math.round(payWeighted / payWeight) : null,
    months: [...months.values()].sort((a, b) => b.periodKey.localeCompare(a.periodKey)),
  };
}

/** "2026-08" → "agosto 2026". */
export function monthLabel(periodKey: string): string {
  const [y, m] = periodKey.split("-").map(Number);
  if (!y || !m) return periodKey;
  const names = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  return `${names[m - 1]} ${y}`;
}

/** Links para a app da Multipark (domínio e caminhos da app de agentes). */
export const MULTIPARK_APP = "https://multipark.pt/pt-PT";
export const multiparkProUrl = (mpClientId: string) => `${MULTIPARK_APP}/agent/pros/${encodeURIComponent(mpClientId)}`;
export const multiparkBookingUrl = (bookingId: string) => `${MULTIPARK_APP}/agent/booking/${encodeURIComponent(bookingId)}`;
