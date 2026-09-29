/**
 * Caixa, fase 2 (detetar) — regras da varredura (PURAS, sem BD).
 *
 * "Era" = a memória do webhook + os retratos que a própria varredura guarda
 * (`cash_live_snapshots`, só acréscimo) — assim uma alteração feita SEM
 * webhook também fica com o "antes". "É" = a Multipark ao vivo.
 *
 * R1–R6 e R8 vêm de compareBooking (rules.ts, a conferência a pedido); aqui
 * juntam-se as regras novas de docs/auditoria/caixa-furos.md §3:
 *   R12 desconto/campanha tardios · R13 cancelado/reembolso · R14 mudou de dia
 *   ou parque depois do fecho · R16 pro/avença tardio · R17 parceiro ·
 *   R18 extra feito sem cobrança · R19 fatura · R20 pagamento online ·
 *   R21 crédito · R22 caixa reaberta · R23 dinheiro do condutor por entregar ·
 *   R28 métodos divididos (informativa).
 * R15 (desaparecida), R26 (permissões) e R27 (webhook por parque) são
 * avaliadas pela varredura (server/cashSweep.ts) com as funções daqui.
 * R9/R25 (quem mudou) leem a "History" — só no detalhe do caso (fase 3).
 */
import { createHash } from "node:crypto";
import type { MemorySnapshot } from "../webhookMemory";
import type { SweepExtras } from "../multiparkDb/cashSweep";
import { compareBooking, eurText, IN_OR_AFTER_CHECKIN, MONEY_TOLERANCE, paidAmount, sortMemory, type LiveFinance } from "./rules";

export type SweepSeverity = "critical" | "high" | "medium" | "info";

export type SweepCode =
  | "only_live" | "only_memory" | "price_zeroed" | "price_after_checkin" | "price_after_creation" | "lines_below"
  | "method_changed" | "paid_mismatch" | "cancelled_after_checkin" | "cashier_closed_with_divergence"
  | "discount_late" | "refund_issue" | "moved_after_close" | "missing" | "pro_late" | "partner_changed"
  | "extra_uncharged" | "invoice_missing" | "invoice_mismatch" | "online_payment" | "credit_used"
  | "cash_reopened" | "driver_cash_pending" | "split_methods" | "agent_perms_changed" | "park_webhook_silent";

export interface Finding { code: SweepCode; severity: SweepSeverity; label: string; detail: string; rule: string }

export const SWEEP_LABELS: Record<SweepCode, { label: string; rule: string; severity: SweepSeverity }> = {
  only_live: { label: "Só na Multipark (nunca chegou webhook)", rule: "R7", severity: "medium" },
  only_memory: { label: "Só na memória do webhook", rule: "R7", severity: "medium" },
  price_zeroed: { label: "Preço zerado", rule: "R3", severity: "high" },
  price_after_checkin: { label: "Preço mudou depois do check-in", rule: "R2", severity: "high" },
  price_after_creation: { label: "Preço mudou depois da criação", rule: "R1", severity: "medium" },
  lines_below: { label: "Linhas de preço retiradas ou baixadas", rule: "R4", severity: "high" },
  method_changed: { label: "Método de pagamento mudou", rule: "R5", severity: "high" },
  paid_mismatch: { label: "Pago ≠ esperado", rule: "R6", severity: "high" },
  cancelled_after_checkin: { label: "Cancelada depois de entrar", rule: "R13", severity: "high" },
  cashier_closed_with_divergence: { label: "Caixa fechada com divergência", rule: "R8", severity: "critical" },
  discount_late: { label: "Desconto ou campanha depois do check-in", rule: "R12", severity: "high" },
  refund_issue: { label: "Reembolso por explicar", rule: "R13", severity: "high" },
  moved_after_close: { label: "Mudou de dia ou de parque depois do fecho", rule: "R14", severity: "medium" },
  missing: { label: "Reserva desaparecida da Multipark", rule: "R15", severity: "high" },
  pro_late: { label: "Pro ou avença marcado depois do check-in", rule: "R16", severity: "medium" },
  partner_changed: { label: "Valores do parceiro mudaram", rule: "R17", severity: "high" },
  extra_uncharged: { label: "Serviço feito sem cobrança", rule: "R18", severity: "medium" },
  invoice_missing: { label: "Paga e entregue sem fatura", rule: "R19", severity: "medium" },
  invoice_mismatch: { label: "Fatura ≠ pago", rule: "R19", severity: "medium" },
  online_payment: { label: "Pagamento online com problema", rule: "R20", severity: "high" },
  credit_used: { label: "Crédito usado (pede justificação)", rule: "R21", severity: "medium" },
  cash_reopened: { label: "Caixa ou validação reaberta", rule: "R22", severity: "critical" },
  driver_cash_pending: { label: "Dinheiro do condutor por entregar", rule: "R23", severity: "high" },
  split_methods: { label: "Pagamento dividido por vários métodos", rule: "R28", severity: "info" },
  agent_perms_changed: { label: "Permissões de dinheiro de um agente mudaram", rule: "R26", severity: "medium" },
  park_webhook_silent: { label: "Parque sem webhooks com movimento na Multipark", rule: "R27", severity: "medium" },
};

