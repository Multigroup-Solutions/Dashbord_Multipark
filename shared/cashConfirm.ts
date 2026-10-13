/**
 * Confirmação da caixa reserva a reserva (plano docs/plans/2026-10-13-confirmacao-caixa-plano.md,
 * decisões do Jorge de 13 out 2026). PURO — sem BD, usado pelo servidor e pelo ecrã.
 *
 * Por cidade e dia da caixa (03:00 → 03:00, decisão 30a), só os parques que operamos:
 *  - as SAÍDAS do dia vêm lado a lado: preço quando nasceu (1.º webhook, nossa
 *    memória), original da Multipark, final e o que foi pago por método,
 *    crédito/taxa e as 3 validações da Multipark — com todas as regras;
 *  - as reservas que só têm um PAGAMENTO no dia (pago no check-in, pré-pago…)
 *    entram só com o dinheiro de balcão desse dia (o preço confere-se no dia da
 *    saída — nunca duas vezes);
 *  - achados: verde (só aparece), amarelo (a rever), vermelho (o João tem de
 *    "Justificar"). Para cima pode (mais tempo, extra, taxa); para baixo nunca
 *    sem justificação;
 *  - o dia: o team leader declara na passagem de turno o dinheiro e o MB
 *    recebidos e o total que dava a caixa; o João conta o envelope e os talões no
 *    dia seguinte. Diferença (dinheiro e MB, em valor absoluto) > 30 € → dia
 *    amarelo no mês para o Jorge (+ aviso na app); > 70 € → também email.
 *
 * Valores em cêntimos inteiros nas contas (half-even antes de somar). Na dúvida
 * nunca é verde (falha fechado).
 */

// ─── Dinheiro ───────────────────────────────────────────────────────────────

/** Euros → cêntimos inteiros, half-even (banker's rounding). PURA. */
export function toCents(v: number | null | undefined): number {
  if (v == null || !Number.isFinite(v)) return 0;
  const x = v * 100;
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}
/** Tem mais de 2 casas decimais (sub-cêntimo)? PURA. */
export const hasSubCent = (v: number | null | undefined): boolean => v != null && Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) > 1e-6;

