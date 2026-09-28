/**
 * Conferência de caixa — regras de divergência (PURAS, sem BD).
 *
 * "Era" = a memória do webhook (`multipark_webhook_snapshots`, só acréscimo).
 * "É"   = a BD da Multipark lida AO VIVO no momento em que alguém pede.
 * Corre só a pedido (ficha da reserva e Faturação → "Correção de caixa"),
 * nunca como varredura periódica. Tolerância de 0,01 €.
 */
import type { MemorySnapshot } from "../webhookMemory";

export const MONEY_TOLERANCE = 0.01;

export interface LiveValidation { done: boolean; at: string | null; by: string | null }

/** A reserva na BD da Multipark, agora (só os campos de dinheiro). */
export interface LiveFinance {
  id: string;
  code: string | null;
  parkId: string | null;
  parkName: string | null;
  status: string | null;
  checkIn: string | null;
  checkOut: string | null;
  updatedAt: string | null;
  currency: string;
  bookingPrice: number | null;
  originalBookingPrice: number | null;
  parkingPrice: number | null;
  deliveryPrice: number | null;
  discountAmount: number | null;
  discountApplied: boolean | null;
  paymentMethod: string | null;
  paymentSource: string | null;
  paymentBy: string | null;
  campaignId: string | null;
  partnerId: string | null;
  partnerAmountDue: number | null;
  partnerAmountPaid: number | null;
  partnerContributedAmount: number | null;
  pro: boolean;
  proClientId: string | null;
  /** BookingPricing: n.º de linhas, soma do total e do pago. */
  linesCount: number;
  linesTotal: number | null;
  linesPaid: number | null;
  /** BookingPricingPayment: soma e métodos distintos. */
  paymentsCount: number;
  paymentsTotal: number | null;
  paymentMethods: string[];
  cashierClosed: LiveValidation;
  cashValidated: LiveValidation;
  driverValidated: LiveValidation;
}

export type DivergenceCode =
  | "only_live"
  | "only_memory"
  | "price_zeroed"
  | "price_after_checkin"
  | "price_after_creation"
  | "lines_below"
  | "method_changed"
  | "paid_mismatch"
  | "cancelled_after_checkin"
  | "cashier_closed_with_divergence";

export type Severity = "critical" | "high" | "medium";

export interface Divergence { code: DivergenceCode; severity: Severity; label: string; detail: string }

export const DIVERGENCE_LABELS: Record<DivergenceCode, string> = {
  only_live: "Só na Multipark (nunca chegou webhook)",
  only_memory: "Só na memória do webhook",
  price_zeroed: "Preço zerado",
  price_after_checkin: "Preço mudou depois do check-in",
  price_after_creation: "Preço mudou depois da criação",
  lines_below: "Linhas de preço retiradas ou baixadas",
  method_changed: "Método de pagamento mudou",
  paid_mismatch: "Pago ≠ esperado",
  cancelled_after_checkin: "Cancelada depois de entrar",
  cashier_closed_with_divergence: "Caixa fechada com divergência",
};

const SEVERITY: Record<DivergenceCode, Severity> = {
  only_live: "medium",
  only_memory: "medium",
  price_zeroed: "high",
  price_after_checkin: "high",
  price_after_creation: "medium",
  lines_below: "high",
  method_changed: "high",
  paid_mismatch: "high",
  cancelled_after_checkin: "high",
  cashier_closed_with_divergence: "critical",
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1 };