export const SEVERITY_ORDER: Record<SweepSeverity, number> = { critical: 4, high: 3, medium: 2, info: 1 };

/** Parâmetros (decisões do dono — valores por omissão, docs/auditoria/caixa-furos.md §8). */
export interface SweepParams { driverCashHours: number; invoiceHours: number }
export const DEFAULT_SWEEP_PARAMS: SweepParams = { driverCashHours: 12, invoiceHours: 48 };

function finding(code: SweepCode, detail: string): Finding {
  const l = SWEEP_LABELS[code];
  return { code, severity: l.severity, label: l.label, rule: l.rule, detail };
}

/** Retrato da varredura (o que guardamos): o dinheiro + os campos que as regras novas comparam. */
export interface SweepSnap extends MemorySnapshot {
  clientPlanId?: string | null;
  allowance?: string | null;
  creditId?: string | null;
  cashierClosedAt?: string | null;
  cashValidatedAt?: string | null;
}

/** LiveFinance (+ extras) → retrato no formato da memória. PURA. */
export function snapFromLive(live: LiveFinance, extras: SweepExtras | null, capturedAt: string, id = 0): SweepSnap {
  return {
    id, deliveryId: `sweep:${live.id}:${capturedAt}`, bookingId: live.id, eventType: "SWEEP", receivedAt: capturedAt,
    sourceUpdatedAt: live.updatedAt, parkId: live.parkId, status: live.status, checkIn: live.checkIn, checkOut: live.checkOut,
    bookingPrice: live.bookingPrice, originalBookingPrice: live.originalBookingPrice, parkingPrice: live.parkingPrice,
    deliveryPrice: live.deliveryPrice, discountAmount: live.discountAmount, discountApplied: live.discountApplied,
    paidAmount: live.linesPaid, paymentMethod: live.paymentMethod, paymentSource: live.paymentSource, paymentBy: live.paymentBy,
    campaignId: live.campaignId, partnerId: live.partnerId, partnerAmountDue: live.partnerAmountDue, partnerAmountPaid: live.partnerAmountPaid,
    partnerContributedAmount: live.partnerContributedAmount, pro: live.pro, proClientId: live.proClientId,
    cashierClosed: live.cashierClosed.done, cashValidated: live.cashValidated.done, driverValidated: live.driverValidated.done,
    source: "sweep", dbReadAt: capturedAt, linesCount: live.linesCount, linesTotal: live.linesTotal, linesPaid: live.linesPaid,
    paymentsCount: live.paymentsCount, paymentsTotal: live.paymentsTotal, paymentMethods: live.paymentMethods,
    clientPlanId: extras?.clientPlanId ?? null, allowance: extras?.allowance ?? null, creditId: extras?.creditId ?? null,
    cashierClosedAt: live.cashierClosed.at, cashValidatedAt: live.cashValidated.at,
  };
}