export function eur(c: number | null | undefined): string {
  if (c == null) return "—";
  const sign = c < 0 ? "−" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)},${String(a % 100).padStart(2, "0")} €`;
}

// ─── Limiares do dia (Jorge, 13 out) ────────────────────────────────────────

/** Diferença do dia acima disto → dia amarelo no mês + notificação na app. */
export const DAY_DIFF_AMBER_CENTS = 3000;
/** Acima disto → também email ao Jorge. */
export const DAY_DIFF_EMAIL_CENTS = 7000;

export type DayAlert = "none" | "amber" | "email";
/** Nível de alerta de uma diferença do dia (cêntimos, em valor absoluto). PURA. */
export function dayAlertOf(absCents: number | null): DayAlert {
  if (absCents == null) return "none";
  const a = Math.abs(absCents);
  if (a > DAY_DIFF_EMAIL_CENTS) return "email";
  if (a > DAY_DIFF_AMBER_CENTS) return "amber";
  return "none";
}

// ─── Métodos ────────────────────────────────────────────────────────────────

export type PayKind = "cash" | "card" | "online" | "transfer" | "off_counter" | "unknown";
export const PAY_KIND_LABEL: Record<PayKind, string> = {
  cash: "Dinheiro", card: "Multibanco", online: "Online (Stripe)", transfer: "Transferência", off_counter: "Fora do balcão", unknown: "Método desconhecido",
};

export const normText = (s: string | null | undefined) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/**
 * Texto livre do método (Multipark) → tipo. Dicionário EXATO primeiro (valores
 * conhecidos), depois padrões estritos; o resto é `unknown` (achado vermelho).
 * MB WAY é online (passa pela Stripe), "Cartão de crédito" é cartão, "Crédito"
 * sozinho é fora do balcão. Nomes de parceiros só com `partnerNames`. PURA.
 */
export function payKind(method: string | null | undefined, partnerNames: ReadonlySet<string> = new Set()): PayKind {
  const m = normText(method);
  if (!m || m === "unknown" || m === "desconhecido") return "unknown";
  const EXACT: Record<string, PayKind> = {
    "numerario": "cash", "dinheiro": "cash", "cash": "cash",
    "multibanco": "card", "mb": "card", "tpa": "card", "cartao": "card", "cartao de credito": "card", "cartao de debito": "card", "viva wallet": "card", "vivawallet": "card",
    "online": "online", "online, card": "online", "online, mbway": "online", "online, mb way": "online", "mbway": "online", "mb way": "online", "stripe": "online",
    "transferencia bancaria": "transfer", "transferencia": "transfer",
    "credito": "off_counter", "pro_plan": "off_counter", "client_plan": "off_counter", "avenca": "off_counter",
  };
  if (EXACT[m]) return EXACT[m];
  if (partnerNames.has(m)) return "off_counter";
  if (/^online\b/.test(m) || /\bmb ?way\b/.test(m) || /\bstripe\b/.test(m)) return "online";
  if (/^(numerario|dinheiro)\b/.test(m)) return "cash";
  if (/^multibanco\b/.test(m)) return "card";
  if (/^transferencia\b/.test(m)) return "transfer";
  return "unknown";
}

/** Métodos que o João confere na gaveta do dia (dinheiro e MB). */
export const isCounterKind = (k: PayKind) => k === "cash" || k === "card";

// ─── Entradas do motor ──────────────────────────────────────────────────────

export interface ConfirmValidation { done: boolean; at: string | null; by: string | null; byId: string | null }
export interface ConfirmLine { id: string; description: string | null; category: string | null; total: number | null; amountPaid: number | null; extraServiceId: string | null }
export interface ConfirmPayment { id: string; pricingId: string | null; amount: number | null; method: string | null; recordedAt: string | null }

/** Uma reserva da Multipark, agora (só leitura). */
export interface ConfirmBookingLive {
  id: string; code: string | null; parkId: string; parkName: string | null; status: string | null;
  checkIn: string | null; checkOut: string | null; createdAt: string | null;
  bookingPrice: number | null; originalBookingPrice: number | null;
  paymentMethod: string | null; campaignId: string | null; partnerId: string | null;
  pro: boolean; clientPlanId: string | null; allowance: boolean;
  checkOutDriverName: string | null; checkInDriverId: string | null; checkingInAt: string | null;
  paymentIntentId: string | null; stripeChargeId: string | null;
  credit: number | null; fees: number | null;
  cashierClosed: ConfirmValidation; cashValidated: ConfirmValidation; driverValidated: ConfirmValidation;
  lines: ConfirmLine[]; payments: ConfirmPayment[];
  /** Pagamentos online que a Multipark liga à reserva (links SETTLED, faturas, PI da reserva). */
  intents: Array<{ id: string; expected: number | null }>;
  cancelled: boolean; refunded: number | null;
}

/** O que a nossa memória do webhook viu quando a reserva nasceu (BOOKING_CREATED, só acréscimo). */
export interface ConfirmOrigin {
  source: "webhook" | null;
  bookingPrice: number | null;
  originalBookingPrice: number | null;
  checkOut: string | null;
  receivedAt: string | null;
  /** Marcas fora do balcão que a reserva tinha quando nasceu. */
  pro: boolean | null; partnerId: string | null; campaignId: string | null;
  /** Lido da BD da Multipark mais de 2 min depois de a reserva nascer: pode já não ser o preço da criação. */
  late: boolean;
}

/** Tempo máximo entre o nascimento da reserva e a nossa leitura para o retrato contar como "da criação". */
export const ORIGIN_LATE_MS = 120_000;
/** Pagamento de balcão registado mais do que isto depois da saída = recriado/atrasado. */
export const LATE_PAYMENT_MS = 30 * 60_000;
/** Saída mais cedo do que isto face ao reservado = saída antecipada. */
export const EARLY_CHECKOUT_MS = 15 * 60_000;

/** Resultado da Stripe para um PaymentIntent: null = a Stripe não o mostra (404). Ausente = não lido. */
export interface StripeCheck { status: string | null; received: number | null; refunded: number | null; disputed: boolean }

/** Talão MB (foto) ou, quando a API da Viva for ligada, transação do adquirente — ligado à reserva. */
export interface MbReceiptRef { id: number; amountCents: number; bookingId: string | null }

/** Como a reserva entra no dia. */
export type InDay = "checkout" | "checkout_pending" | "cancelled" | "payment_only";
export const isCheckoutKind = (k: InDay) => k === "checkout" || k === "checkout_pending";

// ─── Achados ────────────────────────────────────────────────────────────────

export type Color = "green" | "amber" | "red";

export type FindingCode =
  | "price_down" | "price_down_early" | "price_up_unexplained" | "no_origin" | "origin_conflict" | "origin_late" | "marker_added"
  | "underpaid" | "overpaid" | "credit_given" | "fee_cash" | "negative_payment" | "unknown_method" | "off_counter_method"
  | "ledger_mismatch" | "legacy_line" | "subcent" | "late_payment"
  | "mb_no_receipt" | "online_unverified" | "online_mismatch" | "transfer_unproven"
  | "mp_not_closed" | "mp_order" | "cancelled_after_checkin" | "checkout_unfinished" | "not_checked_out";

export const FINDING_LABEL: Record<FindingCode, string> = {
  price_down: "Preço baixou",
  price_down_early: "Preço baixou (saída antecipada)",
  price_up_unexplained: "Preço subiu sem causa visível",
  no_origin: "Sem preço de origem (reserva anterior à memória)",
  origin_conflict: "Preço original diferente do que vimos nascer",
  origin_late: "Webhook de criação lido tarde",
  marker_added: "PRO / parceiro ligado depois da criação",
  underpaid: "Pago a menos",
  overpaid: "Pago a mais",
  credit_given: "Crédito dado",
  fee_cash: "Taxa extra cobrada em dinheiro",
  negative_payment: "Pagamento negativo",
  unknown_method: "Método de pagamento desconhecido",
  off_counter_method: "Método fora do balcão numa reserva normal",
  ledger_mismatch: "Pago na linha ≠ pagamentos registados",
  legacy_line: "Linha antiga sem registo de pagamentos",
  subcent: "Valor com mais de 2 casas decimais",
  late_payment: "Pagamento registado depois da saída",
  mb_no_receipt: "Multibanco sem talão",
  online_unverified: "Online por verificar na Stripe",
  online_mismatch: "Online não bate com a Stripe",
  transfer_unproven: "Transferência sem comprovativo",
  mp_not_closed: "Caixa por fechar na Multipark",
  mp_order: "Validações da Multipark fora de ordem",
  cancelled_after_checkin: "Cancelada depois do check-in",
  checkout_unfinished: "Saída por concluir na Multipark",
  not_checked_out: "Pagamento do dia numa reserva sem saída",
};

/** Achados vermelhos cuja justificação precisa de comprovativo (foto ou PDF). */
export const PROOF_REQUIRED: ReadonlySet<FindingCode> = new Set<FindingCode>([
  "price_down", "underpaid", "negative_payment", "off_counter_method", "transfer_unproven", "online_mismatch", "cancelled_after_checkin", "marker_added",
]);

export interface Finding {
  /** Chave estável: reserva + código (+ conteúdo do pagamento/linha quando é por pagamento). */
  key: string;
  bookingId: string;
  code: FindingCode;
  color: Color;
  /** Valor em causa (cêntimos, ≥ 0). Uma justificação só vale para este valor. */
  amountCents: number;
  detail: string;
}

const norm = normText;
const isCheckedOut = (s: string | null) => String(s ?? "").toUpperCase() === "CHECKED_OUT";
const OFF_COUNTER_DISCOUNT_LINES = new Set(["desconto pro", "desconto campanha"]);
const yes = (v: boolean) => (v ? "sim" : "não");
const at16 = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "?");

/** Sub-chaves pelo conteúdo: "p:<método>|<cêntimos>#<n>" (pagamentos) e "l:<descrição>|<categoria>|<cêntimos>#<n>" (linhas). PURA. */
export function stableSubKeys(b: Pick<ConfirmBookingLive, "payments" | "lines">): { payment: Map<string, string>; line: Map<string, string> } {
  const payment = new Map<string, string>(), line = new Map<string, string>();
  const seen = new Map<string, number>();
  const sorted = [...b.payments].sort((x, y) => String(x.recordedAt ?? "").localeCompare(String(y.recordedAt ?? "")) || toCents(x.amount) - toCents(y.amount));
  for (const p of sorted) {
    const base = `p:${norm(p.method)}|${toCents(p.amount)}`;
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    payment.set(p.id, `${base}#${n}`);
  }
  for (const l of b.lines) {
    const base = `l:${norm(l.description)}|${norm(l.category)}|${toCents(l.total)}`;
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    line.set(l.id, `${base}#${n}`);
  }
  return { payment, line };
}

