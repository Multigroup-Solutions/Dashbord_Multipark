/**
 * Confirmação da caixa reserva a reserva (plano docs/plans/2026-10-13-confirmacao-caixa-plano.md,
 * decisões do Jorge de 13 out 2026). PURO — sem BD, usado pelo servidor e pelo ecrã.
 *
 * Por cidade e dia da caixa (03:00 → 03:00, decisão 30a), só os parques que operamos:
 *  - cada reserva lado a lado: preço quando nasceu (1.º webhook, nossa memória),
 *    original da Multipark, final e o que foi pago por método, crédito/taxa e as
 *    3 validações da Multipark;
 *  - achados: verde (só aparece), amarelo (a rever), vermelho (o João tem de
 *    "Justificar" com motivo e comprovativo). Para cima pode (mais tempo,
 *    extra, taxa); para baixo nunca sem justificação;
 *  - o dia: o team leader declara na passagem de turno o dinheiro e o MB que
 *    recebeu e o total que dava a caixa na Multipark; o João confirma no dia
 *    seguinte. Falta/sobra > 30 € → dia amarelo no mês para o Jorge aprovar
 *    (+ notificação na app); > 70 € → também email.
 *
 * Valores em cêntimos inteiros nas contas (arredondamento half-even antes de
 * somar) — nada de somar floats. Na dúvida nunca é verde (falha fechado).
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
export const fromCents = (c: number): number => c / 100;
/** Tem mais de 2 casas decimais (sub-cêntimo)? PURA. */
export const hasSubCent = (v: number | null | undefined): boolean => v != null && Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) > 1e-6;

