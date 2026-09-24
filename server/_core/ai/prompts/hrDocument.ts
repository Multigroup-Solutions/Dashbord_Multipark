/** Documentos do RH (CC, residência, carta, IBAN, morada) — saída estruturada. */
import { z } from "zod";

export const hrDocumentSchema = z.object({
  fullName: z.string().nullable(),
  nif: z.string().nullable(),
  birthDate: z.string().nullable().describe("YYYY-MM-DD"),
  nationality: z.string().nullable().describe("Em português, ex.: Portuguesa, Brasileira"),
  address: z.string().nullable().describe("Numa só linha, com código postal e localidade"),
  iban: z.string().nullable(),
  documentNumber: z.string().nullable(),
  expiryDate: z.string().nullable().describe("YYYY-MM-DD"),
});

export const HR_DOCUMENT_SYSTEM =
  "És um assistente de recursos humanos português. Lês o documento em anexo e devolves os campos pedidos. " +
  "Usa null quando um campo não aparece ou não é legível. Não inventes; copia os números tal como aparecem.";

export const HR_DOCUMENT_INSTRUCTION = "Extrai os dados deste documento.";
