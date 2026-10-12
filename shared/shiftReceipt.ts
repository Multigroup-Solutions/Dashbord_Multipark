/**
 * Despesas do turno com o talão lido pela IA (Jorge, 12 out 2026: "o team
 * leader envia as despesas por aqui e não pelo Financeiro, com as mesmas
 * funcionalidades: tirar fotografia e a IA ler o talão"). Regras PURAS que o
 * cartão da Passagem de turno e o servidor partilham.
 */
import { isIsoDay } from "./expensePeriods";
import { addDays } from "./lisbonDay";

/** O talão pode ser do dia seguinte (turno da noite passa a meia-noite) e até 31 dias antes do turno. */
export const SHIFT_RECEIPT_DAYS_BEFORE = 31;
export const SHIFT_RECEIPT_DAYS_AFTER = 1;

const ptDay = (d: string) => d.split("-").reverse().join("/");

/** Data do talão em relação ao dia do turno: null = ok (ou vazia); senão a mensagem. */
export function shiftReceiptDateProblem(invoiceDate: string | null | undefined, shiftDay: string): string | null {
  const d = String(invoiceDate ?? "").trim();
  if (!d) return null;
  if (!isIsoDay(d)) return "Data do talão inválida (usa AAAA-MM-DD).";
  if (d > addDays(shiftDay, SHIFT_RECEIPT_DAYS_AFTER)) return `A data do talão (${ptDay(d)}) é depois do turno de ${ptDay(shiftDay)} — confirma-a ou apaga-a.`;
  if (d < addDays(shiftDay, -SHIFT_RECEIPT_DAYS_BEFORE)) return `A data do talão (${ptDay(d)}) tem mais de um mês em relação ao turno de ${ptDay(shiftDay)} — confirma-a ou apaga-a.`;
  return null;
}

/** IVA do talão: entre 0 e o total. null = ok (ou vazio). */
export function shiftReceiptVatProblem(vat: number | null | undefined, amount: number): string | null {
  if (vat == null) return null;
  if (!Number.isFinite(vat) || vat < 0) return "IVA inválido.";
  if (vat > amount) return "O IVA não pode ser maior do que o total do talão.";
  return null;
}

/** "2,30" / "2.30 €" → 2.3; vazio → null; inválido → NaN (o cartão avisa). */
export function parseVatInput(raw: string | null | undefined): number | null {
  const s = String(raw ?? "").replace(/[€\s]/g, "").replace(",", ".");
  if (!s) return null;
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : NaN;
}

/** Valor em euros "2,30 €" (para as notas da despesa). */
export function eurText(v: number): string {
  return `${v.toFixed(2).replace(".", ",")} €`;
}