/**
 * A reserva é "fora do balcão" (PRO/parceiro/avença)? Com memória, as marcas
 * PRO e parceiro só contam se já existiam quando a reserva nasceu (avença não
 * está na memória: conta a de agora). PURA.
 */
export function offCounterOf(b: Pick<ConfirmBookingLive, "pro" | "partnerId" | "clientPlanId" | "allowance">, origin: ConfirmOrigin | null): boolean {
  const plan = !!b.clientPlanId || b.allowance;
  if (origin?.source !== "webhook") return b.pro || !!b.partnerId || plan;
  return (b.pro && origin.pro === true) || (!!b.partnerId && !!origin.partnerId) || plan;
}

/**
 * Achados de UMA reserva no dia. `windowPaymentIds` = pagamentos desta reserva
 * registados na janela do dia. As saídas levam todas as regras; as reservas só
 * com pagamento no dia (ou canceladas) só as do dinheiro desse dia. PURA.
 */
export function bookingFindings(i: {
  live: ConfirmBookingLive;
  origin: ConfirmOrigin | null;
  windowPaymentIds: ReadonlySet<string>;
  inDay: InDay;
  stripe: ReadonlyMap<string, StripeCheck | null>;
  stripeAvailable: boolean;
  mbReceipts: readonly MbReceiptRef[];
  partnerNames?: ReadonlySet<string>;
}): Finding[] {
  const b = i.live;
  const out: Finding[] = [];
  const add = (code: FindingCode, color: Color, amountCents: number, detail: string, sub?: string) =>
    out.push({ key: `${b.id}:${code}${sub ? `:${sub}` : ""}`, bookingId: b.id, code, color, amountCents: Math.max(0, amountCents), detail });
  const partners = i.partnerNames ?? new Set<string>();
  const subOf = stableSubKeys(b);
  const offCounter = offCounterOf(b, i.origin);
  const checkout = isCheckoutKind(i.inDay);
  const windowPays = b.payments.filter((p) => i.windowPaymentIds.has(p.id));
  const lineOf = new Map(b.lines.map((l) => [l.id, l]));
  const paidByLine = new Map<string, number>();
  for (const p of b.payments) if (p.pricingId) paidByLine.set(p.pricingId, (paidByLine.get(p.pricingId) ?? 0) + toCents(p.amount));
  // Pagamento negativo numa linha de desconto que bate com o total da linha = o desconto registado como pagamento (normal).
  const isDiscountMirror = (p: ConfirmPayment) => {
    const l = p.pricingId ? lineOf.get(p.pricingId) : undefined;
    return !!l && String(l.category ?? "").toUpperCase() === "DISCOUNT" && paidByLine.get(l.id) === toCents(l.total);
  };

  // ── Dinheiro de balcão do dia (todas as reservas) ──
  const scope = checkout ? b.payments : windowPays;
  for (const p of scope) {
    const c = toCents(p.amount);
    const k = payKind(p.method, partners);
    const sub = subOf.payment.get(p.id);
    if (hasSubCent(p.amount)) add("subcent", "amber", 0, `Pagamento de ${p.amount} € com mais de 2 casas decimais.`, sub);
    if (c < 0 && !isDiscountMirror(p)) add("negative_payment", "red", -c, `Pagamento negativo de ${eur(c)} (${p.method ?? "sem método"}).`, sub);
    if (k === "unknown") add("unknown_method", "red", Math.abs(c), `Método "${p.method ?? "vazio"}" não reconhecido (${eur(c)}).`, sub);
    if (k === "off_counter" && !offCounter) add("off_counter_method", "red", Math.abs(c), `${eur(c)} registados como "${p.method}" numa reserva que não é PRO, avença nem parceiro (desde a criação).`, sub);
    if (k === "transfer" && c > 0) add("transfer_unproven", "red", c, `${eur(c)} por transferência: precisa do comprovativo do banco.`, sub);
  }
  // Pagamento de balcão no dia registado depois da saída (recriado pela Multipark ou lançado tarde).
  for (const p of windowPays) {
    const k = payKind(p.method, partners);
    if (!(isCounterKind(k) || k === "unknown") || !p.recordedAt || !b.checkOut || !isCheckedOut(b.status)) continue;
    const late = Date.parse(p.recordedAt) - Date.parse(b.checkOut);
    if (late > LATE_PAYMENT_MS) add("late_payment", "red", Math.abs(toCents(p.amount)), `${eur(toCents(p.amount))} em "${p.method ?? "?"}" registados ${at16(p.recordedAt)}, ${Math.round(late / 3_600_000 * 10) / 10} h depois da saída (${at16(b.checkOut)}): recálculo da Multipark ou dinheiro lançado tarde.`, subOf.payment.get(p.id));
  }
  // Multibanco do dia: um talão (ou transação do adquirente) ligado à reserva, com o mesmo valor, por pagamento.
  const cards = windowPays.filter((p) => payKind(p.method, partners) === "card" && toCents(p.amount) > 0);
  const receipts = i.mbReceipts.filter((r) => r.bookingId === b.id).map((r) => r.amountCents);
  const used = new Set<number>();
  for (const p of cards) {
    const c = toCents(p.amount);
    const idx = receipts.findIndex((r, j) => !used.has(j) && r === c);
    if (idx >= 0) used.add(idx);
    else add("mb_no_receipt", "red", c, `Pagamento MB de ${eur(c)} sem talão com o mesmo valor.`, subOf.payment.get(p.id));
  }

  // Cancelada depois do check-in.
  if (i.inDay === "cancelled") {
    const paid = b.payments.reduce((s, p) => s + toCents(p.amount), 0) - toCents(b.refunded);
    add("cancelled_after_checkin", "red", paid, `Teve check-in${b.checkingInAt ? ` (${at16(b.checkingInAt)})` : ""} e foi cancelada${paid > 0 ? `; ficaram ${eur(paid)} pagos (já descontado o reembolso)` : ""}.`);
  }
  if (i.inDay === "payment_only") {
    const dayCounter = windowPays.filter((p) => isCounterKind(payKind(p.method, partners)));
    if (dayCounter.length) add("not_checked_out", "amber", 0, `Recebidos no dia ${eur(dayCounter.reduce((s, p) => s + toCents(p.amount), 0))} ao balcão numa reserva que não saiu neste dia (estado ${b.status ?? "?"}).`);
  }
  if (!checkout) return out;

  // ── Só as saídas do dia daqui para baixo ──
  if (i.inDay === "checkout_pending") add("checkout_unfinished", "red", 0, `A saída está por concluir na Multipark (estado ${b.status ?? "?"}).`);

  // Marcas fora do balcão ganhas depois da criação.
  if (i.origin?.source === "webhook") {
    const added: string[] = [];
    if (b.pro && i.origin.pro !== true) added.push("PRO");
    if (b.partnerId && !i.origin.partnerId) added.push("parceiro");
    if (added.length) add("marker_added", "red", 0, `A reserva passou a ${added.join(" e ")} depois de nascer: o pagamento deixa de ser conferido ao balcão.`);
  }

  // ── Preço: origem e variação ──
  const final = b.bookingPrice == null ? null : toCents(b.bookingPrice);
  const original = b.originalBookingPrice != null && b.originalBookingPrice > 0 ? toCents(b.originalBookingPrice) : null;
  const born = i.origin?.source === "webhook" && i.origin.bookingPrice != null ? toCents(i.origin.bookingPrice) : null;
  const bornOriginal = i.origin?.source === "webhook" && i.origin.originalBookingPrice != null && i.origin.originalBookingPrice > 0 ? toCents(i.origin.originalBookingPrice) : null;
  if (born == null) {
    add("no_origin", "amber", 0, original == null
      ? "Sem webhook de criação nem preço original na Multipark: não há com que comparar o preço."
      : `Sem webhook de criação (reserva anterior à memória ou webhook em falta): compara-se com o preço original da Multipark (${eur(original)}), que se pode alterar.`);
  } else {
    if (original != null && bornOriginal != null && original !== bornOriginal) {
      add("origin_conflict", original < bornOriginal ? "red" : "amber", Math.max(0, bornOriginal - original), `Quando nasceu o original era ${eur(bornOriginal)} (webhook); agora a Multipark diz ${eur(original)}.`);
    }
    if (i.origin?.late) add("origin_late", "amber", 0, `O webhook de criação foi lido mais de ${ORIGIN_LATE_MS / 60_000} min depois de a reserva nascer${i.origin.receivedAt ? ` (${at16(i.origin.receivedAt)})` : ""}: o preço de origem pode já ter mudado.`);
  }
  // Base: o preço líquido com que a reserva nasceu (já com os descontos da criação). Sem memória, o original da Multipark.
  const base = born ?? original;
  if (base != null && final != null) {
    if (final < base) {
      // Sem memória, as linhas "Desconto PRO"/"Desconto campanha" explicam a descida até ao valor delas (o original é antes dos descontos).
      const covered = born != null ? 0 : b.lines.reduce((s, l) => {
        const d = norm(l.description);
        const ok = (d === "desconto pro" && b.pro) || (d === "desconto campanha" && !!b.campaignId);
        return ok && OFF_COUNTER_DISCOUNT_LINES.has(d) ? s + Math.abs(toCents(l.total)) : s;
      }, 0);
      const down = base - final;
      const unexplained = down - Math.min(down, covered);
      if (unexplained > 0) {
        const early = !!i.origin?.checkOut && !!b.checkOut && Date.parse(i.origin.checkOut) - Date.parse(b.checkOut) > EARLY_CHECKOUT_MS;
        add(early ? "price_down_early" : "price_down", "red", unexplained,
          `Era ${eur(base)}${born != null ? " quando nasceu (webhook)" : " (preço original)"}, agora é ${eur(final)}: desceu ${eur(down)}${covered ? ` (${eur(Math.min(down, covered))} explicados por desconto PRO/campanha)` : ""}${early ? `; saiu mais cedo (reservado até ${at16(i.origin!.checkOut)}, saiu ${at16(b.checkOut)})` : ""}.`);
      }
    } else if (final > base) {
      const later = !!i.origin?.checkOut && !!b.checkOut && Date.parse(b.checkOut) - Date.parse(i.origin.checkOut) > EARLY_CHECKOUT_MS;
      const explaining = b.lines.some((l) => {
        const c = String(l.category ?? "").toUpperCase();
        return (c === "SERVICE" && !!l.extraServiceId) || c === "FEE";
      });
      if (!later && !explaining) add("price_up_unexplained", "amber", 0, `Era ${eur(base)}, agora é ${eur(final)} (+${eur(final - base)}) sem mais dias, extra ou taxa nas linhas.`);
    }
  }

  // ── Pagamentos da reserva ──
  const paid = b.payments.reduce((s, p) => s + toCents(p.amount), 0);
  for (const l of b.lines) {
    const lp = toCents(l.amountPaid);
    const reg = paidByLine.get(l.id);
    if (reg == null) { if (lp !== 0) add("legacy_line", "amber", 0, `Linha "${l.description ?? "?"}" diz ${eur(lp)} pagos mas não tem pagamentos registados.`, subOf.line.get(l.id)); }
    else if (reg !== lp) add("ledger_mismatch", "red", Math.abs(reg - lp), `Linha "${l.description ?? "?"}": pago na linha ${eur(lp)}, pagamentos registados ${eur(reg)}.`, subOf.line.get(l.id));
  }
  const credit = toCents(b.credit);
  const fees = toCents(b.fees);
  if (credit > 0) add("credit_given", "red", credit, `Crédito de ${eur(credit)} dado ao cliente (desconta ao que tinha de pagar).`);
  // A taxa extra (BookingFee) é cobrada em dinheiro pelo condutor e a Multipark não a regista como pagamento: entra no dinheiro esperado do dia.
  if (fees > 0) add("fee_cash", "amber", 0, `Taxa extra de ${eur(fees)} cobrada em dinheiro (não fica nos pagamentos da Multipark): conta no dinheiro que tem de haver.`);
  if (isCheckedOut(b.status) && !offCounter && final != null) {
    const due = final - credit;
    if (due - paid > 0) add("underpaid", "red", due - paid, `Devia ${eur(due)} (preço ${eur(final)}${credit ? ` − crédito ${eur(credit)}` : ""}), pagou ${eur(paid)}.`);
    else if (paid - due > 0) add("overpaid", "amber", 0, `Pagou ${eur(paid)}, devia ${eur(due)} (+${eur(paid - due)}).`);
  }

  // ── Online: Stripe ──
  const online = b.payments.filter((p) => payKind(p.method, partners) === "online");
  const onlineCents = online.reduce((s, p) => s + toCents(p.amount), 0);
  if (onlineCents !== 0) {
    if (!i.stripeAvailable) add("online_unverified", "amber", Math.abs(onlineCents), `${eur(onlineCents)} online: a verificação da Stripe não está disponível (o dia não fecha sem ela).`);
    else if (!b.intents.length) add("online_mismatch", "red", Math.abs(onlineCents), `${eur(onlineCents)} dados como online mas a Multipark não tem nenhum pagamento Stripe ligado à reserva.`);
    else {
      let received = 0; let unread = 0; const problems: string[] = [];
      for (const it of b.intents) {
        if (!i.stripe.has(it.id)) { unread++; continue; }
        const s = i.stripe.get(it.id);
        if (s === null) { problems.push(`${it.id} não existe na Stripe (404)`); continue; }
        if (!s || s.status !== "succeeded") { problems.push(`${it.id} está "${s?.status ?? "?"}"`); continue; }
        if (s.disputed) problems.push(`${it.id} tem disputa`);
        received += toCents(s.received) - toCents(s.refunded);
      }
      if (unread) add("online_unverified", "amber", Math.abs(onlineCents), `${unread} pagamento(s) Stripe ainda por ler (o dia não fecha até estarem lidos).`);
      else if (problems.length || received !== onlineCents) add("online_mismatch", "red", Math.abs(onlineCents - received),
        `Multipark ${eur(onlineCents)} online; Stripe recebeu ${eur(received)}${problems.length ? ` (${problems.join("; ")})` : ""}.`);
    }
  }

  // ── Validações da Multipark ──
  if (isCheckedOut(b.status) && !b.cashierClosed.done) add("mp_not_closed", "amber", 0, "Saiu mas a caixa ainda não foi fechada na Multipark.");
  if ((b.cashierClosed.done && (!b.cashValidated.done || !b.driverValidated.done)) || (b.driverValidated.done && !b.cashValidated.done)) {
    add("mp_order", "red", 0, `Fecho/validações fora de ordem: reserva ${yes(b.cashValidated.done)}, condutor ${yes(b.driverValidated.done)}, caixa ${yes(b.cashierClosed.done)}.`);
  }
  return out;
}

