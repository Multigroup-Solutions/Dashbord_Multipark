/**
 * Nova Despesa → já paga (Jorge, 14 out 2026): SÓ o admin e o super admin.
 *
 *  - Se escolherem um Método de Pagamento ao lançar, a despesa fica PAGA, com
 *    a data de pagamento = Data de Vencimento (se preenchida) ou, sem ela, a
 *    Data da Despesa.
 *  - Sem método, fica como sempre: pendente (por pagar).
 *  - Para eles o método começa VAZIO ("— sem método —"), para não marcarem
 *    pago sem querer. Para os outros papéis nada muda: o método começa em
 *    "Cartão" e a despesa fica sempre pendente (o servidor ignora o método
 *    para efeitos de pagamento — nunca marca pago por esta via).
 *
 * "Pago" é o mesmo de sempre: `expenses.status = 'paid'` + `expenses.paidAt`
 * (a tabela `expense_payments` não é usada). PURA.
 */

export const EXPENSE_PAYMENT_METHODS = ["cash", "card", "transfer", "check", "other"] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

export const isExpensePaymentMethod = (v: unknown): v is ExpensePaymentMethod =>
  typeof v === "string" && (EXPENSE_PAYMENT_METHODS as readonly string[]).includes(v);

/** Papéis que podem lançar uma despesa já paga (escolhendo o método). */
export const PAID_ON_CREATE_ROLES: readonly string[] = ["admin", "super_admin"];

export function canMarkPaidOnCreate(role: string | null | undefined): boolean {
  return PAID_ON_CREATE_ROLES.includes(String(role ?? ""));
}

/** Método com que o formulário de Nova Despesa abre: vazio para admin+, "Cartão" para os outros (como antes). */
export function defaultCreatePaymentMethod(role: string | null | undefined): "" | ExpensePaymentMethod {
  return canMarkPaidOnCreate(role) ? "" : "card";
}

/** Dia (AAAA-MM-DD) de "AAAA-MM-DD" ou "AAAA-MM-DD HH:mm:ss"; null se vazio/inválido. */
function dayOf(v: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? "").trim());
  return m ? m[1] : null;
}

export type CreatePaymentOutcome =
  | { status: "paid"; paidAt: string }
  | { status: "pending"; paidAt: null };

/**
 * Estado e data de pagamento de uma despesa NOVA.
 * paidAt (AAAA-MM-DD) = vencimento, se houver; senão a data da despesa.
 */
export function paymentOnCreate(o: {
  role: string | null | undefined;
  paymentMethod: string | null | undefined;
  expenseDate: string;
  paymentDueDate?: string | null;
}): CreatePaymentOutcome {
  if (!canMarkPaidOnCreate(o.role) || !isExpensePaymentMethod(o.paymentMethod)) return { status: "pending", paidAt: null };
  const paidAt = dayOf(o.paymentDueDate) ?? dayOf(o.expenseDate);
  if (!paidAt) return { status: "pending", paidAt: null };
  return { status: "paid", paidAt };
}

/** Dia de hoje em Lisboa (AAAA-MM-DD). */
function lisbonDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Pago com data FUTURA (vencimento depois de hoje, em Lisboa)? Ao lançar já
 * paga assim, o servidor só aceita com `confirmFuturePaid: true` (o ecrã mostra
 * um aviso âmbar e pede para confirmar). PURA.
 */
export function isFuturePaidAt(paidAt: string | null | undefined, now: Date = new Date()): boolean {
  const d = dayOf(paidAt);
  return !!d && d > lisbonDay(now);
}

export function futurePaidMessage(paidAt: string): string {
  return `A despesa ia ficar paga com data futura (${paidAt.split("-").reverse().join("/")}). Confirma que é mesmo isso, ou tira o método (fica pendente) ou a data de vencimento.`;
}