export function eur(c: number | null | undefined): string {
  if (c == null) return "—";
  const sign = c < 0 ? "−" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)},${String(a % 100).padStart(2, "0")} €`;
}

// ─── Limiares do dia (Jorge, 13 out) ────────────────────────────────────────

/** Diferença do dia acima disto (em valor absoluto) → dia amarelo no mês + notificação na app. */
export const DAY_DIFF_AMBER_CENTS = 3000;
/** Acima disto → também email ao Jorge. */
export const DAY_DIFF_EMAIL_CENTS = 7000;

export type DayAlert = "none" | "amber" | "email";
/** Nível de alerta de uma diferença do dia (cêntimos, com sinal). PURA. */
export function dayAlertOf(diffCents: number | null): DayAlert {
  if (diffCents == null) return "none";
  const a = Math.abs(diffCents);
  if (a > DAY_DIFF_EMAIL_CENTS) return "email";
  if (a > DAY_DIFF_AMBER_CENTS) return "amber";
  return "none";
}

// ─── Métodos ────────────────────────────────────────────────────────────────

export type PayKind = "cash" | "card" | "online" | "transfer" | "off_counter" | "unknown";
export const PAY_KIND_LABEL: Record<PayKind, string> = {
  cash: "Dinheiro", card: "Multibanco", online: "Online (Stripe)", transfer: "Transferência", off_counter: "Fora do balcão", unknown: "Método desconhecido",
};

const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/**
 * Texto livre do método (Multipark) → tipo. Dicionário EXATO primeiro (valores
 * conhecidos), depois padrões estritos; o resto é `unknown` (achado vermelho).
 * MB WAY é online (passa pela Stripe), "Cartão de crédito" é cartão, "Crédito"
 * sozinho é fora do balcão. Nomes de parceiros (texto que não bate com nada)
 * ficam `unknown` a menos que venham em `partnerNames`. PURA.
 */
export function payKind(method: string | null | undefined, partnerNames: ReadonlySet<string> = new Set()): PayKind {
  const m = norm(method);
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

export interface ConfirmLine {
  id: string; description: string | null; category: string | null;
  total: number | null; amountPaid: number | null; extraServiceId: string | null;
}
export interface ConfirmPayment {
  id: string; pricingId: string | null; amount: number | null; method: string | null; recordedAt: string | null;
}

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
  /** Pagamentos online que a Multipark liga à reserva (links SETTLED, faturas, PI da reserva): id → valor dito. */
  intents: Array<{ id: string; expected: number | null }>;
  cancelled: boolean; refunded: number | null;
}

/** O que a nossa memória do webhook viu quando a reserva nasceu (BOOKING_CREATED, só acréscimo). */
export interface ConfirmOrigin {
  /** Fonte: 1.º webhook BOOKING_CREATED (independente) ou nada. */
  source: "webhook" | null;
  bookingPrice: number | null;
  originalBookingPrice: number | null;
  checkOut: string | null;
  receivedAt: string | null;
  /** Lido da BD da Multipark mais de 2 min depois de a reserva nascer: pode já não ser o preço da criação. */
  late: boolean;
}

/** Tempo máximo entre o nascimento da reserva e a nossa leitura para o retrato contar como "da criação". */
export const ORIGIN_LATE_MS = 120_000;

/** Resultado da Stripe para um PaymentIntent: null = a Stripe não o mostra (404); undefined = não lido. */
export interface StripeCheck { status: string | null; received: number | null; refunded: number | null; disputed: boolean }

export interface MbReceiptRef { id: number; amountCents: number; bookingId: string | null }

// ─── Achados ────────────────────────────────────────────────────────────────

export type Color = "green" | "amber" | "red";

export type FindingCode =
  | "price_down" | "price_up_unexplained" | "no_origin" | "origin_conflict" | "origin_late"
  | "underpaid" | "overpaid" | "credit_given" | "negative_payment" | "unknown_method" | "off_counter_method"
  | "ledger_mismatch" | "legacy_line" | "subcent"
  | "mb_no_receipt" | "online_unverified" | "online_mismatch" | "transfer_unproven"
  | "mp_not_closed" | "mp_order" | "cancelled_after_checkin" | "not_checked_out";

export const FINDING_LABEL: Record<FindingCode, string> = {
  price_down: "Preço baixou",
  price_up_unexplained: "Preço subiu sem causa visível",
  no_origin: "Sem preço de origem (reserva anterior à memória)",
  origin_conflict: "Preço original diferente do que vimos nascer",
  origin_late: "Webhook de criação lido tarde",
  underpaid: "Pago a menos",
  overpaid: "Pago a mais",
  credit_given: "Crédito dado",
  negative_payment: "Pagamento negativo",
  unknown_method: "Método de pagamento desconhecido",
  off_counter_method: "Método fora do balcão numa reserva normal",
  ledger_mismatch: "Pago na linha ≠ pagamentos registados",
  legacy_line: "Linha antiga sem registo de pagamentos",
  subcent: "Valor com mais de 2 casas decimais",
  mb_no_receipt: "Multibanco sem talão",
  online_unverified: "Online por verificar na Stripe",
  online_mismatch: "Online não bate com a Stripe",
  transfer_unproven: "Transferência sem comprovativo",
  mp_not_closed: "Caixa por fechar na Multipark",
  mp_order: "Validações da Multipark fora de ordem",
  cancelled_after_checkin: "Cancelada depois do check-in",
  not_checked_out: "Pagamento do dia numa reserva sem saída",
};

/** Achados que, para fechar o dia, precisam de comprovativo (ficheiro) na justificação. */
export const PROOF_REQUIRED: ReadonlySet<FindingCode> = new Set<FindingCode>([
  "price_down", "underpaid", "credit_given", "negative_payment", "off_counter_method", "transfer_unproven", "online_mismatch", "cancelled_after_checkin",
]);

export interface Finding {
  /** Chave estável: reserva + código (+ pagamento quando é por pagamento). */
  key: string;
  bookingId: string;
  code: FindingCode;
  color: Color;
  /** Valor em causa (cêntimos, positivo = dinheiro que pode faltar). */
  amountCents: number;
  detail: string;
}

export interface BookingView {
  id: string; code: string | null; parkName: string | null; status: string | null; checkOut: string | null; driver: string | null;
  inDay: "checkout" | "payment_only" | "cancelled";
  originCents: number | null; originSource: ConfirmOrigin["source"] | "multipark_original" | null;
  originalCents: number | null; finalCents: number | null;
  paidByKind: Partial<Record<PayKind, number>>;
  paidCents: number; creditCents: number; feesCents: number; dueCents: number | null;
  validations: { cashValidated: ConfirmValidation; driverValidated: ConfirmValidation; cashierClosed: ConfirmValidation };
  findings: Finding[];
  /** Pior cor já tendo em conta as resoluções (verde se não houver nada). */
  color: Color;
}

const OFF_COUNTER_DISCOUNT_LINES = new Set(["desconto pro", "desconto campanha"]);
const isCheckedOut = (s: string | null) => String(s ?? "").toUpperCase() === "CHECKED_OUT";
const isOffCounterBooking = (b: Pick<ConfirmBookingLive, "pro" | "clientPlanId" | "allowance" | "partnerId">) => b.pro || !!b.clientPlanId || b.allowance || !!b.partnerId;

/**
 * Achados de UMA reserva. `windowPaymentIds` = pagamentos desta reserva que caem
 * na janela do dia (os de balcão são os que o João confere hoje). PURA.
 */
export function bookingFindings(i: {
  live: ConfirmBookingLive;
  origin: ConfirmOrigin | null;
  windowPaymentIds: ReadonlySet<string>;
  inDay: BookingView["inDay"];
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
  const offCounter = isOffCounterBooking(b);
  // Chaves estáveis: a Multipark recria os ids de pagamentos e linhas a cada recálculo, por isso
  // um achado por pagamento/linha chama-se pelo conteúdo (método + valor + ordem entre iguais).
  const subOf = stableSubKeys(b);

  // Cancelada depois do check-in, com ou sem pagamentos (Universo C).
  if (i.inDay === "cancelled") {
    const paid = b.payments.reduce((s, p) => s + toCents(p.amount), 0);
    add("cancelled_after_checkin", "red", paid, `Teve check-in${b.checkingInAt ? ` (${b.checkingInAt.slice(0, 16).replace("T", " ")})` : ""} e está cancelada${paid ? `; tem ${eur(paid)} pagos` : ""}.`);
  }

  // ── Preço: origem e variação ──
  const final = b.bookingPrice == null ? null : toCents(b.bookingPrice);
  const original = b.originalBookingPrice != null && b.originalBookingPrice > 0 ? toCents(b.originalBookingPrice) : null;
  const born = i.origin?.source === "webhook" && i.origin.bookingPrice != null ? toCents(i.origin.bookingPrice) : null;
  const bornOriginal = i.origin?.source === "webhook" && i.origin.originalBookingPrice != null && i.origin.originalBookingPrice > 0 ? toCents(i.origin.originalBookingPrice) : null;
  // Base: só origens independentes; o original da Multipark só quando não há memória.
  const base = born != null ? Math.max(born, bornOriginal ?? born) : original;
  if (born == null) {
    if (original == null) add("no_origin", "amber", 0, "Sem webhook de criação nem preço original na Multipark: não há com que comparar o preço.");
    else add("no_origin", "amber", 0, `Sem webhook de criação (reserva anterior à memória ou webhook em falta): compara-se com o preço original da Multipark (${eur(original)}), que se pode alterar.`);
  } else if (original != null && original !== (bornOriginal ?? born)) {
    add("origin_conflict", original < (bornOriginal ?? born) ? "red" : "amber", Math.max(0, (bornOriginal ?? born) - original),
      `Quando nasceu era ${eur(bornOriginal ?? born)} (webhook); o preço original na Multipark diz ${eur(original)}.`);
  }
  if (born != null && i.origin?.late) add("origin_late", "amber", 0, `O webhook de criação foi lido mais de ${ORIGIN_LATE_MS / 60_000} min depois de a reserva nascer${i.origin.receivedAt ? ` (${i.origin.receivedAt.slice(0, 16).replace("T", " ")} UTC)` : ""}: o preço de origem pode já ter mudado.`);
  if (base != null && final != null) {
    if (final < base) {
      // Só as linhas "Desconto PRO" (reserva PRO) e "Desconto campanha" (reserva com campanha) explicam uma descida,
      // e só até ao valor delas. Tudo o resto é vermelho.
      const covered = b.lines.reduce((s, l) => {
        const d = norm(l.description);
        const ok = (d === "desconto pro" && b.pro) || (d === "desconto campanha" && !!b.campaignId);
        return ok && OFF_COUNTER_DISCOUNT_LINES.has(d) ? s + Math.abs(toCents(l.total)) : s;
      }, 0);
      const down = base - final;
      const unexplained = down - Math.min(down, covered);
      if (unexplained > 0) {
        add("price_down", "red", unexplained,
          `Era ${eur(base)}${born != null ? " quando nasceu (webhook)" : " (preço original)"}, agora é ${eur(final)}: desceu ${eur(down)}${covered ? ` (${eur(Math.min(down, covered))} explicados por desconto PRO/campanha)` : ""}.`);
      }
    } else if (final > base) {
      const later = i.origin?.checkOut && b.checkOut && Date.parse(b.checkOut) - Date.parse(i.origin.checkOut) > 15 * 60_000;
      const explaining = b.lines.some((l) => {
        const c = String(l.category ?? "").toUpperCase();
        return (c === "SERVICE" && !!l.extraServiceId) || c === "FEE";
      });
      if (!later && !explaining) add("price_up_unexplained", "amber", 0, `Era ${eur(base)}, agora é ${eur(final)} (+${eur(final - base)}) sem mais dias, extra ou taxa nas linhas.`);
    }
  }

  // ── Pagamentos ──
  const paidByLine = new Map<string, number>();
  let paid = 0;
  for (const p of b.payments) {
    const c = toCents(p.amount);
    paid += c;
    if (p.pricingId) paidByLine.set(p.pricingId, (paidByLine.get(p.pricingId) ?? 0) + c);
    if (hasSubCent(p.amount)) add("subcent", "amber", 0, `Pagamento de ${p.amount} € com mais de 2 casas decimais.`, subOf.payment.get(p.id));
    if (c < 0) add("negative_payment", "red", -c, `Pagamento negativo de ${eur(c)} (${p.method ?? "sem método"}).`, subOf.payment.get(p.id));
    const k = payKind(p.method, partners);
    if (k === "unknown") add("unknown_method", "red", Math.abs(c), `Método "${p.method ?? "vazio"}" não reconhecido (${eur(c)}).`, subOf.payment.get(p.id));
    if (k === "off_counter" && !offCounter) add("off_counter_method", "red", Math.abs(c), `${eur(c)} registados como "${p.method}" numa reserva que não é PRO, avença nem parceiro.`, subOf.payment.get(p.id));
    if (k === "transfer") add("transfer_unproven", "red", Math.abs(c), `${eur(c)} por transferência: precisa do comprovativo do banco.`, subOf.payment.get(p.id));
  }
  for (const l of b.lines) {
    const lp = toCents(l.amountPaid);
    const reg = paidByLine.get(l.id);
    if (reg == null) { if (lp !== 0) add("legacy_line", "amber", 0, `Linha "${l.description ?? "?"}" diz ${eur(lp)} pagos mas não tem pagamentos registados.`, subOf.line.get(l.id)); }
    else if (reg !== lp) add("ledger_mismatch", "red", Math.abs(reg - lp), `Linha "${l.description ?? "?"}": pago na linha ${eur(lp)}, pagamentos registados ${eur(reg)}.`, subOf.line.get(l.id));
  }
  const credit = toCents(b.credit);
  const fees = toCents(b.fees);
  if (credit > 0) add("credit_given", "red", credit, `Crédito de ${eur(credit)} dado ao cliente.`);
  if (isCheckedOut(b.status) && !offCounter && final != null) {
    const due = final - credit + fees;
    if (due - paid > 0) add("underpaid", "red", due - paid, `Devia ${eur(due)} (preço ${eur(final)}${credit ? ` − crédito ${eur(credit)}` : ""}${fees ? ` + taxa ${eur(fees)}` : ""}), pagou ${eur(paid)}.`);
    else if (paid - due > 0) add("overpaid", "amber", 0, `Pagou ${eur(paid)}, devia ${eur(due)} (+${eur(paid - due)}).`);
  }

  // ── Multibanco: talão por pagamento do dia ──
  const cards = b.payments.filter((p) => i.windowPaymentIds.has(p.id) && payKind(p.method, partners) === "card" && toCents(p.amount) > 0);
  const receipts = i.mbReceipts.filter((r) => r.bookingId === b.id).map((r) => r.amountCents).sort((x, y) => x - y);
  const used = new Set<number>();
  for (const p of cards) {
    const c = toCents(p.amount);
    const idx = receipts.findIndex((r, j) => !used.has(j) && r === c);
    if (idx >= 0) used.add(idx);
    else add("mb_no_receipt", "red", c, `Pagamento MB de ${eur(c)} sem talão com o mesmo valor.`, subOf.payment.get(p.id));
  }

  // ── Online: Stripe ──
  const online = b.payments.filter((p) => payKind(p.method, partners) === "online");
  const onlineCents = online.reduce((s, p) => s + toCents(p.amount), 0);
  if (onlineCents !== 0) {
    if (!i.stripeAvailable) add("online_unverified", "red", Math.abs(onlineCents), `${eur(onlineCents)} online: a verificação da Stripe não está disponível.`);
    else if (!b.intents.length) add("online_mismatch", "red", Math.abs(onlineCents), `${eur(onlineCents)} dados como online mas a Multipark não tem nenhum pagamento Stripe ligado à reserva.`);
    else {
      let received = 0; let unreadable = 0; const problems: string[] = [];
      for (const it of b.intents) {
        const s = i.stripe.get(it.id);
        if (s === undefined || s === null) { unreadable++; continue; }
        if (s.status !== "succeeded") { problems.push(`${it.id} está "${s.status ?? "?"}"`); continue; }
        if (s.disputed) problems.push(`${it.id} tem disputa`);
        received += toCents(s.received) - toCents(s.refunded);
      }
      if (unreadable) add("online_unverified", "red", Math.abs(onlineCents), `${unreadable} pagamento(s) Stripe não se conseguiram ler (404 ou sem resposta): não verificável.`);
      else if (problems.length || received !== onlineCents) add("online_mismatch", "red", Math.abs(onlineCents - received),
        `Multipark ${eur(onlineCents)} online; Stripe recebeu ${eur(received)}${problems.length ? ` (${problems.join("; ")})` : ""}.`);
    }
  }

  // ── Validações da Multipark ──
  if (isCheckedOut(b.status) && !b.cashierClosed.done) add("mp_not_closed", "amber", 0, "Saiu mas a caixa ainda não foi fechada na Multipark.");
  if ((b.cashierClosed.done && (!b.cashValidated.done || !b.driverValidated.done)) || (b.driverValidated.done && !b.cashValidated.done)) {
    add("mp_order", "red", 0, `Fecho/validações fora de ordem: reserva ${yes(b.cashValidated.done)}, condutor ${yes(b.driverValidated.done)}, caixa ${yes(b.cashierClosed.done)}.`);
  }
  if (i.inDay === "payment_only") {
    const dayCounter = b.payments.filter((p) => i.windowPaymentIds.has(p.id) && isCounterKind(payKind(p.method, partners)));
    if (dayCounter.length) add("not_checked_out", "amber", 0, `Recebidos no dia ${eur(dayCounter.reduce((s, p) => s + toCents(p.amount), 0))} ao balcão numa reserva que não saiu hoje (estado ${b.status ?? "?"}).`);
  }
  return out;
}
const yes = (v: boolean) => (v ? "sim" : "não");

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

// ─── Justificações e resolução ──────────────────────────────────────────────

export const JUSTIFY_REASONS = [
  "desconto_autorizado", "cortesia_reclamacao", "erro_corrigido_multipark", "reembolso", "cliente_pro_avenca_parceiro",
  "pago_noutro_dia_ou_parque", "talao_em_falta", "perda_aceite", "outro",
] as const;
export type JustifyReason = (typeof JUSTIFY_REASONS)[number];
export const JUSTIFY_REASON_LABEL: Record<JustifyReason, string> = {
  desconto_autorizado: "Desconto autorizado",
  cortesia_reclamacao: "Cortesia por reclamação",
  erro_corrigido_multipark: "Erro de registo (corrigido na Multipark)",
  reembolso: "Reembolso ao cliente",
  cliente_pro_avenca_parceiro: "Cliente PRO / avença / parceiro",
  pago_noutro_dia_ou_parque: "Pago noutro dia ou parque",
  talao_em_falta: "Talão perdido / em falta",
  perda_aceite: "Perda aceite",
  outro: "Outro",
};
export const JUSTIFY_MIN_CHARS = 20;

export interface JustificationRef {
  id: number; findingKey: string; reason: string; explanation: string; fileCount: number;
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
 * Cor efetiva de um achado depois das justificações: vermelho justificado →
 * amarelo (à espera do Jorge); aprovado pelo Jorge → verde; recusado → vermelho.
 * Amarelo justificado e aprovado → verde. PURA.
 */
export function resolvedColor(f: Pick<Finding, "color">, j: JustificationRef | null): Color {
  if (f.color === "green") return "green";
  if (!j) return f.color;
  if (j.decision === "aprovado") return "green";
  if (j.decision === "recusado") return "red";
  return "amber";
}

const RANK: Record<Color, number> = { green: 0, amber: 1, red: 2 };
export const worst = (cs: readonly Color[]): Color => cs.reduce<Color>((a, c) => (RANK[c] > RANK[a] ? c : a), "green");

/** Reserva → linha do ecrã (com a cor já resolvida pelas justificações). PURA. */
export function buildBookingView(o: {
  live: ConfirmBookingLive; origin: ConfirmOrigin | null; inDay: BookingView["inDay"]; findings: readonly Finding[];
  justifications: ReadonlyMap<string, JustificationRef>; partnerNames?: ReadonlySet<string>;
}): BookingView {
  const b = o.live;
  const paidByKind: Partial<Record<PayKind, number>> = {};
  let paid = 0;
  for (const p of b.payments) {
    const k = payKind(p.method, o.partnerNames);
    const c = toCents(p.amount);
    paidByKind[k] = (paidByKind[k] ?? 0) + c;
    paid += c;
  }
  const final = b.bookingPrice == null ? null : toCents(b.bookingPrice);
  const credit = toCents(b.credit), fees = toCents(b.fees);
  const born = o.origin?.source === "webhook" && o.origin.bookingPrice != null ? toCents(o.origin.bookingPrice) : null;
  const original = b.originalBookingPrice != null && b.originalBookingPrice > 0 ? toCents(b.originalBookingPrice) : null;
  return {
    id: b.id, code: b.code, parkName: b.parkName, status: b.status, checkOut: b.checkOut, driver: b.checkOutDriverName,
    inDay: o.inDay,
    originCents: born ?? original, originSource: born != null ? "webhook" : original != null ? "multipark_original" : null,
    originalCents: original, finalCents: final,
    paidByKind, paidCents: paid, creditCents: credit, feesCents: fees, dueCents: final == null ? null : final - credit + fees,
    validations: { cashValidated: b.cashValidated, driverValidated: b.driverValidated, cashierClosed: b.cashierClosed },
    findings: [...o.findings],
    color: worst(o.findings.map((f) => resolvedColor(f, o.justifications.get(f.key) ?? null))),
  };
}

// ─── O dia ──────────────────────────────────────────────────────────────────

export interface ShiftDeclaration { shift: "morning" | "night"; cash: number | null; mb: number | null; multiparkTotal: number | null; byName: string | null }

export interface DaySummary {
  computedCashCents: number; computedMbCents: number; shiftExpensesCents: number;
  expectedCashCents: number; expectedMbCents: number;
  declaredCashCents: number | null; declaredMbCents: number | null; declaredMultiparkTotalCents: number | null;
  confirmedCashCents: number | null; confirmedMbCents: number | null;
  /** O que há (confirmado pelo João, senão o declarado pelo team leader) − o esperado. null = nada declarado. */
  differenceCents: number | null;
  /** Total que a caixa da Multipark dava (team leader) vs o nosso (dinheiro + MB). */
  multiparkTotalGapCents: number | null;
  alert: DayAlert;
  missingShifts: Array<"morning" | "night">;
}

/** Contas do dia. Os pagamentos da janela já vêm filtrados aos parques operados. PURA. */
export function daySummary(o: {
  windowPayments: ReadonlyArray<{ amount: number | null; method: string | null }>;
  shiftExpenses: number;
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
  const expectedCash = cash - exp;
  const sum = (f: (s: ShiftDeclaration) => number | null) => {
    const vals = o.shifts.map(f).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((s, v) => s + toCents(v), 0) : null;
  };
  const declaredCash = sum((s) => s.cash);
  const declaredMb = sum((s) => s.mb);
  const declaredTotal = sum((s) => s.multiparkTotal);
  const confirmedCash = o.confirmed?.cash == null ? null : toCents(o.confirmed.cash);
  const confirmedMb = o.confirmed?.mb == null ? null : toCents(o.confirmed.mb);
  // Dinheiro que há: o João conta o envelope (já sem as despesas); senão o team leader declarou o recebido (antes das despesas).
  const haveCash = confirmedCash ?? (declaredCash == null ? null : declaredCash - exp);
  const haveMb = confirmedMb ?? declaredMb;
  const difference = haveCash == null && haveMb == null ? null : ((haveCash ?? expectedCash) - expectedCash) + ((haveMb ?? mb) - mb);
  const missingShifts = (["morning", "night"] as const).filter((sh) => !o.shifts.some((s) => s.shift === sh && (s.cash != null || s.mb != null)));
  return {
    computedCashCents: cash, computedMbCents: mb, shiftExpensesCents: exp, expectedCashCents: expectedCash, expectedMbCents: mb,
    declaredCashCents: declaredCash, declaredMbCents: declaredMb, declaredMultiparkTotalCents: declaredTotal,
    confirmedCashCents: confirmedCash, confirmedMbCents: confirmedMb,
    differenceCents: difference,
    multiparkTotalGapCents: declaredTotal == null ? null : declaredTotal - (cash + mb),
    alert: dayAlertOf(difference),
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
  views: readonly BookingView[]; summary: DaySummary; noteLen: number;
}): string[] {
  const out: string[] = [];
  if (!o.dayClosedAt3am) out.push("A caixa deste dia ainda não fechou (só às 03:00 do dia seguinte).");
  if (!o.multiparkOk) out.push("A BD da Multipark não respondeu: não dá para fechar sem os dados completos.");
  if (o.truncated) out.push("Há mais reservas do que as lidas: não dá para fechar com dados cortados.");
  const unresolvedRed = o.views.reduce((s, v) => s + (v.color === "red" ? 1 : 0), 0);
  if (unresolvedRed) out.push(`${unresolvedRed} reserva(s) com vermelho por justificar.`);
  if (o.summary.missingShifts.length) out.push(`Falta o team leader declarar ${o.summary.missingShifts.map((s) => (s === "morning" ? "o turno da manhã" : "o turno da noite")).join(" e ")} na Passagem de turno.`);
  if (o.summary.differenceCents != null && o.summary.differenceCents !== 0 && o.noteLen < JUSTIFY_MIN_CHARS) out.push(`Há diferença de ${eur(o.summary.differenceCents)} no dia: explica onde está (pelo menos ${JUSTIFY_MIN_CHARS} carateres).`);
  return out;
}

/** Estado depois de o João fechar: amarelo (à espera do Jorge) se houver justificações por aprovar ou diferença > 30 €. PURA. */
export function statusAfterClose(o: { views: readonly BookingView[]; summary: DaySummary }): DayStatus {
  const pending = o.views.some((v) => v.color === "amber" && v.findings.some((f) => f.color === "red"));
  return pending || o.summary.alert !== "none" ? "a_aprovar" : "fechado";
}

// ─── Impressão digital da reserva (para detetar mudanças depois de fechado) ─

/** JSON canónico (chaves ordenadas) — base dos hashes. PURA. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/**
 * Estado de dinheiro da reserva que o fecho do dia sela: preço, original,
 * crédito, taxa, estado, parque, saída e o ACUMULADO por (método) dos
 * pagamentos — não os ids (a Multipark recria-os em cada recálculo). As 3
 * validações vão à parte (`validationFlags`): passar a "sim" depois do fecho é
 * normal; voltar a "não" reabre o dia. PURA.
 */
export function bookingMoneyState(b: ConfirmBookingLive, partnerNames?: ReadonlySet<string>): Record<string, unknown> {
  const byMethod: Record<string, number> = {};
  for (const p of b.payments) {
    const k = `${payKind(p.method, partnerNames)}|${norm(p.method)}`;
    byMethod[k] = (byMethod[k] ?? 0) + toCents(p.amount);
  }
  for (const k of Object.keys(byMethod)) if (byMethod[k] === 0) delete byMethod[k];
  return {
    id: b.id, status: b.status, price: toCents(b.bookingPrice), original: toCents(b.originalBookingPrice), credit: toCents(b.credit), fees: toCents(b.fees),
    paid: byMethod, checkOut: b.checkOut, parkId: b.parkId,
  };
}

/** As 3 validações da Multipark como "cvd" (1/0): reserva conferida, condutor, caixa fechada. PURA. */
export const validationFlags = (b: Pick<ConfirmBookingLive, "cashValidated" | "driverValidated" | "cashierClosed">): string =>
  `${b.cashValidated.done ? 1 : 0}${b.driverValidated.done ? 1 : 0}${b.cashierClosed.done ? 1 : 0}`;