// ─── Justificações e resolução ──────────────────────────────────────────────

export const JUSTIFY_REASONS = [
  "desconto_autorizado", "cortesia_reclamacao", "erro_corrigido_multipark", "reembolso", "cliente_pro_avenca_parceiro",
  "pago_noutro_dia_ou_parque", "recalculo_multipark", "saida_antecipada", "talao_em_falta", "perda_aceite", "outro",
] as const;
export type JustifyReason = (typeof JUSTIFY_REASONS)[number];
export const JUSTIFY_REASON_LABEL: Record<JustifyReason, string> = {
  desconto_autorizado: "Desconto autorizado",
  cortesia_reclamacao: "Cortesia por reclamação",
  erro_corrigido_multipark: "Erro de registo (corrigido na Multipark)",
  reembolso: "Reembolso ao cliente",
  cliente_pro_avenca_parceiro: "Cliente PRO / avença / parceiro",
  pago_noutro_dia_ou_parque: "Pago noutro dia ou parque",
  recalculo_multipark: "Recálculo da Multipark (pagamento recriado)",
  saida_antecipada: "Saída antecipada",
  talao_em_falta: "Talão perdido / em falta",
  perda_aceite: "Perda aceite",
  outro: "Outro",
};
export const JUSTIFY_MIN_CHARS = 20;

