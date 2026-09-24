/** Leitura de faturas (Despesas) — saída estruturada (schema zod). */
import { z } from "zod";

export const PAYMENT_METHODS = ["cash", "card", "transfer", "check", "other"] as const;

export const invoiceSchema = z.object({
  supplier: z.string().nullable().describe("EMITENTE da fatura (quem vende/presta o serviço, no cabeçalho com o logótipo); nunca o cliente."),
  customerName: z.string().nullable().describe("A quem a fatura é passada."),
  selfInvoice: z.boolean().describe("true se o EMITENTE for uma empresa do grupo (Multipark/Airpark/Skypark/Redpark/Top Parking)."),
  description: z.string().nullable().describe("Descrição curta dos produtos/serviços."),
  amount: z.string().nullable().describe("Valor TOTAL com ponto decimal e sem símbolos, ex.: 45.90"),
  currency: z.string().nullable().describe("Código ISO da moeda, ex.: EUR"),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  expenseDate: z.string().nullable().describe("Data da fatura, YYYY-MM-DD"),
  paymentDueDate: z.string().nullable().describe("Data de vencimento, YYYY-MM-DD"),
  nif: z.string().nullable().describe("NIF do emitente"),
  invoiceNumber: z.string().nullable(),
  suggestedCategory: z.string().nullable().describe("Uma das categorias dadas, ou null."),
});
export type InvoiceExtraction = z.infer<typeof invoiceSchema>;

export const INVOICE_SYSTEM =
  "És um assistente que extrai dados de faturas para o registo de DESPESAS da Multipark (marcas: Multipark, Airpark, Skypark, Redpark, Top Parking). " +
  "Lê o documento com atenção e preenche os campos pedidos. Usa null quando um campo não aparece ou não é legível; não inventes.";

export function invoiceInstruction(categoryNames: string[]): string {
  const cats = categoryNames.length
    ? ` Categorias possíveis para suggestedCategory: ${categoryNames.slice(0, 80).join(", ")}.`
    : " suggestedCategory = null.";
  return `Extrai os dados desta fatura.${cats} Se o emitente for do grupo, selfInvoice = true (é uma fatura nossa a um cliente, não uma despesa).`;
}