/** Impressão digital do estado (só grava um retrato novo quando muda). PURA. */
export function stateHash(live: LiveFinance, extras: SweepExtras | null): string {
  const key = {
    s: live.status, pk: live.parkId, ci: live.checkIn, co: live.checkOut, bp: live.bookingPrice, ob: live.originalBookingPrice,
    pp: live.parkingPrice, dp: live.deliveryPrice, da: live.discountAmount, dap: live.discountApplied, pm: live.paymentMethod,
    ps: live.paymentSource, pb: live.paymentBy, ca: live.campaignId, pa: live.partnerId, pad: live.partnerAmountDue,
    pap: live.partnerAmountPaid, pc: live.partnerContributedAmount, pro: live.pro, pcl: live.proClientId,
    ln: live.linesCount, lt: live.linesTotal, lp: live.linesPaid, yn: live.paymentsCount, yt: live.paymentsTotal, ym: live.paymentMethods,
    cc: [live.cashierClosed.done, live.cashierClosed.at], cv: [live.cashValidated.done, live.cashValidated.at], dv: [live.driverValidated.done, live.driverValidated.at],
    x: extras ? [extras.clientPlanId, extras.allowance, extras.creditId, extras.disputed, extras.cancellation, extras.billing, extras.credit, extras.paymentLinks, extras.extras, extras.cash] : null,
  };
  return createHash("sha1").update(JSON.stringify(key)).digest("hex");
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`) : NaN);
const lisbonDay = (iso: string | null | undefined) => {
  const t = ms(iso);
  return Number.isFinite(t) ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(t)) : null;
};
const neq = (a: unknown, b: unknown) => (a ?? null) !== (b ?? null) && String(a ?? "").trim().toLowerCase() !== String(b ?? "").trim().toLowerCase();
const moneyNeq = (a: number | null | undefined, b: number | null | undefined) => Math.abs((a ?? 0) - (b ?? 0)) > MONEY_TOLERANCE;

/**
 * Todas as regras de uma reserva: R1–R8 (compareBooking, com a "era" =
 * webhook + retratos da varredura) e as novas. `era` pode trazer os dois
 * tipos de retrato misturados; ordena-se pela hora. PURA.
 */
export function evaluateSweep(o: {
  live: LiveFinance; extras: SweepExtras | null; era: readonly SweepSnap[]; nowIso: string; params?: SweepParams;
}): Finding[] {
  const params = o.params ?? DEFAULT_SWEEP_PARAMS;
  const { live, extras } = o;
  const era = sortMemory(o.era) as SweepSnap[];
  // "Só na Multipark" não serve à varredura: ela própria guarda o "era" (retrato).
  const out: Finding[] = compareBooking(era, live).filter((d) => d.code !== "only_live")
    .map((d) => ({ ...finding(d.code as SweepCode, d.detail), severity: d.severity as SweepSeverity }));
  const has = (c: SweepCode) => out.some((f) => f.code === c);
  const checkin = era.find((x) => x.status != null && IN_OR_AFTER_CHECKIN.has(x.status)) ?? null;
  const first = era[0] ?? null;
  const now = ms(o.nowIso);

  // R12 — desconto ou campanha depois do check-in.
  if (checkin && (moneyNeq(checkin.discountAmount, live.discountAmount) || neq(checkin.campaignId, live.campaignId) || (checkin.discountApplied != null && live.discountApplied != null && checkin.discountApplied !== live.discountApplied))) {
    out.push(finding("discount_late", `No check-in: desconto ${eurText(checkin.discountAmount)}, campanha ${checkin.campaignId ?? "—"}. Agora: desconto ${eurText(live.discountAmount)}, campanha ${live.campaignId ?? "—"}.`));
  }

  // R13 — cancelada com pagamentos, ou reembolso estranho.
  const paid = paidAmount(live) ?? 0;
  if (live.status === "CANCELLED" && extras?.cancellation) {
    const c = extras.cancellation;
    const problems: string[] = [];
    if (!has("cancelled_after_checkin") && paid > MONEY_TOLERANCE && !c.refunded) problems.push(`cancelada com ${eurText(paid)} pagos e sem reembolso registado`);
    if (c.refundedAmount != null && c.refundedAmount > paid + MONEY_TOLERANCE) problems.push(`reembolso de ${eurText(c.refundedAmount)} acima do pago (${eurText(paid)})`);
    if (c.refunded && !c.hasTransaction && /online|stripe|card|cart[aã]o|mbway/i.test(`${live.paymentMethod ?? ""} ${live.paymentMethods.join(" ")}`)) problems.push("reembolso dado como feito, sem id da transação, num pagamento online");
    if (problems.length) out.push(finding("refund_issue", `${problems.join("; ")}.`));
  }

  // R14 — mudou de dia ou de parque depois de a caixa fechar.
  const closedSnap = era.find((x) => x.cashierClosed === true) ?? null;
  if (closedSnap) {
    const dayThen = lisbonDay(closedSnap.checkOut), dayNow = lisbonDay(live.checkOut);
    const parkMoved = neq(closedSnap.parkId, live.parkId);
    if ((dayThen && dayNow && dayThen !== dayNow) || parkMoved) {
      out.push(finding("moved_after_close", `Com a caixa fechada a saída era ${dayThen ?? "—"}${parkMoved ? ` no parque ${closedSnap.parkId}` : ""}; agora é ${dayNow ?? "—"}${parkMoved ? ` no parque ${live.parkId}` : ""}.`));
    }
  }

  // R16 — pro ou avença marcados depois do check-in.
  if (checkin && ((checkin.pro === false && live.pro) || neq(checkin.proClientId, live.proClientId) || neq(checkin.clientPlanId ?? null, extras?.clientPlanId ?? null) || neq(checkin.allowance ?? null, extras?.allowance ?? null))) {
    out.push(finding("pro_late", `No check-in: pro ${checkin.pro ? "sim" : "não"}${checkin.clientPlanId ? `, avença ${checkin.clientPlanId}` : ""}. Agora: pro ${live.pro ? "sim" : "não"}${extras?.clientPlanId ? `, avença ${extras.clientPlanId}` : ""}.`));
  }

  // R17 — valores ou parceiro mudados depois da criação.
  if (first && (neq(first.partnerId, live.partnerId) || moneyNeq(first.partnerAmountDue, live.partnerAmountDue) || moneyNeq(first.partnerContributedAmount, live.partnerContributedAmount) || (first.paymentSource != null && neq(first.paymentSource, live.paymentSource)))) {
    out.push(finding("partner_changed", `Na criação: parceiro ${first.partnerId ?? "—"}, devido ${eurText(first.partnerAmountDue)}, origem ${first.paymentSource ?? "—"}. Agora: parceiro ${live.partnerId ?? "—"}, devido ${eurText(live.partnerAmountDue)}, origem ${live.paymentSource ?? "—"}.`));
  }

  if (extras) {
    // R18 — serviço feito sem linha cobrada.
    if (extras.extras.doneUncharged > 0) out.push(finding("extra_uncharged", `${extras.extras.doneUncharged} serviço(s) marcado(s) como feito(s) sem linha de preço cobrada.`));

    // R19 — paga e entregue sem fatura (passado o prazo), ou fatura ≠ pago.
    const outMs = ms(live.checkOut);
    if (live.status === "CHECKED_OUT" && !live.pro && paid > MONEY_TOLERANCE && Number.isFinite(outMs) && now - outMs > params.invoiceHours * 3_600_000) {
      if (extras.billing.emitted === 0) out.push(finding("invoice_missing", `Saiu há mais de ${params.invoiceHours} h com ${eurText(paid)} pagos e sem fatura emitida.`));
      else if (extras.billing.amount != null && moneyNeq(extras.billing.amount, paid)) out.push(finding("invoice_mismatch", `Faturado ${eurText(extras.billing.amount)}, pago ${eurText(paid)}.`));
    }

    // R20 — disputa, ou link de pagamento falhado numa reserva dada como paga.
    const onlineProblems: string[] = [];
    if (extras.disputed) onlineProblems.push("tem uma disputa do pagamento online");
    if (extras.paymentLinks.failed > 0 && extras.paymentLinks.succeeded === 0 && paid > MONEY_TOLERANCE) onlineProblems.push(`${extras.paymentLinks.failed} link(s) de pagamento falhado(s) ou cancelado(s) e nenhum pago, mas a reserva tem ${eurText(paid)} pagos`);
    if (onlineProblems.length) out.push(finding("online_payment", `A reserva ${onlineProblems.join("; ")}.`));

    // R21 — crédito usado.
    if (extras.creditId || (extras.credit.value ?? 0) > MONEY_TOLERANCE) out.push(finding("credit_used", `Pagou com crédito${extras.credit.value != null ? ` (${eurText(extras.credit.value)})` : ""}.`));

    // R23 — dinheiro recebido há mais de N horas e o condutor ainda não validou.
    const cashAt = ms(extras.cash.firstAt);
    if ((extras.cash.amount ?? 0) > MONEY_TOLERANCE && !live.driverValidated.done && Number.isFinite(cashAt) && now - cashAt > params.driverCashHours * 3_600_000) {
      out.push(finding("driver_cash_pending", `${eurText(extras.cash.amount)} em dinheiro registados há mais de ${params.driverCashHours} h${extras.checkOutDriverName ? ` (saída por ${extras.checkOutDriverName})` : ""} e o condutor ainda não validou a entrega.`));
    }
  }

  // R22 — caixa fechada ou dinheiro conferido que voltou atrás (ou mudou de quem/quando).
  const wasClosed = era.find((x) => x.cashierClosed === true);
  const wasValidated = era.find((x) => x.cashValidated === true);
  const reopened: string[] = [];
  if (wasClosed && !live.cashierClosed.done) reopened.push("a caixa estava fechada e agora está aberta");
  if (wasValidated && !live.cashValidated.done) reopened.push("o dinheiro estava conferido e agora não está");
  const lastClosedAt = [...era].reverse().find((x) => x.cashierClosedAt)?.cashierClosedAt ?? null;
  if (live.cashierClosed.done && lastClosedAt && live.cashierClosed.at && Math.abs(ms(lastClosedAt) - ms(live.cashierClosed.at)) > 60_000) reopened.push("a caixa foi fechada outra vez (hora do fecho mudou)");
  if (reopened.length) out.push(finding("cash_reopened", `${reopened.join("; ")}.`));

  // R28 — vários métodos nos pagamentos (informativa).
  if (live.paymentMethods.length > 1) out.push(finding("split_methods", `Pagamentos em ${live.paymentMethods.join(", ")}.`));

  return out;
}

/** R15: havia retrato nosso e a Multipark já não tem a reserva. PURA. */
export function missingFinding(last: Pick<SweepSnap, "status" | "bookingPrice" | "checkOut">): Finding {
  return finding("missing", `A última vez que a vimos estava ${last.status ?? "?"} (${eurText(last.bookingPrice)}, saída ${lisbonDay(last.checkOut) ?? "—"}); a Multipark já não a devolve.`);
}

/** R26: permissões de dinheiro que um agente ganhou ou perdeu. PURA. */
export function agentPermsFinding(o: { name: string | null; before: readonly string[]; after: readonly string[] }): Finding | null {
  const gained = o.after.filter((p) => !o.before.includes(p));
  const lost = o.before.filter((p) => !o.after.includes(p));
  if (!gained.length && !lost.length) return null;
  return finding("agent_perms_changed", `${o.name ?? "Agente"}: ${gained.length ? `ganhou ${gained.join(", ")}` : ""}${gained.length && lost.length ? "; " : ""}${lost.length ? `perdeu ${lost.join(", ")}` : ""}.`);
}

/** R27: parque nosso com movimento na Multipark e nenhum webhook recebido no período. PURA. */
export function parkSilentFinding(o: { parkName: string | null; moved: number; hours: number }): Finding {
  return finding("park_webhook_silent", `${o.parkName ?? "Parque"}: ${o.moved} reserva(s) alterada(s) na Multipark nas últimas ${o.hours} h e nenhum webhook recebido.`);
}