export interface JustificationRef {
  id: number; findingKey: string; code: string; amountCents: number; reason: string; explanation: string; fileIds: number[];
  /** Decisão do Jorge (última): null = por decidir. */
  decision: "aprovado" | "recusado" | null;
}

/** Problema de uma justificação nova (texto do erro) ou null. PURA. */
export function justificationProblem(o: { finding: Pick<Finding, "code" | "color">; reason: string; explanation: string; fileCount: number }): string | null {
  if (!(JUSTIFY_REASONS as readonly string[]).includes(o.reason)) return "Escolhe um motivo da lista.";
  if (o.explanation.trim().length < JUSTIFY_MIN_CHARS) return `Explica o que aconteceu (pelo menos ${JUSTIFY_MIN_CHARS} carateres).`;
  if (o.finding.color === "red" && PROOF_REQUIRED.has(o.finding.code) && o.fileCount < 1) return "Este achado precisa de um comprovativo (foto ou PDF).";
  return null;
}

/**
 * A justificação ainda vale para o achado de agora? Só se for do mesmo código,
 * do MESMO valor e, quando o comprovativo é obrigatório, com pelo menos um
 * ficheiro ainda anexado (não retirado). PURA.
 */
export function justificationValid(f: Pick<Finding, "code" | "color" | "amountCents">, j: JustificationRef | null, activeFileIds: ReadonlySet<number>): boolean {
  if (!j) return false;
  if (j.code !== f.code || j.amountCents !== f.amountCents) return false;
  if (f.color === "red" && PROOF_REQUIRED.has(f.code) && !j.fileIds.some((id) => activeFileIds.has(id))) return false;
  return true;
}

