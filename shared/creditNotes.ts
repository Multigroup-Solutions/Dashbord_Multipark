/**
 * Notas de crédito nas Despesas (Jorge, 7 out 2026: "foi paga, mas depois foi
 * devolvida parte das peças e veio uma nota de crédito"). A NC é um documento
 * PRÓPRIO (n.º, data e PDF dela) ligado à fatura (`creditNoteOfId`), gravado
 * com valor NEGATIVO — os totais (lista, Financeiro, Anual, custos) descontam
 * sozinhos no mês da data da NC. A fatura nunca é reescrita. PURAS.
 */
import { parseExpenseAmount } from "./expenseAmount";

export const CREDIT_NOTE_STATES = ["to_receive", "received", "offset"] as const;
export type CreditNoteState = (typeof CREDIT_NOTE_STATES)[number];
export const CREDIT_NOTE_STATE_LABELS: Record<CreditNoteState, string> = {
  to_receive: "Por receber",
  received: "Recebida",
  offset: "Abatida",
};
export const CREDIT_NOTE_STATE_HELP: Record<CreditNoteState, string> = {
  to_receive: "O fornecedor ainda vai devolver o dinheiro.",
  received: "O dinheiro já voltou.",
  offset: "Descontada noutra fatura do mesmo fornecedor.",
};

export const isCreditNote = (e: { creditNoteOfId?: number | null }): boolean => e.creditNoteOfId != null;

const cents = (v: string | number | null | undefined) => Math.round(Number(String(v ?? 0).replace(",", ".")) * 100) || 0;

/** Valor positivo escrito → valor gravado (negativo, "−12.34"), ou null se inválido. */
export function creditNoteStoredAmount(input: string | number | null | undefined): string | null {
  const a = parseExpenseAmount(input);
  return a ? `-${a}` : null;
}

/** Quanto já foi creditado (positivo) a partir das NC ativas (valores gravados negativos). */
export function creditedTotal(credits: ReadonlyArray<{ amount: string | number | null; status?: string | null; deletedAt?: string | null }>): number {
  return credits.filter((c) => c.status !== "cancelled" && !c.deletedAt).reduce((s, c) => s - cents(c.amount), 0) / 100;
}

/**
 * Pode-se lançar (ou mudar para) esta NC nesta fatura? Erro em PT-PT ou null.
 * `otherCredited` = o que as OUTRAS NC já creditaram (sem a que se está a editar).
 */
export function creditNoteError(invoice: { amount: string | number; status: string | null; deletedAt?: string | null; creditNoteOfId?: number | null }, amountPositive: string | null, otherCredited: number): string | null {
  if (isCreditNote(invoice)) return "Uma nota de crédito não leva outra nota de crédito: escolhe a fatura.";
  if (invoice.deletedAt) return "Essa fatura foi eliminada.";
  if (invoice.status === "cancelled") return "Essa fatura está cancelada.";
  if (!amountPositive) return "Valor inválido — usa um número positivo com até 2 casas (ex.: 45,90).";
  const invoiceCents = cents(invoice.amount);
  if (invoiceCents <= 0) return "A fatura não tem valor para creditar.";
  const left = invoiceCents - Math.round(otherCredited * 100);
  if (cents(amountPositive) > left) {
    return `A nota de crédito não pode passar do que falta creditar na fatura (${(Math.max(0, left) / 100).toFixed(2).replace(".", ",")} €).`;
  }
  return null;
}

/** Resumo para a linha da fatura: creditado e líquido. */
export function invoiceNet(invoiceAmount: string | number, credited: number): { credited: number; net: number } {
  return { credited, net: (cents(invoiceAmount) - Math.round(credited * 100)) / 100 };
}
