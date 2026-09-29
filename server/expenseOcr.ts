/**
 * Leitura de faturas por IA (Despesas → "Extrair com IA"). Saída estruturada
 * validada por zod (sem regex nem "cercas" de markdown); o valor é
 * normalizado para "1234.56". Lança AiError (a UI mostra `userMessage`).
 */
import { AiUnsupportedInputError } from "./_core/ai/errors";
import { INVOICE_SYSTEM, invoiceInstruction, invoiceSchema, type InvoiceExtraction } from "./_core/ai/prompts/invoice";
import { runAi } from "./_core/ai/run";

export const INVOICE_IMAGE_MIME = /^image\/(jpeg|png|webp|gif|heic|heif)$/;

export interface InvoiceData {
  supplier: string | null;
  customerName: string | null;
  selfInvoice: boolean;
  description: string | null;
  amount: string | null;
  currency: string;
  paymentMethod: InvoiceExtraction["paymentMethod"];
  expenseDate: string | null;
  paymentDueDate: string | null;
  nif: string | null;
  invoiceNumber: string | null;
  suggestedCategory: string | null;
}

/** "1.234,56 €" → "1234.56"; inválido → null. PURA. */
export function normalizeAmount(raw: string | null): string | null {
  if (raw == null) return null;
  const v = raw.replace(/[€$£\s]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  return /^\d+(\.\d{1,2})?$/.test(v) ? v : null;
}

/** Normaliza a saída do modelo ("null", "" → null). PURA. */
export function normalizeInvoice(x: InvoiceExtraction): InvoiceData {
  const s = (v: string | null) => (v == null || v === "null" || v === "undefined" || v.trim() === "" ? null : v.trim());
  return {
    supplier: s(x.supplier),
    customerName: s(x.customerName),
    selfInvoice: x.selfInvoice === true,
    description: s(x.description),
    amount: normalizeAmount(s(x.amount)),
    currency: s(x.currency) ?? "EUR",
    paymentMethod: x.paymentMethod ?? null,
    expenseDate: s(x.expenseDate),
    paymentDueDate: s(x.paymentDueDate),
    nif: s(x.nif),
    invoiceNumber: s(x.invoiceNumber),
    suggestedCategory: s(x.suggestedCategory),
  };
}

export async function extractInvoice(opts: { base64: string; mimeType: string; categoryNames: string[]; userId?: number | null }): Promise<InvoiceData> {
  const isPdf = opts.mimeType === "application/pdf";
  if (!isPdf && !INVOICE_IMAGE_MIME.test(opts.mimeType)) throw new AiUnsupportedInputError(opts.mimeType);
  const r = await runAi({
    feature: "expense_ocr",
    // Fotografia de uma fatura: o lite (o mais barato) lê bem. PDF (muitas vezes
    // várias páginas, com os totais na última): o lite troca valores e datas
    // entre páginas → fast. Mudável sem deploy (Definições → ai.featureTiers).
    tier: isPdf ? "fast" : "lite",
    system: INVOICE_SYSTEM,
    input: [
      isPdf ? { type: "pdf", data: opts.base64 } : { type: "image", mimeType: opts.mimeType, data: opts.base64 },
      { type: "text", text: invoiceInstruction(opts.categoryNames) },
    ],
    schema: invoiceSchema,
    maxTokens: 1500,
    timeoutMs: 40_000,
    userId: opts.userId ?? null,
    entity: "expense",
  });
  return normalizeInvoice(r.output);
}