/**
 * Cor efetiva de um achado: vermelho justificado → amarelo (à espera do Jorge);
 * aprovado pelo Jorge → verde; recusado → vermelho; justificação desatualizada
 * (valor mudou, comprovativo retirado) → como se não houvesse. PURA.
 */
export function resolvedColor(f: Pick<Finding, "code" | "color" | "amountCents">, j: JustificationRef | null, activeFileIds: ReadonlySet<number> = new Set()): Color {
  if (f.color === "green") return "green";
  if (!justificationValid(f, j, activeFileIds)) return f.color;
  if (j!.decision === "aprovado") return "green";
  if (j!.decision === "recusado") return "red";
  return "amber";
}

const RANK: Record<Color, number> = { green: 0, amber: 1, red: 2 };
export const worst = (cs: readonly Color[]): Color => cs.reduce<Color>((a, c) => (RANK[c] > RANK[a] ? c : a), "green");

export interface BookingView {
  id: string; code: string | null; parkName: string | null; status: string | null; checkOut: string | null; driver: string | null;
  inDay: InDay;
  originCents: number | null; originSource: "webhook" | "multipark_original" | null;
  originalCents: number | null; finalCents: number | null;
  paidByKind: Partial<Record<PayKind, number>>;
  /** Só os pagamentos registados no dia (o que conta para a gaveta). */
  dayPaidByKind: Partial<Record<PayKind, number>>;
  paidCents: number; creditCents: number; feesCents: number; dueCents: number | null;
  validations: { cashValidated: ConfirmValidation; driverValidated: ConfirmValidation; cashierClosed: ConfirmValidation };
  findings: Array<Finding & { resolved: Color; stale: boolean }>;
  /** Pior cor já tendo em conta as resoluções (verde se não houver nada). */
  color: Color;
}

/** Reserva → linha do ecrã (com a cor já resolvida pelas justificações). PURA. */
export function buildBookingView(o: {
  live: ConfirmBookingLive; origin: ConfirmOrigin | null; inDay: InDay; findings: readonly Finding[]; windowPaymentIds: ReadonlySet<string>;
  justifications: ReadonlyMap<string, JustificationRef>; activeFileIds: ReadonlySet<number>; partnerNames?: ReadonlySet<string>;
}): BookingView {
  const b = o.live;
  const paidByKind: Partial<Record<PayKind, number>> = {};
  const dayPaidByKind: Partial<Record<PayKind, number>> = {};
  let paid = 0;
  for (const p of b.payments) {
    const k = payKind(p.method, o.partnerNames);
    const c = toCents(p.amount);
    paidByKind[k] = (paidByKind[k] ?? 0) + c;
    if (o.windowPaymentIds.has(p.id)) dayPaidByKind[k] = (dayPaidByKind[k] ?? 0) + c;
    paid += c;
  }
  const final = b.bookingPrice == null ? null : toCents(b.bookingPrice);
  const credit = toCents(b.credit), fees = toCents(b.fees);
  const born = o.origin?.source === "webhook" && o.origin.bookingPrice != null ? toCents(o.origin.bookingPrice) : null;
  const original = b.originalBookingPrice != null && b.originalBookingPrice > 0 ? toCents(b.originalBookingPrice) : null;
  const findings = o.findings.map((f) => {
    const j = o.justifications.get(f.key) ?? null;
    return { ...f, resolved: resolvedColor(f, j, o.activeFileIds), stale: !!j && !justificationValid(f, j, o.activeFileIds) };
  });
  return {
    id: b.id, code: b.code, parkName: b.parkName, status: b.status, checkOut: b.checkOut, driver: b.checkOutDriverName,
    inDay: o.inDay,
    originCents: born ?? original, originSource: born != null ? "webhook" : original != null ? "multipark_original" : null,
    originalCents: original, finalCents: final,
    paidByKind, dayPaidByKind, paidCents: paid, creditCents: credit, feesCents: fees, dueCents: final == null ? null : final - credit,
    validations: { cashValidated: b.cashValidated, driverValidated: b.driverValidated, cashierClosed: b.cashierClosed },
    findings,
    color: worst(findings.map((f) => f.resolved)),
  };
}