/** Estados em que o carro já entrou (o retrato é "do check-in" ou depois). */
export const IN_OR_AFTER_CHECKIN = new Set(["CHECKING_IN", "CHECKED_IN", "MOVING", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECKED_OUT"]);

export function eurText(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v.toFixed(2).replace(".", ",")} €`;
}
const differs = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && Math.abs(a - b) > MONEY_TOLERANCE;
const normMethod = (m: string | null | undefined) => (m ?? "").trim().toLowerCase();

/** Ordem da memória: pela hora de chegada (é a ordem em que soubemos). PURA. */
export function sortMemory(list: readonly MemorySnapshot[]): MemorySnapshot[] {
  return [...list].sort((a, b) => (a.receivedAt ?? "").localeCompare(b.receivedAt ?? "") || a.id - b.id);
}

export interface MemoryMoments {
  first: MemorySnapshot | null;
  /** Primeiro retrato com o carro já dentro (estado de check-in ou depois). */
  checkin: MemorySnapshot | null;
  last: MemorySnapshot | null;
  count: number;
  /** Último método de pagamento não vazio que o webhook disse. */
  lastMethod: string | null;
  /** Maior preço que o webhook alguma vez disse. */
  maxPrice: number | null;
}

/** Retratos → momentos (criação, check-in, último). PURA. */
export function memoryMoments(list: readonly MemorySnapshot[]): MemoryMoments {
  const s = sortMemory(list);
  const withPrice = s.filter((x) => x.bookingPrice != null);
  const methods = s.filter((x) => normMethod(x.paymentMethod));
  return {
    first: s[0] ?? null,
    checkin: s.find((x) => x.status != null && IN_OR_AFTER_CHECKIN.has(x.status)) ?? null,
    last: s[s.length - 1] ?? null,
    count: s.length,
    lastMethod: methods.length ? methods[methods.length - 1].paymentMethod : null,
    maxPrice: withPrice.length ? Math.max(...withPrice.map((x) => x.bookingPrice as number)) : null,
  };
}

/** Último preço conhecido pela memória (o último retrato que trouxe preço). */
function lastPrice(list: readonly MemorySnapshot[]): number | null {
  const s = sortMemory(list).filter((x) => x.bookingPrice != null);
  return s.length ? (s[s.length - 1].bookingPrice as number) : null;
}

/** O que a caixa devia ter recebido segundo a Multipark agora: linhas, senão o preço. */
export function expectedAmount(live: LiveFinance): number | null {
  return live.linesCount > 0 && live.linesTotal != null ? live.linesTotal : live.bookingPrice;
}
/** O que foi pago: pagamentos registados, senão o "pago" das linhas. */
export function paidAmount(live: LiveFinance): number | null {
  return live.paymentsCount > 0 && live.paymentsTotal != null ? live.paymentsTotal : live.linesPaid;
}

function push(out: Divergence[], code: DivergenceCode, detail: string) {
  out.push({ code, severity: SEVERITY[code], label: DIVERGENCE_LABELS[code], detail });
}

/**
 * Compara a memória do webhook (era) com a Multipark ao vivo (é) e devolve
 * as divergências com o motivo. `live = null` = a Multipark já não a tem
 * (ou não no âmbito pedido). PURA.
 */
export function compareBooking(memory: readonly MemorySnapshot[], live: LiveFinance | null): Divergence[] {
  const out: Divergence[] = [];
  const m = memoryMoments(memory);

  if (!live) {
    if (m.count) push(out, "only_memory", `A memória tem ${m.count} webhook(s) desta reserva (último: ${m.last?.status ?? "?"}), mas a Multipark não a devolve.`);
    return out;
  }
  if (!m.count) {
    // Sem memória não há "era". Uma cancelada que nunca nos chegou não é caixa.
    if (live.status !== "CANCELLED") push(out, "only_live", "A Multipark tem esta reserva, mas nunca nos chegou nenhum webhook dela: não há valor de origem para comparar.");
    return finish(out, live);
  }

  const now = live.bookingPrice;
  const firstP = m.first?.bookingPrice ?? null;
  const checkinP = m.checkin?.bookingPrice ?? null;
  const lastP = lastPrice(memory);
  const silent = differs(lastP, now) ? " Nenhum webhook avisou desta última alteração." : "";

  // Preço zerado: a memória chegou a ter preço > 0 e agora é 0 (ou as linhas somam 0).
  const zeroNow = (now != null && Math.abs(now) <= MONEY_TOLERANCE) || (live.linesCount > 0 && live.linesTotal != null && Math.abs(live.linesTotal) <= MONEY_TOLERANCE);
  if (m.maxPrice != null && m.maxPrice > MONEY_TOLERANCE && zeroNow) {
    push(out, "price_zeroed", `Era ${eurText(m.maxPrice)} (webhook), é ${eurText(now)}${live.linesCount ? ` e as linhas somam ${eurText(live.linesTotal)}` : ""}.${silent}`);
  } else if (differs(checkinP, now)) {
    push(out, "price_after_checkin", `No check-in era ${eurText(checkinP)} (webhook ${m.checkin?.eventType ?? ""} com estado ${m.checkin?.status ?? "?"}), agora é ${eurText(now)}.${silent}`);
  } else if (differs(firstP, now)) {
    push(out, "price_after_creation", `Na criação era ${eurText(firstP)} (1.º webhook), agora é ${eurText(now)}.${silent}`);
  } else if (differs(lastP, now)) {
    push(out, "price_after_creation", `O último webhook dizia ${eurText(lastP)}, agora é ${eurText(now)}.${silent}`);
  }

  // Linhas: a soma das linhas (BookingPricing) abaixo do preço que a memória conhece.
  const reference = lastP ?? checkinP ?? firstP;
  if (live.linesCount > 0 && live.linesTotal != null && reference != null && live.linesTotal < reference - MONEY_TOLERANCE && !out.some((d) => d.code === "price_zeroed")) {
    push(out, "lines_below", `As linhas de preço somam ${eurText(live.linesTotal)} (${live.linesCount} linha(s)), abaixo dos ${eurText(reference)} que o webhook disse.`);
  } else if (live.linesCount === 0 && reference != null && reference > MONEY_TOLERANCE && live.status === "CHECKED_OUT") {
    push(out, "lines_below", `A reserva saiu sem nenhuma linha de preço; o webhook disse ${eurText(reference)}.`);
  }

  // Método: o último método que o webhook disse ≠ o de agora.
  if (m.lastMethod && live.paymentMethod && normMethod(m.lastMethod) !== normMethod(live.paymentMethod)) {
    push(out, "method_changed", `Era ${m.lastMethod} (webhook), é ${live.paymentMethod}.${live.paymentMethods.length ? ` Pagamentos registados: ${live.paymentMethods.join(", ")}.` : ""}`);
  } else if (m.lastMethod && !live.paymentMethod) {
    push(out, "method_changed", `Era ${m.lastMethod} (webhook), agora está vazio.`);
  }

  // Cancelada depois de entrar.
  if (live.status === "CANCELLED" && m.checkin) {
    push(out, "cancelled_after_checkin", `O webhook disse ${m.checkin.status} e agora está cancelada.${(paidAmount(live) ?? 0) > MONEY_TOLERANCE ? ` Tem ${eurText(paidAmount(live))} pagos.` : ""}`);
  }

  return finish(out, live);
}

/** Regras que só dependem da Multipark ao vivo + caixa fechada. */
function finish(out: Divergence[], live: LiveFinance): Divergence[] {
  // Pago ≠ esperado (só depois de sair; as Pro/avença faturam ao mês).
  if (live.status === "CHECKED_OUT" && !live.pro) {
    const expected = expectedAmount(live);
    const paid = paidAmount(live) ?? 0;
    if (expected != null && Math.abs(paid - expected) > MONEY_TOLERANCE) {
      push(out, "paid_mismatch", `Pago ${eurText(paid)}, esperado ${eurText(expected)}${live.linesCount ? " (soma das linhas)" : " (preço)"}${live.partnerId ? "; reserva de parceiro (confirmar se o parceiro paga)" : ""}.`);
    }
  }
  const money = out.filter((d) => d.code !== "only_live" && d.code !== "only_memory");
  if (live.cashierClosed.done && money.length) {
    push(out, "cashier_closed_with_divergence", `Caixa fechada${live.cashierClosed.by ? ` por ${live.cashierClosed.by}` : ""}${live.cashierClosed.at ? ` em ${live.cashierClosed.at.slice(0, 16).replace("T", " ")} UTC` : ""} com ${money.length} divergência(s).`);
  }
  return out;
}

/** A pior gravidade de uma lista (null se vazia). PURA. */
export function worstSeverity(list: readonly Divergence[]): Severity | null {
  let best: Severity | null = null;
  for (const d of list) if (!best || SEVERITY_RANK[d.severity] > SEVERITY_RANK[best]) best = d.severity;
  return best;
}

export function severityRank(s: Severity | null): number {
  return s ? SEVERITY_RANK[s] : 0;
}

// ─── "Era / é" campo a campo (ficha da reserva) ─────────────────────────────

export interface EraRow {
  key: string;
  label: string;
  first: string | null;
  last: string | null;
  live: string | null;
  /** O valor de agora difere do 1.º ou do último webhook. */
  changed: boolean;
  /** O webhook não traz este campo (hoje). */
  notInWebhook: boolean;
}

const yesNo = (v: boolean | null | undefined) => (v == null ? null : v ? "sim" : "não");
const txt = (v: string | null | undefined) => (v == null || v === "" ? null : v);

/**
 * Tabela "era / é": 1.º webhook, último webhook e Multipark agora, campo a
 * campo. `changed` marca só os campos que o webhook trouxe e que agora são
 * diferentes. PURA.
 */
export function eraRows(memory: readonly MemorySnapshot[], live: LiveFinance | null): EraRow[] {
  const m = memoryMoments(memory);
  const f = m.first, l = m.last;
  const rows: Array<{ key: string; label: string; mem: (s: MemorySnapshot) => string | null; live: (x: LiveFinance) => string | null; money?: (s: MemorySnapshot | null) => number | null; liveMoney?: (x: LiveFinance) => number | null }> = [
    { key: "status", label: "Estado", mem: (s) => txt(s.status), live: (x) => txt(x.status) },
    { key: "checkIn", label: "Entrada", mem: (s) => txt(s.checkIn), live: (x) => txt(x.checkIn) },
    { key: "checkOut", label: "Saída", mem: (s) => txt(s.checkOut), live: (x) => txt(x.checkOut) },
    { key: "bookingPrice", label: "Preço (bookingPrice)", mem: (s) => (s.bookingPrice == null ? null : eurText(s.bookingPrice)), live: (x) => (x.bookingPrice == null ? null : eurText(x.bookingPrice)), money: (s) => s?.bookingPrice ?? null, liveMoney: (x) => x.bookingPrice },
    { key: "originalBookingPrice", label: "Preço original", mem: (s) => (s.originalBookingPrice == null ? null : eurText(s.originalBookingPrice)), live: (x) => (x.originalBookingPrice == null ? null : eurText(x.originalBookingPrice)), money: (s) => s?.originalBookingPrice ?? null, liveMoney: (x) => x.originalBookingPrice },
    { key: "linesTotal", label: "Soma das linhas (BookingPricing)", mem: () => null, live: (x) => (x.linesCount ? `${eurText(x.linesTotal)} (${x.linesCount})` : "sem linhas") },
    { key: "linesPaid", label: "Pago nas linhas", mem: (s) => (s.paidAmount == null ? null : eurText(s.paidAmount)), live: (x) => (x.linesPaid == null ? null : eurText(x.linesPaid)), money: (s) => s?.paidAmount ?? null, liveMoney: (x) => x.linesPaid },
    { key: "paymentsTotal", label: "Pagamentos registados", mem: () => null, live: (x) => (x.paymentsCount ? `${eurText(x.paymentsTotal)} (${x.paymentsCount})` : "nenhum") },
    { key: "paymentMethod", label: "Método de pagamento", mem: (s) => txt(s.paymentMethod), live: (x) => txt(x.paymentMethod) },
    { key: "paymentMethods", label: "Métodos dos pagamentos", mem: () => null, live: (x) => (x.paymentMethods.length ? x.paymentMethods.join(", ") : null) },
    { key: "paymentSource", label: "Origem do pagamento", mem: (s) => txt(s.paymentSource), live: (x) => txt(x.paymentSource) },
    { key: "discountAmount", label: "Desconto", mem: (s) => (s.discountAmount == null ? null : eurText(s.discountAmount)), live: (x) => (x.discountAmount == null ? null : eurText(x.discountAmount)), money: (s) => s?.discountAmount ?? null, liveMoney: (x) => x.discountAmount },
    { key: "campaignId", label: "Campanha", mem: (s) => txt(s.campaignId), live: (x) => txt(x.campaignId) },
    { key: "partnerId", label: "Parceiro", mem: (s) => txt(s.partnerId), live: (x) => txt(x.partnerId) },
    { key: "partnerAmountDue", label: "Parceiro: devido", mem: (s) => (s.partnerAmountDue == null ? null : eurText(s.partnerAmountDue)), live: (x) => (x.partnerAmountDue == null ? null : eurText(x.partnerAmountDue)), money: (s) => s?.partnerAmountDue ?? null, liveMoney: (x) => x.partnerAmountDue },
    { key: "partnerAmountPaid", label: "Parceiro: pago", mem: (s) => (s.partnerAmountPaid == null ? null : eurText(s.partnerAmountPaid)), live: (x) => (x.partnerAmountPaid == null ? null : eurText(x.partnerAmountPaid)), money: (s) => s?.partnerAmountPaid ?? null, liveMoney: (x) => x.partnerAmountPaid },
    { key: "pro", label: "Pro / avença", mem: (s) => yesNo(s.pro), live: (x) => yesNo(x.pro) },
    { key: "cashierClosed", label: "Caixa fechada", mem: (s) => yesNo(s.cashierClosed), live: (x) => validationText(x.cashierClosed) },
    { key: "cashValidated", label: "Dinheiro conferido", mem: (s) => yesNo(s.cashValidated), live: (x) => validationText(x.cashValidated) },
    { key: "driverValidated", label: "Condutor validou", mem: (s) => yesNo(s.driverValidated), live: (x) => validationText(x.driverValidated) },
  ];
  return rows.map((r) => {
    const first = f ? r.mem(f) : null;
    const last = l ? r.mem(l) : null;
    const lv = live ? r.live(live) : null;
    const notInWebhook = memory.every((s) => r.mem(s) == null);
    let changed = false;
    if (live && !notInWebhook) {
      if (r.money && r.liveMoney) changed = differs(r.money(f), r.liveMoney(live)) || differs(r.money(l), r.liveMoney(live));
      else if (r.key === "cashierClosed" || r.key === "cashValidated" || r.key === "driverValidated") {
        const lastBool = l ? (l as any)[r.key] as boolean | null : null;
        changed = lastBool != null && lastBool !== (live as any)[r.key].done;
      } else if (r.key === "checkIn" || r.key === "checkOut") {
        const a = last ? Date.parse(last) : NaN;
        const b = lv ? Date.parse(lv) : NaN;
        changed = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 60_000;
      } else {
        changed = last != null && lv != null && last.trim().toLowerCase() !== lv.trim().toLowerCase();
      }
    }
    return { key: r.key, label: r.label, first, last, live: lv, changed, notInWebhook };
  });
}

function validationText(v: LiveValidation): string {
  if (!v.done) return "não";
  return ["sim", v.by ? `por ${v.by}` : null, v.at ? v.at.slice(0, 16).replace("T", " ") + " UTC" : null].filter(Boolean).join(" · ");
}

/** Campos de dinheiro cuja alteração interessa na História (antes → depois). */
export const MONEY_HISTORY_FIELDS = new Set([
  "bookingPrice", "originalBookingPrice", "parkingPrice", "deliveryPrice", "discountAmount", "discountApplied", "priceValidated",
  "paymentMethod", "paymentSource", "paymentBy", "campaignId", "partnerId", "partnerAmountDue", "partnerAmountPaid",
  "partnerContributedAmount", "pro", "proClientId", "clientPlanId", "allowance", "status", "cashValidated", "driverValidated",
  "cashierClosed", "cashValidatedAt", "cashierClosedAt", "driverValidatedAt", "creditId", "total", "amountPaid", "amount",
]);