// ─── O dia ──────────────────────────────────────────────────────────────────

export interface ShiftDeclaration { shift: "morning" | "night"; cash: number | null; mb: number | null; multiparkTotal: number | null; byName: string | null; byId: number | null }

export interface DaySummary {
  computedCashCents: number; computedMbCents: number; shiftExpensesCents: number; feesCents: number;
  /** Tem de haver em dinheiro = dinheiro registado no dia + taxas extra das saídas − despesas do turno. */
  expectedCashCents: number; expectedMbCents: number;
  declaredCashCents: number | null; declaredMbCents: number | null; declaredMultiparkTotalCents: number | null;
  confirmedCashCents: number | null; confirmedMbCents: number | null;
  /** Contado pelo João − esperado (null enquanto o João não contar). */
  cashDiffCents: number | null; mbDiffCents: number | null;
  /** Soma das duas (com sinal) e soma dos valores absolutos (é esta que decide o alerta: uma não esconde a outra). */
  differenceCents: number | null; absDifferenceCents: number | null;
  /** O que o team leader declarou (envelope = recebido − despesas) vs o que o João contou. */
  declaredVsCountedCashCents: number | null; declaredVsCountedMbCents: number | null;
  /** Total que dava a caixa da Multipark (team leader) vs o nosso (dinheiro + MB registados). */
  multiparkTotalGapCents: number | null;
  alert: DayAlert;
  /** Turnos sem o dinheiro OU sem o MB declarados (0 tem de ser escrito). */
  missingShifts: Array<"morning" | "night">;
}

/** Contas do dia (pagamentos da janela já filtrados aos parques operados). PURA. */
export function daySummary(o: {
  windowPayments: ReadonlyArray<{ amount: number | null; method: string | null }>;
  shiftExpenses: number;
  feesCents: number;
  shifts: readonly ShiftDeclaration[];
  confirmed: { cash: number | null; mb: number | null } | null;
  partnerNames?: ReadonlySet<string>;
}): DaySummary {
  let cash = 0, mb = 0;
  for (const p of o.windowPayments) {
    const k = payKind(p.method, o.partnerNames);
    if (k === "cash") cash += toCents(p.amount);
    else if (k === "card") mb += toCents(p.amount);
  }
  const exp = toCents(o.shiftExpenses);
  const expectedCash = cash + o.feesCents - exp;
  const missingShifts = (["morning", "night"] as const).filter((sh) => !o.shifts.some((s) => s.shift === sh && s.cash != null && s.mb != null));
  const all = missingShifts.length === 0;
  const sum = (f: (s: ShiftDeclaration) => number | null) => {
    const vals = o.shifts.map(f).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((s, v) => s + toCents(v), 0) : null;
  };
  const declaredCash = all ? sum((s) => s.cash) : null;
  const declaredMb = all ? sum((s) => s.mb) : null;
  const declaredTotal = sum((s) => s.multiparkTotal);
  const confirmedCash = o.confirmed?.cash == null ? null : toCents(o.confirmed.cash);
  const confirmedMb = o.confirmed?.mb == null ? null : toCents(o.confirmed.mb);
  const cashDiff = confirmedCash == null ? null : confirmedCash - expectedCash;
  const mbDiff = confirmedMb == null ? null : confirmedMb - mb;
  const both = cashDiff != null && mbDiff != null;
  const absDiff = both ? Math.abs(cashDiff!) + Math.abs(mbDiff!) : null;
  return {
    computedCashCents: cash, computedMbCents: mb, shiftExpensesCents: exp, feesCents: o.feesCents,
    expectedCashCents: expectedCash, expectedMbCents: mb,
    declaredCashCents: declaredCash, declaredMbCents: declaredMb, declaredMultiparkTotalCents: declaredTotal,
    confirmedCashCents: confirmedCash, confirmedMbCents: confirmedMb,
    cashDiffCents: cashDiff, mbDiffCents: mbDiff,
    differenceCents: both ? cashDiff! + mbDiff! : null, absDifferenceCents: absDiff,
    declaredVsCountedCashCents: confirmedCash == null || declaredCash == null ? null : confirmedCash - (declaredCash - exp),
    declaredVsCountedMbCents: confirmedMb == null || declaredMb == null ? null : confirmedMb - declaredMb,
    multiparkTotalGapCents: declaredTotal == null ? null : declaredTotal - (cash + mb),
    alert: dayAlertOf(absDiff),
    missingShifts,
  };
}

export type DayStatus = "aberto" | "fechado" | "a_aprovar" | "aprovado" | "reaberto";
export const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  aberto: "Por fechar", fechado: "Fechado", a_aprovar: "Fechado — à espera do Jorge", aprovado: "Aprovado pelo Jorge", reaberto: "Reaberto (a Multipark mudou)",
};

/** O que impede o João de fechar o dia (lista vazia = pode). PURA. */
export function closeBlockers(o: {
  dayClosedAt3am: boolean; truncated: boolean; multiparkOk: boolean;
  stripe: { available: boolean; unread: number };
  views: readonly BookingView[]; summary: DaySummary; noteLen: number;
  closerId: number | null; declarantIds: readonly number[];
}): string[] {
  const out: string[] = [];
  if (!o.dayClosedAt3am) out.push("A caixa deste dia ainda não fechou (só às 03:00 do dia seguinte).");
  if (!o.multiparkOk) out.push("A BD da Multipark não respondeu: não dá para fechar sem os dados completos.");
  if (o.truncated) out.push("Há mais reservas do que as lidas: não dá para fechar com dados cortados.");
  const hasOnline = o.views.some((v) => v.findings.some((f) => f.code === "online_unverified"));
  if (hasOnline && !o.stripe.available) out.push("A verificação da Stripe está desligada ou sem chave: liga-a (Definições → Automações) antes de fechar.");
  else if (hasOnline || o.stripe.unread > 0) out.push("Há pagamentos online ainda por ler na Stripe: atualiza daqui a pouco.");
  const unresolvedRed = o.views.reduce((s, v) => s + (v.color === "red" ? 1 : 0), 0);
  if (unresolvedRed) out.push(`${unresolvedRed} reserva(s) com vermelho por justificar.`);
  if (o.summary.missingShifts.length) out.push(`Falta o team leader declarar o dinheiro e o Multibanco ${o.summary.missingShifts.map((s) => (s === "morning" ? "do turno da manhã" : "do turno da noite")).join(" e ")} na Passagem de turno (0 também se escreve).`);
  if (o.summary.confirmedCashCents == null || o.summary.confirmedMbCents == null) out.push("Conta o envelope e os talões e grava os valores (dinheiro e Multibanco) antes de fechar.");
  const gap = Math.abs(o.summary.absDifferenceCents ?? 0) + Math.abs(o.summary.declaredVsCountedCashCents ?? 0) + Math.abs(o.summary.declaredVsCountedMbCents ?? 0);
  if (gap !== 0 && o.noteLen < JUSTIFY_MIN_CHARS) out.push(`Há diferenças no dia: explica na nota onde estão (pelo menos ${JUSTIFY_MIN_CHARS} carateres).`);
  if (o.closerId != null && o.declarantIds.includes(o.closerId)) out.push("Quem declarou a caixa na Passagem de turno não pode confirmar o mesmo dia.");
  return out;
}

/**
 * Estado depois de o João fechar: "à espera do Jorge" se houver vermelhos
 * justificados por decidir, diferença > 30 €, ou se o dia já foi reaberto antes
 * (a aprovação volta a ser precisa). PURA.
 */
export function statusAfterClose(o: { views: readonly BookingView[]; summary: DaySummary; reopenedBefore: boolean }): DayStatus {
  const pending = o.views.some((v) => v.findings.some((f) => f.color === "red" && f.resolved === "amber"));
  return pending || o.summary.alert !== "none" || o.reopenedBefore ? "a_aprovar" : "fechado";
}

// ─── Selo: o que fica fixo depois de fechar ─────────────────────────────────

/** JSON canónico (chaves ordenadas) — base dos hashes. PURA. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/**
 * O que se sela de cada reserva:
 *  - saída do dia: preço, original, crédito, taxa, estado, parque, saída e o
 *    ACUMULADO por método de TODOS os pagamentos (não os ids — a Multipark
 *    recria-os). As validações vão à parte (`validationFlags`);
 *  - só pagamento no dia / cancelada: só os pagamentos DESTE dia (pelo
 *    conteúdo) e o estado da cancelada — o resto da reserva confere-se no dia
 *    da saída (uma reserva pré-paga que sai daqui a 5 dias não reabre hoje). PURA.
 */
export function bookingSealState(b: ConfirmBookingLive, inDay: InDay, windowPaymentIds: ReadonlySet<string>, partnerNames?: ReadonlySet<string>): Record<string, unknown> {
  const acc = (list: readonly ConfirmPayment[]) => {
    const byMethod: Record<string, number> = {};
    for (const p of list) {
      const k = `${payKind(p.method, partnerNames)}|${norm(p.method)}`;
      byMethod[k] = (byMethod[k] ?? 0) + toCents(p.amount);
    }
    for (const k of Object.keys(byMethod)) if (byMethod[k] === 0) delete byMethod[k];
    return byMethod;
  };
  if (isCheckoutKind(inDay)) {
    return { id: b.id, kind: "checkout", status: b.status, price: toCents(b.bookingPrice), original: toCents(b.originalBookingPrice), credit: toCents(b.credit), fees: toCents(b.fees), paid: acc(b.payments), checkOut: b.checkOut, parkId: b.parkId };
  }
  const day = b.payments.filter((p) => windowPaymentIds.has(p.id));
  return { id: b.id, kind: inDay, ...(inDay === "cancelled" ? { status: b.status } : {}), dayPaid: acc(day), parkId: b.parkId };
}

/** As 3 validações da Multipark como "cvd" (1/0): reserva conferida, condutor, caixa fechada. PURA. */
export const validationFlags = (b: Pick<ConfirmBookingLive, "cashValidated" | "driverValidated" | "cashierClosed">): string =>
  `${b.cashValidated.done ? 1 : 0}${b.driverValidated.done ? 1 : 0}${b.cashierClosed.done ? 1 : 0}`;

/** A reserva tem dinheiro de balcão no dia? (decide se uma reserva que entra/sai de um dia selado conta.) PURA. */
export const hasCounterInDay = (b: ConfirmBookingLive, windowPaymentIds: ReadonlySet<string>, partnerNames?: ReadonlySet<string>) =>
  b.payments.some((p) => windowPaymentIds.has(p.id) && toCents(p.amount) !== 0 && (isCounterKind(payKind(p.method, partnerNames)) || payKind(p.method, partnerNames) === "unknown"));

/** Contas do dia que o selo fixa (as declarações, despesas e taxas também). PURA. */
export const summarySealState = (s: DaySummary) => ({
  computedCashCents: s.computedCashCents, computedMbCents: s.computedMbCents, shiftExpensesCents: s.shiftExpensesCents, feesCents: s.feesCents,
  declaredCashCents: s.declaredCashCents, declaredMbCents: s.declaredMbCents, declaredMultiparkTotalCents: s.declaredMultiparkTotalCents,
  confirmedCashCents: s.confirmedCashCents, confirmedMbCents: s.confirmedMbCents,
});
